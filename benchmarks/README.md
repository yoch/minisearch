# Benchmarks — `@yoch/frozenminisearch`

Modular harness under `benchmarks/framework/` with three **profiles**:

| Profile | CLI flag | Purpose |
|---------|----------|---------|
| `vs-reference` | `--profile=vs-reference` | Compare frozen vs MiniSearch (memory, build, search, migrate, drift) |
| `regression` | `--profile=regression` (default) | Full suite vs committed baselines |
| `dev` | `--profile=dev` or `--quick` | Fast search-only smoke (1 run × 10 iterations) |

## Commands

```bash
pnpm bench                              # quick smoke (dev profile, 1 run × 10 iterations)
pnpm bench:run                          # full suite: frozen vs MiniSearch (regression profile)
pnpm bench:record                       # capture benchmarks/baselines/latest.json
pnpm bench:diff                         # diff latest.json vs reference.json (run record first)
pnpm bench:history                      # append perf-history.jsonl
pnpm bench:micro                        # Benchmark.js micro suites (Divina corpus)
pnpm bench:build-peak                   # transient heap peak during FrozenIndexBuilder
pnpm bench:memory                       # isolated heap phase only (protocol v4)
pnpm bench:medicaments-build-peak       # rebuild peak from corpus extracted out of .msbin fixtures
BENCH_GC_AUDIT=1 pnpm bench:build-peak  # same benchmark + trace-gc audit in a child process
```

Profiles and flags go through `cli.mjs` directly (`pnpm bench` / `pnpm bench:*` map to `make` targets and do not forward extra arguments):

```bash
NODE_OPTIONS='--expose-gc' node benchmarks/framework/cli.mjs run --profile=vs-reference
NODE_OPTIONS='--expose-gc' node benchmarks/framework/cli.mjs micro --only=fuzzy,ranking
NODE_OPTIONS='--expose-gc' node benchmarks/framework/cli.mjs micro --list
node benchmarks/scripts/generate-readme-comparison.mjs --from=benchmarks/baselines/latest.json
```

`bench:build-peak` writes `benchmarks/baselines/build-peak-heap.json` (peak vs retained heap, packed term-index share estimate).

`BENCH_GC_AUDIT=1` enables a secondary child-process audit with `--trace-gc-nvp` (fallback `--trace-gc`) on selected memory scripts. The published metrics still come from the normal run; the audit only reports whether unexpected major GC happened inside measured windows.

`bench:medicaments-build-peak` measures `FrozenIndexBuilder` peak on real post-parse JSONL when available (`/home/yoch/fr.gouv.medicaments.rest/data/corpus-export`, override with `CORPUS_EXPORT_DIR`). Documents contain **indexed fields + `id` only** (`buildIndexDocument`). Fallback: invert `.msbin` fixtures (`SOURCE=msbin`). Output: `medicaments-build-peak-heap.json` (jsonl) or `medicaments-build-peak-heap-msbin.json`. Filter: `ONLY=bdpm-presentations`.

**Dev**: prefer `pnpm test` + `ONLY=bdpm-presentations pnpm run bench:medicaments-build-peak`. Reserve `benchmark:diff:run` (full suite, slow) for CI / pre-merge.

`bench:build-heap-profile` — quick add vs freeze profile (real vs synthetic few-terms / 1-field) → `benchmarks/baselines/build-heap-profile.json`.

## Micro-benchmarks (`benchmarks/micro/`)

Fast **ops/sec** probes on the Divine Commedia corpus via [Benchmark.js](https://www.npmjs.com/package/benchmark) — separate from the regression harness (`benchmarkSuite.js`).

| Suite id | What it measures |
|----------|------------------|
| `exact` | `SearchableMap#get` |
| `prefix` | `SearchableMap#atPrefix` |
| `fuzzy` | `SearchableMap#fuzzyGet` (distances 1–4) |
| `combined` | `MiniSearch#search` fuzzy + prefix |
| `ranking` | `MiniSearch#search` with prefix |
| `filter` | `MiniSearch#search` with filter |
| `autosuggest` | `MiniSearch#autoSuggest` |

Corpus fixture: `benchmarks/divinaCommedia.js` (MiniSearch, upstream `SearchableMap`). Suite modules live alongside under `benchmarks/*.js`; registry in `benchmarks/micro/registry.mjs`.

### Search timing protocol (v2)

- Calibration: `pnpm benchmark:calibrate-batches` → `searchBenchBatches.json` (target **3 ms** per sample, batch up to **256**)
- Runtime: **paired** samples (mutable block then frozen block per iteration), `process.hrtime.bigint()`
- Iterations: **20** default, **50** when probe p50 &lt; 0.1 ms
- Scenario runs: default captures request 3 runs, but very expensive calibrated search scenarios are capped automatically (logged and stored as `benchmarkRuns`); use `BENCH_NO_RUN_CAPS=1` or `--no-run-caps` for decisive full repeats.
- Sub-0.1 ms baselines: report **µs** deltas in `compare.js` (not misleading %)
- Recalibrate after corpus/query changes; diff warns on Node / minisearch version mismatch (non-blocking)

## Surfaces

Activate with `--surfaces=build,search,save,load,memory,migrate,drift` or `all`.

| Surface | Measures |
|---------|----------|
| `build` | `fromDocuments` / MiniSearch snapshot conversion vs mutable `addAll` |
| `search` | Paired mutable/frozen `search()` timing (`hrtime`, see `searchBenchBatches.json`) |
| `search-levels` | L0 lookup / L1 `executeQuery` / L2 `search` decomposition |
| `save` / `load` | binary snapshot round-trip |
| `memory` | Retained RAM (protocol **v4**: `totalResidentApprox` = heapUsed + external on both sides; isolated scenario process, in-process trials, median+MAD) + internal memory breakdown |
| `migrate` | MiniSearch `toJSON` + internal snapshot import (`toJSONMs` + `freezeMs`) |
| `drift` | Score drift vs reference (`toBeCloseTo` tolerance) |

## Core modules

| Module | Role |
|--------|------|
| `benchmarks/framework/cli.mjs` | Unified CLI (`run`, `record`, `diff`, `history`) — sets `BENCH_SURFACES` |
| `benchmarks/framework/surfaces.mjs` | Surface list + defaults per profile |
| `benchmarks/benchmarkSuite.js` | Core scenarios (shared by compare/capture) |

Legacy `benchmarks/index.js` orchestrator was replaced by `pnpm bench:micro`.

## Heap protocol v4

CPU/search benchmarks and retained-RAM measurement run in **separate processes**:

1. `captureBaseline.js` runs the CPU suite (`memory` / `breakdown` surfaces stripped).
2. `runHeapSuite.mjs` spawns one Node process per allowlisted scenario (`benchmarks/framework/heapScenarios.mjs`).
3. Each scenario process warms up twice per path (memory-only; not search JIT warmup), then runs in-process trials: GC×3 → allocate one index → GC×3 → delta on **heapUsed + external** (`totalResidentApprox`, median+MAD).

Primary comparison metric: `frozenVsMutableSavingPct` on **totalResident** (both sides). `heapMb.mutable` / `heapMb.frozen` remain as heap-only detail; `frozenVsMutableHeapOnlySavingPct` is diagnostic.

Env overrides: `BENCH_HEAP_TRIALS`, `BENCH_HEAP_SCENARIOS`, `BENCH_HEAP_PATHS`, `BENCH_HEAP_GC_PASSES`, `BENCH_HEAP_WARMUP`.

Optional Chrome validation: `node --expose-gc benchmarks/scripts/heap-snapshot-pair.mjs --scenario=divina-indexOnly`.

## Baselines

Committed reference: `benchmarks/baselines/reference.json` (search protocol **v2**, heap protocol **v4**).

```bash
pnpm bench:reference:update   # RUNS=3 vs-reference → reference.json + VS_REFERENCE.md + README pointer
pnpm bench:readme             # regenerate benchmarks/VS_REFERENCE.md + README pointer from reference.json
node benchmarks/scripts/generate-readme-comparison.mjs --from=benchmarks/baselines/latest.json
```

Public comparison output: [`benchmarks/VS_REFERENCE.md`](VS_REFERENCE.md) (detailed tables for all scenarios). The root [`README.md`](../README.md) keeps the hero summary table between `<!-- vs-reference:* -->` markers.

Legacy `pnpm benchmark:baseline:update` was removed; use `pnpm bench:reference:update`.
