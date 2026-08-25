# JavaScript engine benchmark

This directory is an **opt-in, engine-neutral benchmark** for the FrozenMiniSearch core. It is intentionally separate from the normal benchmark baselines: it does not update `benchmarks/baselines/`, does not run in the regression profile, and does not affect package builds.

The goal is to compare JavaScript engines rather than runtimes. The generated benchmark is one self-contained IIFE whose measured path uses only ECMAScript primitives: no Node/Bun APIs, filesystem, compression, or browser services are invoked. It uses the real FrozenMiniSearch build/query modules through a tiny benchmark-only assembly adapter, so the search algorithm is not copied.

## What it measures

A deterministic 4,096-document synthetic corpus is generated before timing. The suite reports median latency for:

- frozen index build
- exact search
- prefix search
- fuzzy search
- multi-term `AND`
- ranking/materialization
- mixed prefix + fuzzy `AND`

Search workloads are warmed up and batch-calibrated to about 60 ms/sample. Build uses five single-build samples after two warmups. Result fingerprints and corpus/term counts are compared across engines so a faster but semantically divergent engine is not silently accepted.

Memory is deliberately **not** reported: bare JS engines do not expose a comparable heap metric, and process RSS would mix VM startup/reservations with the index. Use a separate OS-level protocol if memory is the question.

## Build

Install the repository dev dependencies, then:

```bash
node benchmarks/engines/build.mjs
```

The generated file is written under the already-ignored `benchmarks/tmp/` tree:

```text
benchmarks/tmp/engines/frozen-engine-bench.js
```

`build.mjs` also rejects bundles that retain obvious runtime-specific dependencies such as `node:` imports, `Buffer`, `process`, `TextEncoder`, `CompressionStream`, or `Response`.

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

Missing optional engines are skipped. A present engine that fails to execute the bundle is reported without hiding successful engines. Cross-engine result fingerprint mismatches make the runner exit with status 2.

## Interpreting results

The table prints median time and throughput relative to Node (`>1x` is faster than Node). Treat the numbers as a comparison of the **JS engine on this FrozenMiniSearch workload**, not as a general Node-vs-Bun runtime benchmark: file I/O, HTTP, package loading, compression, startup, and runtime APIs are outside the measured region.

For stable comparisons, pin CPU frequency/governor where possible, avoid mixed system load, and compare multiple complete runs. Engine/JIT changes can affect individual workloads differently, so the per-workload profile is more useful than a single aggregate score.
