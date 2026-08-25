# JavaScript engine benchmark

This directory is an **opt-in, engine-neutral benchmark** for the FrozenMiniSearch core. It is intentionally separate from the normal benchmark baselines: it does not update `benchmarks/baselines/`, does not run in the regression profile, and does not affect package builds.

The goal is to compare JavaScript engines rather than runtimes. The generated benchmark profiles are self-contained IIFEs whose measured paths use only ECMAScript primitives: no Node/Bun APIs, filesystem, compression, or browser services are invoked. They use the real FrozenMiniSearch build/query modules through tiny benchmark-only assembly adapters, so the search algorithm is not copied.

## Profiles

### `core`

A deterministic 4,096-document corpus exercises frozen index build, exact search, prefix search, fuzzy search, multi-term `AND`, ranking/materialization and mixed prefix + fuzzy `AND`.

### `bdpm-shaped`

A deterministic consumer-shaped workload derived from `yoch/fr.gouv.medicaments.rest` keeps three index families at the documented consumer counts: 15,848 specialities, 20,905 presentations and 32,389 compositions. It mirrors the consumer's field/boost/query shapes and adds app-like ranking, merge/dedup and related-record hydration.

### `resident-pressure`

A high-residency workload keeps 11 synthetic corpus/index families, key maps and non-indexed payload data resident at consumer-like row counts while searching the three user-facing families. It is designed to expose working-set, GC and allocator behavior; it is not a copy of the government corpus.

Each profile runs in a **fresh engine process**, so allocator/GC state from one profile cannot contaminate another. Search workloads are warmed up and batch-calibrated. Result fingerprints and corpus/term counts are compared across engines so a faster but semantically divergent engine is not silently accepted.

## Memory

When GNU `/usr/bin/time -v` is available, the runner measures **whole-process peak RSS externally** for each isolated profile. This avoids comparing incompatible runtime-specific heap metrics. Set `FMS_REQUIRE_RSS=1` to make absence of GNU time a failure; the CI smoke does this.

Treat RSS as profile/process memory, not as an engine heap-size metric: VM startup/reservations, native allocator state, typed-array backing memory and benchmark corpus residency all contribute.

## Build and run

```bash
node benchmarks/engines/build.mjs
node benchmarks/engines/run.mjs
```

Generated files are written under the already-ignored `benchmarks/tmp/` tree. `build.mjs` rejects bundles that retain obvious runtime-specific dependencies such as `node:` imports, `Buffer`, `process`, `TextEncoder`, `CompressionStream`, or `Response`.

The runner always uses the current Node executable as the reference and auto-discovers optional Bun/JSC, d8, jsc and qjs commands. SpiderMonkey is opt-in through `FMS_ENGINE_SM` because the common `js` executable is ambiguous on many systems.

## Interpreting results

The timing tables print median time and throughput relative to Node (`>1x` is faster than Node). The RSS table prints peak resident memory relative to Node (`<1x` is lower than Node).

Treat the numbers as a comparison of the **JS engine on these FrozenMiniSearch workloads**, not as a general Node-vs-Bun runtime benchmark: file I/O, HTTP, package loading, compression, startup, CSV/XML parsing, PM2 and long-lived server behavior are outside the measured region.

The CI smoke currently pins **Node 26.7.0** and tracks the **Bun canary** channel; every run prints Bun's exact revision. The canary observed on 2026-08-25 was `1.4.1-canary.1+11fb73032`. Stable Bun 1.4.0 was also tested separately. Both stable and canary show the same qualitative resident-pressure behavior: Bun remains faster on simple resident searches, while the multi-term workload reverses in favor of Node and Bun's peak RSS rises above Node's under high residency.

For stable comparisons, pin CPU frequency/governor where possible, avoid mixed system load, and compare multiple complete runs. Hosted-runner absolute timings and RSS vary, so ratios within one run and repeated qualitative direction are more informative than cross-run absolutes.
