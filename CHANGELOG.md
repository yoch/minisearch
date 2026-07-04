# Changelog

## Unreleased

## v1.8.0 — `@yoch/frozenminisearch`

Minor release: faster MiniSearch JSON import, tighter snapshot validation at the import boundary, and internal query-engine cleanup. No public API or MSv5 wire-format changes.

### Improved

- **MiniSearch JSON import** — faster trusted-snapshot index accumulation (~14–22% lower freeze import on large corpora in paired benchmarks); separate v1/v2 accumulation paths avoid per-field serialization-version checks on the hot path.
- **Query execution** — leaner AND/AND_NOT gating, combination resolution, and doc-id collection on hot paths; frozen search semantics unchanged.

### Changed

- **Snapshot validation** — shared canonical integer-key checks for import and index accumulation; reject leading-zero object keys (e.g. `"01"`) consistently at the import boundary.
- **Published bundles** — drop freeze profiler hooks from shipped `dist/*` bundles (profiling remains in dev/benchmark scripts only).
- **Benchmark docs** — full performance comparison table lives in `benchmarks/VS_REFERENCE.md`; root README links to it.
- **Benchmark internals** — source-based benchmark probes import FrozenMiniSearch internals through `benchmarks/harness/frozenSourceInternals.ts`, with `assert-internal-boundary.cjs` guarding against new direct `benchmarks/ → src/internal` imports.
- **Benchmark runner** — simplify `benchmarkUtils.js` / `benchmarkSuite.js` by dropping unused utility exports and centralizing optional-surface aggregation.
- **Test/bench memory breakdown** — move the retained-structure estimator out of `src/internal/frozenInternals.ts` into `testSupport/`, sharing one implementation across source and dist benchmark harnesses.
- **Test import helpers** — move MiniSearch snapshot assembly helpers out of `src/internal/frozenInternals.ts` into `testSupport/`.
- **Benchmark metadata** — stop emitting redundant `benchProfile` in new captures; benchmark mode is now derived from `benchSurfaces`, while diff tooling still reads legacy baselines.

### Removed

- **PackedRadix dev helper** — move the `packedPrefixEntries` string iterator out of `src/` into `testSupport/packedRadixStringIterators.js`, keeping parity/bench coverage without carrying a dev-only helper in the product tree.

## v1.7.0 — `@yoch/frozenminisearch`

Minor release: lower retained memory for postings metadata in frozen indexes and on the MSv5 wire. Reading older u32 metadata snapshots remains supported; newly written compact snapshots require 1.7.0+.

### Improved

- **Postings metadata** — store dense/sparse offset, length, and term-start columns at adaptive u8/u16/u32 widths in memory instead of always using u32.
- **MSv5 binary snapshots** — write those metadata columns at their native packed width on disk and load them back with zero-copy views. Legacy snapshots that stored metadata as u32 remain readable.

## v1.6.4 — `@yoch/frozenminisearch`

Patch release: faster frozen builds and prefix/fuzzy search, with lower build-time scratch memory on common corpora. No public API, search semantics, or MSv5 wire-format changes.

### Improved

- **FrozenIndexBuilder** — skip the duplicate-id `Set` while numeric document ids stay dense (`id === shortId`); lazy backfill when a non-dense id appears.
- **IncrementalPostingsAccumulator** — adaptive build scratch columns (doc ids start `Uint16Array`, promote to `Uint32Array` past 65535; freqs start `Uint8Array`, promote to `Uint16Array` past 255).
- **Term index packing** — pack term lists from sorted terms instead of incremental scratch insertion; faster builds on large sparse vocabularies.
- **Search** — route prefix/fuzzy match iteration through visitors to avoid per-match ref allocations on hot query paths.

### Fixed

- **Term index packing** — finalize sorted-topology packs through `finalizePackedRadixScratch` so `fromDocuments` retained heap matches the pre-direct-pack profile (identical MSv5 snapshots).

## v1.6.3 — `@yoch/frozenminisearch`

Patch release: drop in-tree legacy MiniSearch internals, trim unused public TypeScript surface (`logger`), and simplify frozen/query/MSv5 internals. No search semantics or MSv5 wire-format changes. Removing `logger` is a type-surface cleanup only — the hook was never invoked at runtime.

### Changed

- **Internal** — split query gating and term-ref resolution out of `queryEngine.ts`; consolidate MSv5 compression/container helpers; simplify frozen core load paths.
- **Bench diagnostics** — internal/benchmark memory breakdown now names the packed term structure `termIndex` instead of the legacy `radixTree` label. Generated baselines must be refreshed to pick up the renamed payload keys.

### Removed

- **Legacy MiniSearch internals** — remove the in-tree `SearchableMap` fork, the mutable-radix bridge (`radixTree.ts`, `PackedRadixTree/fromRadixTree.ts`), and packed snapshot fallbacks based on `treeShape` / `termTree`. Tests and parity benches now use upstream `minisearch/SearchableMap` through the local `testSupport` adapter only.
- **`logger` / `LogLevel`** — remove from the public TypeScript API. The diagnostics hook was a no-op and was never called; failures are reported via thrown errors.
- **Unused dev dependency** — drop `fast-check` from the root workspace; it was no longer imported anywhere in the main repo.

## v1.6.2 — `@yoch/frozenminisearch`

Patch release: lower post-freeze memory for `FrozenIndexBuilder`, internal stored-fields wire cleanup, and expanded CI coverage. No public API, search semantics, or MSv5 wire-format changes.

### Improved

- **FrozenIndexBuilder** — release incremental postings scratch state after `freeze`, so large builds do not retain slot buffers once the frozen index is assembled.

### Changed

- **CI** — run browser smoke tests as part of `make coverage` (after the bundle check) instead of a separate redundant workflow step.
- **Internal** — consolidate duplicated stored-fields wire parsing into `readStoredFieldsRowsSection` in `storedFieldsWire.ts`; drop unused `isDocActive` scoring hooks (discarded documents are already filtered at freeze time).

### Removed

- **Internal dead code** — remove the unused query-time `isDocActive` scoring path and related postings metadata.

## v1.6.1 — `@yoch/frozenminisearch`

Patch release: internal dead-code cleanup and stricter published-bundle guards. No public API, search semantics, or MSv5 wire-format changes.

### Changed

- **Published bundles** — enable Terser `dead_code` and extend `assert-public-bundles.cjs` so dev-only PackedRadix string helpers (`packedPrefixEntries`, legacy wrapper names) cannot ship in `dist/es`, `dist/cjs`, or `dist/browser`.
- **CI** — add a `knip` check (Node 22.x) to catch orphan exports in `src/`.

### Removed

- **Internal dead code** — drop unused radix helpers, legacy postings materialize path (`materializeFrozenPostings` / `buildFrozenPostingsLayout`), `flatPostings`, and deprecated PackedRadix fuzzy string wrappers (`fuzzyEntries` / `packedRadixFuzzyEntries`). Prefix string iteration for benches/parity moves to `devStringIterators.ts` (not on the product import graph).

## v1.6.0 — `@yoch/frozenminisearch`

Minor release: lower FrozenIndexBuilder build peak (postings scratch + flat term dedup), unified `fromJSON` / document term packing, and packed-only `saveBinary` bundles without legacy Map-radix fallbacks.

### Improved

- **FrozenIndexBuilder build peak** — replace per-slot `SlotRanges` JS metadata in `IncrementalPostingsAccumulator` with a typed `slotIds` column and stable counting-sort finalize; lowers transient heap during `add` on vocabulary-rich corpora without changing frozen postings layout or wire format. Build-peak benchmarks now also report `peakTotalResidentMb` (heapUsed + external).
- **FrozenIndexBuilder term index** — `add` now dedupes terms through a flat `Map<string, number>` and the packed radix is built once at `freeze` via `packTermsFromList` (the same path `fromMiniSearch` already uses), instead of maintaining a nested-`Map` radix throughout `add`. Cuts both build-peak memory (−7% to −45% across benchmark scenarios) and build CPU (−13% to −40%), and makes the build-peak deterministic on large vocabularies. The frozen index is logically identical (same search/get/prefix/fuzzy results, loads back identically); the only change is the term-tree node ordering in the emitted bytes (creation order vs prior DFS order), so a `saveBinary` blob built from the same input differs byte-for-byte from previous versions while remaining fully loadable.
- **MiniSearch JSON import** — `fromJSON` now builds its term index via the same `packTermsFromList` primitive as the document build (instead of an inline radix scratch), unifying the two paths and shrinking the internal API surface (`createPackedRadixScratch`/`insertPackedRadixTerm` are no longer exported). Product `saveBinary` uses a packed-only encode path that no longer pulls legacy Map-radix fallbacks into published bundles; `scripts/assert-public-bundles.cjs` guards `dist/es`, `dist/cjs`, and `dist/browser` after build.

### Changed

- **CI** — main workflow now runs lint, build, browser smoke, and coverage on Node `20.x`, `22.x`, and `24.x`, matching the `engines.node >=20` promise. `verify-npm-pack.cjs` runs after build to block dev-only paths from the published tarball.
- **Tooling** — pin `packageManager` to pnpm 10.34.4 so local/CI installs work on Node 20 (pnpm 11 requires Node 22.13+). zstd-specific tests remain gated on runtime support (Node 22.15+).

### Removed

- **Breaking** — removed the legacy `fromJson` static alias; use `fromJSON` for MiniSearch JSON migration.
- **Legacy MiniSearch options** — removed the unused `autoVacuum` option and vacuum option types from the frozen TypeScript API. The `logger` diagnostics hook remains available.

## v1.5.0 — `@yoch/frozenminisearch`

Minor release: faster MiniSearch JSON import and MSv5 binary I/O, adaptive field-length wire encoding, and `fromJSON` as the canonical migration API.

### Added

- **`fromJSON`** — canonical static import for MiniSearch wire snapshots (`serializationVersion: 2`), symmetric with `toJSON()`.

### Deprecated

- **`fromJson`** — use `fromJSON` instead; alias scheduled for removal in the next major release.

### Changed

- **Term index build path** — frozen index construction (`fromJSON`, `FrozenIndexBuilder`) builds a numeric `RadixTree` via `radixTree.ts` helpers instead of routing through `SearchableMap`; packing lives in `PackedRadixTree/fromRadixTree.ts` with `validateRadixLeaves` at finalize.
- **MSv5 field-length wire width** — save snapshots with the narrowest unsigned width per matrix (u8/u16/u32) instead of always widening to u32; load preserves the on-wire width in memory. Existing snapshots remain readable.
- **MSv5 raw save path** — single payload allocation for `compression: 'raw'`, incremental payload CRC during section writes, and preallocated columnar term-tree sections (no intermediate `concatBytes` padding chunks).
- **Heap benchmark protocol v4** — primary RAM comparison uses `totalResidentApprox` (heapUsed + external on both mutable and frozen sides). Heap-only savings remain as `frozenVsMutableHeapOnlySavingPct` for diagnostics. Memory warmup reduced to 2 passes (was up to 100 for small corpora). Heap allowlist expanded to 12 scenarios. See `benchmarks/README.md`.

### Improved

- **MiniSearch JSON import (`fromJSON`)** — stream postings through `IncrementalPostingsAccumulator` during parse (no nested `Map` postings or double-pass materialization); typical freeze import **~20–60% faster** on large corpora with lower transient memory.
- **MSv5 `saveBinary` / `loadBinary`** — fewer copies on raw and compressed paths; codec-aware buffer ownership on load. Measured save/load **~25–50% faster** on dense 100k scenarios vs v1.4.0 baseline.

### Fixed

- **`fromJSON` snapshot validation** — reject malformed MiniSearch JSON snapshots with non-integer or out-of-range field/doc ids, malformed index entries, or duplicate terms instead of silently producing corrupt hits.

## v1.4.0 — `@yoch/frozenminisearch`

Minor release: trimmed public API, hosted browser demo, `getDefault`, and production browser bundle minification.

### Added

- **Hosted browser demo** — `examples/plain_js_frozen/` is published to GitHub Pages at `/demo/` (`pnpm build-demo`).
- **`FrozenMiniSearch.getDefault`** — expose built-in `tokenize`, `processTerm`, `extractField`, and related indexing defaults (MiniSearch-compatible helper).

### Changed

- **Heap benchmark protocol v3** — retained-heap measurement runs in isolated scenario processes with in-process trials (warm-up once per path, median+MAD, GC×3). CPU/search benchmarks are decoupled from the heap phase (`pnpm bench:memory`). See `benchmarks/README.md`.
- **Public API cleanup** — `assembleFrozen`, `frozenMemoryBreakdown`, `memoryBreakdown()`, `fromMiniSearch`, `fromMiniSearchSnapshot`, and low-level finalize/suggest helpers are no longer part of the public API; use `FrozenMiniSearch.fromDocuments`, `fromJson`, `buildFrozenFromDocuments`, `freezeFrozenIndexBuilder`, and the instance `search` / `autoSuggest` methods instead. Retained-heap diagnostics and MiniSearch snapshot conversion helpers remain available only to internal benchmarks/tests.
- **Documentation** — French documentation, comments, and console messages translated to English.

### Improved

- **Browser bundle** — production `dist/browser/index.js` is minified via Rollup/Terser property mangling; redundant `build-minified` Make target removed.

### Removed

- **Breaking** — package exports removed: `finalizeRawSearchResults`, `finalizeSearchResults`, `suggestFromRawResults`, `suggestFromSearchResults`, `assembleFrozen`, `frozenMemoryBreakdown`, `fromMiniSearch`, `fromMiniSearchSnapshot`, and related internal types (`SerializedIndexEntry`, `MiniSearchSnapshot`, `FrozenAssembleParams`, `FrozenMemoryBreakdown`). Use `fromJson` for MiniSearch JSON migration.

## v1.3.0 — `@yoch/frozenminisearch`

Minor release: browser entry (`@yoch/frozenminisearch/browser`), portable default compression (`auto` → zlib), async browser MSv5 binary snapshots, Node ↔ browser zlib interoperability, and indexing parity fixes for custom tokenizers.

### Added

- **Browser entry** — `@yoch/frozenminisearch/browser` for read-only search and index build in the browser (`fromDocuments`, `fromJson`, `search`, `autoSuggest`, incremental builder).
- **Browser binary I/O** — `saveBinaryAsync` / `loadBinaryAsync` on `Uint8Array` (`raw`, `zlib`, `auto`). No sync binary APIs and no zstd in the browser build.
- **Wire portability layer** — `binaryBytes`, `binaryWireIo`, `fieldLengthMatrixWire`, and browser compression via native `CompressionStream` / `DecompressionStream`.
- **Indexing parity gate** — `dev/parity/indexing-parity.test.js` compares `MiniSearch.addAll` vs `FrozenMiniSearch.fromDocuments` (index fingerprint + scores) across default, camelCase, `processTerm`, `stringifyField`, and Vocs-style profiles; builder, `fromJson`, and binary round-trips included.

### Fixed

- **Custom tokenizer indexing** — `isDefaultTokenize` now requires reference equality with the default tokenizer; split-equivalent wrappers no longer take the default fast path (fixes missing camelCase terms such as `create` from `createUser`).
- **Field length with `processTerm`** — `fromDocuments` counts unique raw tokens per field (MiniSearch semantics) instead of distinct indexed terms after filtering.

### Changed

- **`compression: 'auto'`** — always tries zlib (then raw if it does not shrink). zstd remains opt-in via `compression: 'zstd'` on Node 22.15+; existing zstd snapshots still load on Node.

### Improved

- **CI** — cross-runtime smoke tests: Node zlib save → browser load and browser zlib save → Node load.
- **Browser bundle size** — production `dist/browser/index.js` is ~67.6 KB raw and ~20.9 KB gzip (native compression streams, no `fflate`).
- **`stringifyField` fast path** — skip redundant `toString()` when the field value is already a string and the default stringifier is in use.

## v1.2.4 — `@yoch/frozenminisearch`

Patch release: faster frozen search and autoSuggest finalization, simplified AND gate heuristics, and small public exports for advanced callers. No MSv5 wire-format changes.

### Added

- **Public finalize/suggest helpers** — export `finalizeRawSearchResults`, `finalizeSearchResults`, `suggestFromRawResults`, and `suggestFromSearchResults` from the package entry.

### Improved

- **Tied-score finalization** — skip result sorting when every hit shares the same final score (search and suggestions).
- **Frozen search finalize** — copy stored fields in place via `assignStoredFields` (no per-document row allocation for single-column layouts).
- **AutoSuggest without `filter`** — aggregate suggestions from raw query hits instead of materializing full `SearchResult` objects.
- **AND gate heuristics** — pass selective gates as `allowedDocs` consistently; keep prefix/fuzzy on sequential gating via a cheap two-phase posting estimator.
- **CPU-only benchmarks** — `benchmark:finalize` and `benchmark:autosuggest` scripts; clearer reporting when benchmark payloads omit structural metrics.

## v1.2.3 — `@yoch/frozenminisearch`

Patch release: broad-first exact AND / AND_NOT paths, seek-based gated doc-id collection, and README benchmark copy refresh. No API or MSv5 wire-format changes.

### Improved

- **Broad-first exact AND** — on exact-only combined queries where the first branch posting is large and a later branch is selective enough, collect the final doc-id gate by estimated posting length, then score branches in query order (parity with naive score-then-intersect unchanged).
- **Broad-first AND_NOT** — when the positive branch is large and a negated branch is comparably large, collect exclusions first and score the positive branch only on survivors.
- **Gated doc-id collection** — `DocIdGate` lazy views and seek over sorted postings when the gate is much smaller than the posting list (`scoring.ts`, `frozenPostings.ts`).
- **AND gate posting estimate** — skip upfront posting-length estimation on prefix/fuzzy AND branches; keep absolute-gate skip on the sequential path so Divina `AND+fuzzy` stays fast.

## v1.2.2 — `@yoch/frozenminisearch`

Patch release: faster frozen AND scoring on large posting lists (gated seek + posting-ratio gate) and BM25 segment hoisting. No API or MSv5 wire-format changes.

### Improved

- **AND gate posting-ratio** — when the absolute gate cap would disable filtering, pass `allowedDocs` to later AND branches if the gate is small relative to the branch posting length (calibrated: min length 2048, max 25% of posting). Applies to string AND and nested `QueryCombination` AND. Parity with naive score-then-intersect unchanged.
- **Gated posting seek** — on selective AND paths, score gated segments with binary search by doc id instead of scanning full sorted posting lists (same numeric thresholds as the ratio gate; distinct decision point).
- **BM25 IDF hoisting** — compute document-frequency IDF once per posting segment on frozen paths when doc activity filtering is inactive; lowers work on high-frequency AND queries.
- **Posting layout selection** — cost-based choice between dense and sparse frozen posting layouts from field/term statistics at build time.

## v1.2.1 — `@yoch/frozenminisearch`

Patch release: lower search overhead when stored fields are disabled and fewer query-normalization allocations. No API or MSv5 wire-format changes.

### Improved

- **Search without `storeFields`** — skip stored-field reads during scoring and result finalization when the index has no stored fields (`storeFields: []`).
- **String query normalization** — pre-allocated term/spec buffers, hoisted per-query field boosts and match weights, and shared `termToQuerySpec` building (fewer intermediate arrays and closures).

## v1.2.0 — `@yoch/frozenminisearch`

Minor release: configurable MSv5 snapshot compression and Node 20 support.

### Added

- **`SaveBinaryOptions`** — `saveBinarySync()` / `saveBinaryAsync()` accept `{ compression: 'auto' | 'raw' | 'zstd' | 'zlib' }`.
- **`CODEC_ZLIB`** — portable deflate snapshots readable on Node 20+; explicit `compression: 'zlib'` always writes zlib on disk.
- **Exported types** — `BinaryCompression`, `SaveBinaryOptions`.

### Improved

- **`compression: 'auto'`** — one compression pass: zstd when available (Node 22.15+), otherwise zlib on Node 20–22.14, otherwise raw when compression does not strictly shrink the payload (including payloads under 64 B).
- **Node engine** — `>=20` (was `>=22.15`); zstd remains available on Node 22.15+ and is required to read zstd snapshots.

## v1.1.0 — `@yoch/frozenminisearch`

Minor release: MiniSearch JSON wire export and clearer JSON import API. MSv5 binary format unchanged.

### Added

- **`toJSON()`** — export MiniSearch wire snapshots (`serializationVersion: 2`); import via `fromJson` / `fromMiniSearchSnapshot`. Production persistence remains `saveBinarySync`.

### Breaking

- **`fromMiniSearchJson` → `fromJson`** — rename for clearer semantics (JSON import vs binary load). Update call sites: `FrozenMiniSearch.fromMiniSearchJson(json)` → `FrozenMiniSearch.fromJson(json)`.

## v1.0.2 — `@yoch/frozenminisearch`

Patch release: lower retained heap when `storeFields` has one field. No API or MSv5 wire-format changes.

### Improved

- **Single-field `storeFields` at rest** — values live in a dense column instead of one `Record` per document (~75% less retained heap on Divina with `storeFields: ['txt']`; ~1.0 → ~0.3 MB).
- **Binary save/load** — encode and decode skip intermediate row arrays when the in-memory layout or load `storeFields` hint allows direct wire paths (same bytes on disk).
- **Posting slice lookups** — scoring flyweight reuses a scratch buffer instead of allocating `{ offset, length }` per lookup.

## v1.0.1 — `@yoch/frozenminisearch`

Patch release: lower build-time peak memory and migration ergonomics. No API or wire-format changes.

### Improved

- **`FrozenIndexBuilder` peak heap** — incremental typed-array posting accumulators replace per-term `number[][]` scratch; token and term-frequency buffers are reused across `add()` calls.
- **Default tokenization during build** — single-pass field scan when the default splitter is in use (`collectFieldTermFreqsFromFieldInto`).

### Fixed

- **Default tokenizer parity** — leading delimiter produces an empty token (e.g. `::a` → `["", "a"]`), matching MiniSearch `split` behaviour.
- **Named export** — `FrozenMiniSearch` is exported again alongside the default export (ESM and CJS).

## v1.0.0 — `@yoch/frozenminisearch`

First stable release on npm. Frozen-only read-only search for Node.js.

### Breaking

- **Binary snapshots** — `loadBinarySync` / `loadBinaryAsync` read only the current frozen binary format; re-build from MiniSearch JSON if an older snapshot fails to load.
- **Removed `saveBinary()` / `loadBinary()`** — use `saveBinarySync` / `saveBinaryAsync` and `loadBinarySync` / `loadBinaryAsync`.

## v1.0.0-beta.0 — `@yoch/frozenminisearch`

New standalone package (frozen-only) for read-only serving workloads.

### Added

- **`FrozenMiniSearch`** as the default export — `fromDocuments`, builder, `saveBinarySync` / `loadBinarySync`
- **Migration loaders** — `fromMiniSearch`, `fromJson`, `fromMiniSearchSnapshot` (MiniSearch JSON wire format)
- **Modular benchmarks** — `pnpm bench` with profiles `vs-reference`, `regression`, `dev`
- **Parity suite** — `dev/parity/` vs `minisearch` npm (functional invariants)

### Removed from published API

- Mutable `MiniSearch` class and `freeze()` on the fork
- `freezeFromMiniSearch` (use `fromJson`)
- Read-only mutation stubs (`add`, `remove`, …)

### Migration

- `new MiniSearch(opts).addAll(docs)` → `FrozenMiniSearch.fromDocuments(docs, opts)` or `fromMiniSearch(mutable, opts)` — see README
