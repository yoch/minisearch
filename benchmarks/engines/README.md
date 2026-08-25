# JavaScript engine benchmark

This directory is an **opt-in benchmark lab** for the FrozenMiniSearch core. It is intentionally separate from the normal benchmark baselines: it does not update `benchmarks/baselines/`, does not run in the regression profile, and does not affect package builds.

The measured bundles use only ECMAScript primitives: no Node/Bun APIs, filesystem, compression, or browser services are invoked from the benchmark code. They use the real FrozenMiniSearch build/query/scoring modules through benchmark-only assembly adapters, so the search algorithm is not copied.

## Profiles

Each profile is bundled and executed in a **fresh engine process**. This prevents a previous profile's GC/allocator state from contaminating latency or RSS measurements.

### `core`

A deterministic 4,096-document micro-profile covering:

- frozen index build
- exact search
- prefix search
- fuzzy search
- multi-term `AND`
- ranking/materialization
- mixed prefix + fuzzy `AND`

This is the closest profile to a direct V8/JSC/other-engine comparison of FrozenMiniSearch itself.

### `bdpm-shaped`

A deterministic consumer-shaped profile derived from the public architecture of `yoch/fr.gouv.medicaments.rest` (snapshot 2026-08):

- 15,848 specialities
- 20,905 presentations
- 32,389 compositions
- three independent FrozenMiniSearch indexes
- matching field/boost shapes
- NFD accent normalization
- `AND`, conditional prefix and fuzzy search
- application-like post-ranking, CIS merge/dedup and related-record hydration

It is intentionally **shape-realistic, not corpus-realistic**: no government dataset is copied into this repository.

### `resident-pressure`

A pressure profile for the main remaining hypothesis from the real consumer: the search indexes do not live alone. It keeps the documented BDPM index families plus veterinary data resident at the same time while searching the three user-facing indexes.

The profile keeps reachable:

- 11 synthetic corpora at the documented row counts
- 11 FrozenMiniSearch indexes
- per-corpus key `Map`s
- non-indexed payload strings representing the application corpus retained beside the indexes

This profile is not intended as an exact memory model of the API. Its purpose is to reveal whether engine rankings change when the working set, GC pressure and cache footprint are much closer to a multi-index service than to a single-index microbenchmark.

## Timing protocol

Search workloads are warmed up and batch-calibrated before taking medians. Result fingerprints and corpus/term counts are compared across engines so a faster but semantically divergent engine is not silently accepted.

Timings are measured **inside** each JS process, so process startup is excluded from latency numbers.

## OS peak RSS

When GNU `/usr/bin/time -v` is available, the runner wraps each isolated profile process and reports **Maximum resident set size** in KiB/MiB. This is intentionally an OS-level metric rather than `heapUsed`, JSC heap statistics, or runtime-specific allocator counters, because those are not comparable across engines.

Peak RSS still includes VM startup, code/JIT pages and allocator reservations. Interpret it as **whole-process memory cost for the same isolated profile**, not as the exact byte size of the FrozenMiniSearch index.

To require RSS measurement (useful in CI):

```bash
FMS_REQUIRE_RSS=1 node benchmarks/engines/run.mjs
```

Override the GNU time binary with `FMS_GNU_TIME` if needed.

## Build

Install the repository dev dependencies, then:

```bash
node benchmarks/engines/build.mjs
```

Generated files live under the already-ignored `benchmarks/tmp/engines/` tree. The build creates one bundle per profile plus a combined convenience bundle.

`build.mjs` rejects bundles that retain obvious runtime-specific dependencies such as `node:` imports, `Buffer`, `process`, `TextEncoder`, `CompressionStream`, or `Response`.

## Run

```bash
node benchmarks/engines/run.mjs
```

The runner always uses the current Node executable as the reference and auto-discovers these optional commands when present:

| Engine | Default command | Override |
| --- | --- | --- |
| V8 via Node | current `node` | `FMS_ENGINE_NODE` |
| JavaScriptCore via Bun | `bun` | `FMS_ENGINE_BUN` |
| standalone V8 | `d8` | `FMS_ENGINE_D8` |
| standalone JavaScriptCore | `jsc` | `FMS_ENGINE_JSC` |
| QuickJS | `qjs` | `FMS_ENGINE_QJS` |

SpiderMonkey is intentionally not auto-discovered because the common `js` command is also used by unrelated runtimes on some systems. Set it explicitly:

```bash
FMS_ENGINE_SM=/path/to/js node benchmarks/engines/run.mjs
```

Missing optional engines are skipped. A present engine that fails to execute a profile is reported without hiding successful engines. Cross-engine result fingerprint mismatches make the runner exit with status 2.

## Interpreting results

Timing tables print median time and throughput relative to Node (`>1x` means faster than Node). The RSS table prints process memory relative to Node (`>1x` means **more** memory than Node, so lower is better).

Use the profiles to separate questions:

- `core`: how the JS engine executes FrozenMiniSearch hot paths
- `bdpm-shaped`: whether realistic index/query/application shape changes that ranking
- `resident-pressure`: whether a larger simultaneous working set changes it
- real consumer benchmark: whether CSV/XML parsing, Express/HTTP, PM2, actual lexical distribution, long-lived GC and the complete application reverse it

The last question still belongs in the consumer repository. This harness deliberately stops before pretending synthetic data is a substitute for the real corpus.

For stable comparisons, pin CPU frequency/governor where possible, avoid mixed system load, and compare multiple complete runs. Engine/JIT changes can affect individual workloads differently, so the per-workload profile is more useful than a single aggregate score.
