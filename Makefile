# FrozenMiniSearch — task runner
#
# Centralizes prerequisites (build, --expose-gc, NODE_ENV, PACKED_RADIX_BENCH)
# that package.json scripts used to prefix by hand. The pnpm scripts are thin
# aliases to the targets below.
#
# Usage:
#   make build                # full build (clean + rollup + postbuild)
#   make bench                # cli.mjs run --profile=dev
#   make bench-record         # cli.mjs record
#   make bench-diff           # cli.mjs diff
#   make test-browser         # assert-browser-bundle + vitest dev/browser/
#   make docs-build           # typedoc + demo
#
# Business flags (RUNS, SEARCH_ITERATIONS, BENCH_WARMUP, BENCH_SEARCH_ONLY)
# can still be passed on the CLI: make bench-record RUNS=1 SEARCH_ITERATIONS=10

NODE := node
EXPOSE := --expose-gc
PNPM := pnpm
# devDeps live in node_modules/.bin/ and are reached via pnpm exec (make does
# not inherit pnpm's augmented PATH).
RUN := $(PNPM) exec
BENCH_TSX := $(PNPM) exec tsx --expose-gc
BENCH_TIMING_ARGS := $(if $(RUNS),--runs=$(RUNS)) $(if $(BENCH_WARMUP),--warmup=$(BENCH_WARMUP)) $(if $(SEARCH_ITERATIONS),--iterations=$(SEARCH_ITERATIONS))

# Build freshness marker. Targets that consume dist/ depend on this real file.
# The dependency list below makes make rebuild whenever any source or build
# config changes, not only when the marker is missing.
#
# Benchmark targets that consume dist/ use the phony `build` target instead:
# dist/ is untracked, so a clean git tree can still benchmark stale bundles
# after a checkout or branch switch when mtimes make the marker look "fresh".
DIST_MARKER := dist/es/index.js

# Sources consumed by rollup when building dist/ (see rollup.config.js:
# entries src/index.ts and src/browser.ts, plus their transitive imports).
BUILD_SOURCES := $(wildcard src/*.ts src/*.js src/**/*.ts src/**/*.js) rollup.config.js tsconfig.json package.json

# Sources consumed by the packed-radix bench build (entries under benchmarks/,
# plus src/**/*.ts via plugin-typescript include).
PACKED_SOURCES := $(wildcard benchmarks/packedRadix*.js) $(wildcard src/*.ts src/*.js src/**/*.ts src/**/*.js) rollup.config.js tsconfig.json

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------

.PHONY: clean-build build build-packed-radix-bench
clean-build:
	rm -rf dist

build: clean-build
	NODE_ENV=production $(RUN) rollup -c
	node scripts/postbuild-cjs.cjs
	node scripts/assert-public-bundles.cjs

# Specialised build for PackedRadixTree benchmarks (rollup in bench mode).
# Produces benchmarks/dist/packedRadix*.cjs, NOT dist/.
.PHONY: build-packed-radix-bench
build-packed-radix-bench:
	PACKED_RADIX_BENCH=true NODE_ENV=production $(RUN) rollup -c

# Real file used as a build freshness marker.
# Rebuilt automatically when any source or build config changes. Use
# "make build" for a guaranteed clean rebuild.
$(DIST_MARKER): $(BUILD_SOURCES)
	rm -rf dist
	NODE_ENV=production $(RUN) rollup -c
	node scripts/postbuild-cjs.cjs
	node scripts/assert-public-bundles.cjs

# Marker for the packed-radix bench build.
benchmarks/dist/packedRadixTree.cjs: $(PACKED_SOURCES)
	PACKED_RADIX_BENCH=true NODE_ENV=production $(RUN) rollup -c

# ----------------------------------------------------------------------------
# Tests
# ----------------------------------------------------------------------------

.PHONY: test test-watch test-browser test-fuzzysearch test-benchmarks coverage
test:
	$(RUN) vitest run src/ dev/parity/

test-watch:
	$(RUN) vitest src/ dev/parity/

test-browser: $(DIST_MARKER)
	node scripts/assert-browser-bundle.cjs
	$(RUN) vitest run dev/browser/

test-fuzzysearch:
	$(RUN) vitest run dev/internal/

test-benchmarks:
	$(RUN) vitest run benchmarks/

coverage: $(DIST_MARKER)
	node scripts/assert-browser-bundle.cjs
	$(RUN) vitest run --coverage src/ dev/parity/ dev/browser/

# ----------------------------------------------------------------------------
# Lint
# ----------------------------------------------------------------------------

.PHONY: lint lint-fix typecheck knip
lint: typecheck
	$(RUN) eslint 'src/**/*.{js,ts}'
	node scripts/assert-internal-boundary.cjs

knip:
	$(RUN) knip

# Typecheck uses the TypeScript 7 native CLI (`typescript-7` → `.bin/tsc`).
# Rollup, TypeDoc, ESLint/typescript-eslint, and knip keep using the TypeScript 6
# programmatic API via the `typescript` package alias (`@typescript/typescript6`).
# After TypeScript 7.1 ships a stable API and tooling adopts it, unify on typescript@7.
typecheck:
	$(RUN) tsc --noEmit

lint-fix:
	$(RUN) eslint --fix 'src/**/*.{js,ts}'

# ----------------------------------------------------------------------------
# Benchmarks — profiled interface (via benchmarks/framework/cli.mjs)
# ----------------------------------------------------------------------------

BENCH_CLI := benchmarks/framework/cli.mjs

.PHONY: bench bench-run bench-record bench-memory bench-diff bench-history bench-micro bench-readme
bench: build
	$(NODE) $(EXPOSE) $(BENCH_CLI) run --profile=dev --quick

bench-run: build
	$(NODE) $(EXPOSE) $(BENCH_CLI) run

bench-record: build
	$(NODE) $(EXPOSE) $(BENCH_CLI) record

bench-memory: build
	$(NODE) $(EXPOSE) benchmarks/framework/runHeapSuite.mjs

bench-diff:
	$(NODE) $(EXPOSE) $(BENCH_CLI) diff

bench-history:
	$(NODE) $(EXPOSE) $(BENCH_CLI) history

bench-micro: build
	$(NODE) $(EXPOSE) $(BENCH_CLI) micro

bench-readme:
	node benchmarks/scripts/generate-readme-comparison.mjs

# ----------------------------------------------------------------------------
# Benchmarks — heap/build peak (dedicated scripts)
# ----------------------------------------------------------------------------

.PHONY: bench-build-peak bench-medicaments-build-peak bench-build-heap-profile
bench-build-peak: build
	$(NODE) $(EXPOSE) benchmarks/scripts/build-peak-heap.mjs

bench-medicaments-build-peak: build
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/scripts/medicaments-build-peak-heap.mjs

bench-build-heap-profile: build
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/scripts/build-heap-profile.mjs

# ----------------------------------------------------------------------------
# Benchmarks — reference update (full reference refresh workflow)
# ----------------------------------------------------------------------------

.PHONY: bench-reference-update
bench-reference-update: build
	RUNS=3 $(NODE) $(EXPOSE) $(BENCH_CLI) record --profile=vs-reference
	node benchmarks/scripts/promote-latest-to-reference.mjs
	$(MAKE) bench-readme

# ----------------------------------------------------------------------------
# Benchmarks — low-level expert interface (direct access to *.js)
# ----------------------------------------------------------------------------
# These targets coexist on purpose with the profiled interface above.
# See benchmarks/SCRIPTS.md for the boundary.

.PHONY: benchmark-compare benchmark-record benchmark-diff
benchmark-compare: build
	$(BENCH_TSX) benchmarks/compare.js

benchmark-record: build
	$(BENCH_TSX) benchmarks/captureBaseline.js

benchmark-diff:
	$(NODE) $(EXPOSE) benchmarks/diffBaseline.js

# Variants of diffBaseline.js
.PHONY: benchmark-diff-run benchmark-diff-search-run
benchmark-diff-run: build
	$(BENCH_TSX) benchmarks/captureBaseline.js
	$(NODE) $(EXPOSE) benchmarks/diffBaseline.js

benchmark-diff-search-run: build
	BENCH_SEARCH_ONLY=1 $(BENCH_TSX) benchmarks/captureBaseline.js
	BENCH_SEARCH_ONLY=1 $(NODE) $(EXPOSE) benchmarks/diffBaseline.js

# Tuning / calibration workflows
.PHONY: benchmark-calibrate-batches benchmark-validate-freq-adaptive benchmark-and-gate-tuning
.PHONY: benchmark-gate-posting-ratio benchmark-targeted benchmark-profile-giant-prefix
.PHONY: benchmark-measure-scoring-steps benchmark-finalize benchmark-autosuggest
benchmark-calibrate-batches: build
	$(NODE) $(EXPOSE) benchmarks/scripts/calibrate-search-batches.mjs

benchmark-validate-freq-adaptive: build
	RUNS=1 SEARCH_ITERATIONS=10 BENCH_WARMUP=15 $(NODE) $(EXPOSE) benchmarks/scripts/freq-adaptive-validate.mjs

benchmark-and-gate-tuning: build
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/and-gate-tuning.mjs

benchmark-gate-posting-ratio: build
	$(PNPM) exec tsx benchmarks/scripts/calibrate-gate-posting-ratio.mjs

benchmark-targeted: build
	$(NODE) $(EXPOSE) benchmarks/scripts/targeted-failures.mjs

benchmark-profile-giant-prefix: build
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/scripts/profile-giant-prefix.mjs

benchmark-measure-scoring-steps: build
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/scripts/measure-scoring-steps.mjs

benchmark-finalize:
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/scripts/finalize-search.mjs $(BENCH_TIMING_ARGS)

benchmark-autosuggest:
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/scripts/autosuggest-search.mjs $(BENCH_TIMING_ARGS)

# History analysis (read-only, no build required)
.PHONY: benchmark-history-analyze benchmark-history-vs-mutable
benchmark-history-analyze:
	node benchmarks/scripts/analyze-history.mjs

benchmark-history-vs-mutable:
	node benchmarks/scripts/analyze-history.mjs --vs-mutable

# Targeted compare requires the build because it imports benchmarkSuite.js -> dist/
.PHONY: benchmark-targeted-compare
benchmark-targeted-compare: build
	node benchmarks/scripts/targeted-failures.mjs --compare

# ----------------------------------------------------------------------------
# Benchmarks — PackedRadixTree subsystem (orthogonal, dedicated rollup build)
# ----------------------------------------------------------------------------

.PHONY: benchmark-packed-radix benchmark-packed-emit benchmark-packed-emit-baseline
.PHONY: benchmark-packed-fuzzy benchmark-packed-fuzzy-sweep benchmark-packed-radix-record
.PHONY: benchmark-packed-radix-diff benchmark-packed-radix-diff-run benchmark-packed-radix-history
benchmark-packed-radix: benchmarks/dist/packedRadixTree.cjs
	$(NODE) $(EXPOSE) benchmarks/dist/packedRadixTree.cjs

benchmark-packed-emit: benchmarks/dist/packedRadixTree.cjs
	$(NODE) $(EXPOSE) benchmarks/dist/packedRadixEmitSubtree.cjs

benchmark-packed-emit-baseline: benchmarks/dist/packedRadixTree.cjs
	$(NODE) $(EXPOSE) benchmarks/dist/packedRadixEmitSubtree.cjs --baseline

benchmark-packed-fuzzy: benchmarks/dist/packedRadixTree.cjs
	$(NODE) $(EXPOSE) benchmarks/dist/packedRadixFuzzy.cjs

benchmark-packed-fuzzy-sweep: benchmarks/dist/packedRadixTree.cjs
	$(NODE) $(EXPOSE) benchmarks/dist/packedRadixFuzzySweep.cjs

benchmark-packed-radix-record: benchmarks/dist/packedRadixTree.cjs
	$(NODE) $(EXPOSE) benchmarks/dist/packedRadixTree.cjs --reference

benchmark-packed-radix-diff:
	node benchmarks/diffPackedRadixBaseline.js

benchmark-packed-radix-diff-run:
	node benchmarks/diffPackedRadixBaseline.js --run

benchmark-packed-radix-history:
	node benchmarks/scripts/analyze-packed-radix-history.mjs

# ----------------------------------------------------------------------------
# Benchmarks — other orthogonal concerns
# ----------------------------------------------------------------------------

.PHONY: benchmark-binary-format benchmark-medicaments-indexes
benchmark-binary-format: build
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/binaryFormatCompare.ts

benchmark-medicaments-indexes:
	NODE_OPTIONS='--expose-gc' $(PNPM) exec tsx benchmarks/analyzeMedicamentsIndexes.js

# ----------------------------------------------------------------------------
# Documentation & demos
# ----------------------------------------------------------------------------

.PHONY: docs-build docs-build-pages docs-demo docs-demo-frozen docs-sync-media
docs-build:
	node scripts/build-docs.cjs

docs-build-pages:
	DOCS_PAGES=1 node scripts/build-docs.cjs

docs-demo: $(DIST_MARKER)
	node scripts/build-demo.cjs

docs-demo-frozen: $(DIST_MARKER)
	node scripts/prepare-frozen-demo.cjs

docs-sync-media:
	node scripts/sync-docs-media.cjs

# ----------------------------------------------------------------------------
# Release
# ----------------------------------------------------------------------------

.PHONY: prepublish-only release-beta release-stable
prepublish-only:
	$(RUN) vitest run
	$(MAKE) build
	node scripts/assert-public-bundles.cjs
	node scripts/verify-npm-pack.cjs

release-beta:
	node scripts/publish-beta.cjs

release-stable:
	node scripts/publish-stable.cjs

# ----------------------------------------------------------------------------
# Help
# ----------------------------------------------------------------------------

.PHONY: help
help:
	@echo "FrozenMiniSearch — common Make targets"
	@echo ""
	@echo "Build:"
	@echo "  make build                  full build (clean + rollup + postbuild)"
	@echo "  make build-packed-radix-bench  PackedRadixTree specialised build"
	@echo ""
	@echo "Tests:"
	@echo "  make test                   vitest run (src + dev + benchmarks)"
	@echo "  make test-browser           assert-browser-bundle + vitest dev/browser/"
	@echo "  make test-fuzzysearch       vitest run dev/internal/"
	@echo "  make coverage               build + browser bundle check + vitest --coverage (src, parity, browser)"
	@echo ""
	@echo "Benchmarks (profiled interface, via cli.mjs):"
	@echo "  make bench                  run --profile=dev --quick"
	@echo "  make bench-record           record (default profile)"
	@echo "  make bench-diff             diff (latest vs reference)"
	@echo "  make bench-reference-update full reference refresh workflow"
	@echo ""
	@echo "Benchmarks (expert interface, direct access to *.js):"
	@echo "  make benchmark-compare      compare.js (mutable vs frozen)"
	@echo "  make benchmark-record       captureBaseline.js"
	@echo "  make benchmark-diff         diffBaseline.js"
	@echo ""
	@echo "Lint:"
	@echo "  make lint                   eslint + tsc --noEmit (src/)"
	@echo "  make typecheck              tsc (TypeScript 7) --noEmit only"
	@echo "  make docs-build             typedoc + demo"
	@echo "  make docs-build-pages       typedoc GitHub Pages mode"
	@echo ""
	@echo "See benchmarks/SCRIPTS.md for the bench:* vs benchmark:* boundary."
