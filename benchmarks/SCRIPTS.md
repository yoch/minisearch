# Benchmark scripts — boundaries and environment variables

This document describes the two families of benchmark scripts exposed via
`package.json` (thin aliases to the root `Makefile`) and the environment
variables that drive them.

## Two interfaces coexist on purpose

| Family | Interface | Status | Typical usage |
|---|---|---|---|
| `bench:*` | `benchmarks/framework/cli.mjs` (profiles `dev` / `regression` / `vs-reference`) | Profiled | CI, regression checks, daily use |
| `benchmark:*` | direct `*.js` (`captureBaseline.js`, `diffBaseline.js`, `compare.js`) | Low-level expert | Debug, ad-hoc runs, flag access without going through `cli.mjs` |
| `benchmark:packed-radix*` | `packedRadix*.js` + dedicated rollup build (`PACKED_RADIX_BENCH=true`) | Orthogonal | Isolated PackedRadixTree subsystem |
| `benchmark:binary-format` | `binaryFormatCompare.ts` | Orthogonal | msv5 binary format vs JS comparison |
| `benchmark:medicaments-indexes` | `analyzeMedicamentsIndexes.js` | Orthogonal | Dedicated medicaments corpus |
| `benchmark:profile-giant-prefix` / `benchmark:measure-scoring-steps` | `benchmarks/scripts/*.mjs` via `tsx` | Internal pipeline | Ad-hoc AND/prefix scoring probes that use `benchmarks/harness/frozenSourceInternals.ts` |

`cli.mjs` is **not** a rewrite of the legacy scripts: it is a profile-based
orchestration layer that delegates to them systematically:

- `cli.mjs run` → `benchmarks/compare.js`
- `cli.mjs record` → `benchmarks/captureBaseline.js`
- `cli.mjs diff` → optionally runs `captureBaseline.js`, then `diffBaseline.js`
- `cli.mjs micro` → `benchmarks/micro/run.mjs`
- `cli.mjs history` → `benchmarks/scripts/record-history.mjs`

## `bench:*` vs `benchmark:*` correspondences

The pairs below run **the same underlying script**; the difference is that
`bench:*` selects a profile/surface set through `cli.mjs`, while `benchmark:*`
lets the user provide their own environment variables directly.

| `bench:*` (profiled) | `benchmark:*` (expert) | Underlying script | Difference |
|---|---|---|---|
| `bench` | `benchmark:compare` | `compare.js` | `bench` forces `RUNS=1 SEARCH_ITERATIONS=10 BENCH_WARMUP=20` (`dev` profile) |
| `bench:record` | `benchmark:record` | `captureBaseline.js` | `bench:record` uses profile-derived surfaces |
| `bench:diff` | `benchmark:diff` | `diffBaseline.js` | `cli.mjs diff --run` captures a fresh `latest.json` before comparing |
| `bench:memory` | `make bench-memory` | `runHeapSuite.mjs` | isolated heap phase |

## Recommended workflows

### Reference refresh (full workflow)

```bash
# Recommended: profiled interface
make bench-reference-update
# equivalent to:
#   RUNS=3 cli.mjs record --profile=vs-reference
#   promote-latest-to-reference.mjs
#   generate-readme-comparison.mjs
```

`benchmark:baseline:update` was removed; prefer `bench:reference:update`,
which also chains promotion and README regeneration.

### CI regression check

```bash
make bench-record                # default profile (regression)
make bench-diff                  # latest.json vs reference.json
```

### Ad-hoc debug without profile

```bash
make benchmark-compare           # compare.js with no imposed env vars
make benchmark-record RUNS=1 SEARCH_ITERATIONS=10
```

The internal CPU pipeline microbenchmarks exposed through Makefile targets use
the same timing variables:

```bash
make benchmark-finalize RUNS=5 BENCH_WARMUP=20 SEARCH_ITERATIONS=50
make benchmark-autosuggest RUNS=5 BENCH_WARMUP=20 SEARCH_ITERATIONS=50
```

## Environment variables

### Set by the Makefile (do not override unless needed)

| Variable | Value | Affected targets |
|---|---|---|
| `NODE_ENV` | `production` | `build`, `build-packed-radix-bench` |
| `PACKED_RADIX_BENCH` | `true` | `build-packed-radix-bench` |
| `--expose-gc` | node flag | all `bench-*` / `benchmark-*` targets (except read-only analysis) |

### Set by `cli.mjs` (profiled interface)

| Variable | Values | Role |
|---|---|---|
| `BENCH_PROFILE` | `dev` \| `regression` \| `vs-reference` | Selected profile |
| `BENCH_SURFACES` | `search,build,heap` (subset) | Surfaces to run |
| `BENCH_USE_REFERENCE` | `1` | Set in `vs-reference` profile |

### Passed by the user (legitimate variability)

| Variable | Default | Role |
|---|---|---|
| `RUNS` | `3` | Number of capture runs |
| `SEARCH_ITERATIONS` | (internal default) | Search iterations per run |
| `BENCH_WARMUP` | (internal default) | Warmup iterations |
| `BENCH_SEARCH_ONLY` | `1` | Skip non-search scenarios |

Example:

```bash
make benchmark-record RUNS=1 SEARCH_ITERATIONS=10 BENCH_WARMUP=20
# former `benchmark:record:quick`

make benchmark-record BENCH_SEARCH_ONLY=1
# former `benchmark:record:search`
```

### Documentation / demo

| Variable | Role |
|---|---|
| `DOCS_PAGES` | `1` = GitHub Pages mode (basePath, hostedBaseUrl) |
| `DOCS_VERSION` | Semver version for the TypeDoc title (default: `package.json#version`) |

## Build prerequisites

The `Makefile` declares native dependencies:

- **`dist/es/index.js`** (real file, freshness marker) — consumed by browser
  tests and docs/demo targets. Make rebuilds automatically when any
  `src/**/*.ts`/`src/**/*.js` source or build config (`rollup.config.js`,
  `tsconfig.json`, `package.json`) changes.
- **`build`** (PHONY, clean rebuild) — used by Makefile benchmark targets that
  read `dist/es/` or `dist/browser/`. This avoids benchmark captures from a
  stale untracked `dist/` after checkout or branch switches.
- **`benchmarks/dist/packedRadixTree.cjs`** (real file marker) — consumed only
  by `benchmark-packed-*` targets; produces `benchmarks/dist/packedRadix*.cjs`
  and not `dist/`.

For a guaranteed clean rebuild: `make build` (PHONY, cleans `dist/` first).

## Source vs bundled imports

Most low-level benchmark scripts load the published Node bundle from `dist/es/`
so they measure the public package surface. Their Makefile targets run a clean
`make build` first. `tsx` remains appropriate for ad-hoc probes that need source
internals, but those probes must import them through
`benchmarks/harness/frozenSourceInternals.ts`; they are diagnostics, not the
primary baseline source. A few probes are hybrid (`dist/es` for the public
constructor, harnessed `src/` internals for decomposition), so their Makefile
targets also rebuild first. For direct invocation of scripts that import
`dist/es/`, use the same contract:

```bash
pnpm build
NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-giant-prefix.mjs
NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/measure-scoring-steps.mjs
```

## See also

- [`benchmarks/scripts/README.md`](scripts/README.md) — Performance history
  tracking (`perf-history.jsonl`, `record-history.sh`, `analyze-history.sh`).
- [`Makefile`](../Makefile) — Available targets (`make help` for a summary).
