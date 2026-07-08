# Design Document

This design document explains the architecture of `FrozenMiniSearch` to library
developers who want to contribute to the project, or who are simply curious
about the internals.

It focuses on the current package as it exists today: a compact, read-only
search engine for fixed corpora, with query semantics intentionally aligned
with [`MiniSearch`](https://github.com/lucaong/minisearch).

The project originally grew out of a need for a module that was less memory
hungry than `MiniSearch`, especially when indexing significant amounts of
text. That requirement still shapes the design today, alongside two related
optimization axes: fast loading from persisted snapshots, and fast query
execution over a frozen representation.

**Latest update: July 8, 2026**

## Goals (and non-goals)

`FrozenMiniSearch` is designed for the common production setup where documents
are indexed ahead of time, then queried many times without in-process updates.
Typical examples are a documentation search box, a product catalog shipped to
the browser, or an index loaded by many read-only Node.js processes.

It is therefore optimized for:

  1. Small memory footprint of the resident index
  2. Fast loading from persisted snapshots
  3. Fast query execution over immutable data
  4. Query behavior aligned with `MiniSearch`
  5. A small API surface built around read-only serving workflows
  6. Straightforward interchange with `MiniSearch` JSON snapshots and frozen
     binary snapshots

These goals imply a deliberate trade-off: `FrozenMiniSearch` is not a mutable
index. It gives up `add`, `remove`, `discard`, and `vacuum` on the serving
instance so that the index can be stored in a denser and more cache-friendly
representation.

`FrozenMiniSearch` is therefore NOT directly aimed at offering:

  - In-process incremental mutation of a live search index after construction
  - Distributed indexing workflows or multi-writer synchronization
  - Opinionated language tooling such as built-in stemming, stop-word lists, or
    locale-specific analyzers
  - A general-purpose mutable search data structure API comparable to
    `MiniSearch.SearchableMap`

The project does provide an incremental builder for ingestion, but that builder
is a construction tool. Once finalized, the resulting `FrozenMiniSearch`
instance is immutable. That boundary is central to the design.

## Search semantics

Although the storage layer is different, `FrozenMiniSearch` intentionally keeps
the search model familiar. Exact match, prefix search, fuzzy search, result
scoring, query combinations, filters, boosts, wildcard queries, and
auto-suggestions follow the same broad rules as `MiniSearch`.

That compatibility is a design constraint. It gives users a known search model
while the frozen runtime changes how the index is built, stored, loaded, and
queried.

### Term lookup model

The indexed vocabulary is organized as a radix tree. A radix tree is a prefix
tree where chains of nodes with no siblings are merged into larger
multi-character labels. This representation is a good fit for local full-text
search because:

  - Common prefixes are stored only once
  - Exact lookup is proportional to term length
  - Prefix lookups naturally traverse a subtree
  - Fuzzy search can reuse partial work while traversing the tree

Historically, `MiniSearch` served this role with `SearchableMap`, a string-keyed
map-like radix tree. `FrozenMiniSearch` preserves the same logical lookup
model, but stores the tree in a packed immutable representation that is purpose
built for frozen indexes.

The upstream `minisearch/SearchableMap` implementation now appears only in
tests, parity checks, and benchmark oracles through `testSupport`. It is not an
in-tree runtime dependency, and the former bridge through a mutable radix
structure has been removed from the product graph.

### Fuzzy search rationale

Fuzzy search is based on Levenshtein edit distance, using a tree traversal that
reuses dynamic-programming state across related prefixes. The important design
point is the trade-off:

  - Full-text fuzzy search usually operates with small edit distances
  - Small edit distances are computationally affordable on top of a radix tree
  - More specialized fuzzy indexes often use more memory, which conflicts with
    the primary goal of compact local indexes

The trade-off is deliberate: spend some computation to avoid larger auxiliary
structures.

### Scoring model

Search result scoring follows BM25-style relevance ranking, with the same main
inputs as `MiniSearch`:

  - Term frequency in a document field
  - Document frequency of the term
  - Total indexed document count
  - Field length for the matching document
  - Average field length across the corpus

The practical consequence is that `FrozenMiniSearch` is not trying to invent a
new ranking model. The storage layer changes; the search semantics are meant to
stay familiar.

## Search layer and parity strategy

The main architectural choice behind `FrozenMiniSearch` is that search
semantics are kept separate from the low-level storage layout. Query parsing,
term expansion, BM25 scoring, result aggregation, and suggestion logic are
factored through abstractions that operate on a frozen query view rather than
on any particular wire or in-memory representation.

This separation is what makes parity maintainable. The compact storage layer is
free to evolve, while the semantic contract remains anchored to a stable query
and scoring model.

### Query abstractions

The main interfaces are intentionally narrow:

  - A `QueryIndexView`, which exposes exact, prefix, and fuzzy term lookup, plus
    iteration over live documents
  - A posting accessor layer (`FieldTermDataLike` / `PostingListLike`), which
    answers "for this term and field, which postings exist?"

Within `FrozenMiniSearch`, those abstractions are implemented over packed radix
lookups and typed-array posting segments. The scoring code only consumes the
semantic view of a term, field, and posting list, which keeps the runtime model
decoupled from storage details.

This trade-off favors correctness over overly specialized query code. Keeping
search semantics concentrated in one place reduces the chance of accidental
drift from the reference behavior.

### Frozen-specific query optimizations

The frozen runtime adds some storage-aware execution optimizations for combined
queries, especially `AND` and `AND_NOT`. These include doc-id gates,
broad-first exact branches, short-circuits for empty gates, and direct doc-id
collection from flat posting segments.

These optimizations are designed to preserve the same final scores and results
as the logical query plan. They are part of the broader CPU-optimization story
for the package: the aim is to keep queries fast while still using a compact
frozen representation.

They are intentionally treated as an optimization layer, not as part of the
public search contract. The exact heuristics are internal and may evolve; the
main design invariant is that query semantics stay stable.

### Parity coverage

Parity is checked at several levels:

  - Native indexing parity compares `MiniSearch.addAll` with
    `FrozenMiniSearch.fromDocuments`
  - JSON migration parity checks `MiniSearch.toJSON()` snapshots imported
    through `FrozenMiniSearch.fromJSON`
  - Packed radix parity checks exact, prefix, and fuzzy traversal against
    upstream `SearchableMap`
  - Browser smoke tests cover search, auto-suggest, and binary snapshots on the
    browser entry point

The important boundary is that parity helpers live outside the product runtime.
They are allowed to inspect internals so the shipped package does not have to
carry development-only adapters or string iterators.

## Frozen index architecture

This is the core of the project. `FrozenMiniSearch` keeps the same conceptual
inverted index model as `MiniSearch`, but stores it in a representation
optimized for read-only serving.

At the logical level, the inverted index still has the familiar shape:

```
term -> field -> document -> term frequency
```

Frozen indexes store that information in a compact, immutable layout that is
much friendlier to memory usage and sequential scans than a graph of small
objects and maps would be.

### Packed term index

The term dictionary is still a radix tree, but frozen indexes use
`PackedRadixTree`, an internal module built on typed arrays and shared string
storage.

Its role is to provide:

  - Exact lookup by term
  - Prefix traversal
  - Fuzzy traversal
  - Stable leaf semantics for result parity

Instead of storing postings directly at leaves, the packed tree stores a small
numeric term index. That term index is then used to address the posting layout.

This separation matters. The radix tree answers "which term matched?" while the
posting storage answers "where are this term's postings?"

Current construction paths build the packed term index directly from term
lists. The builder deduplicates terms with a flat `Map<string, number>`, then
uses `packTermsFromList` at freeze time. JSON import uses the same packing
primitive. This keeps document builds and MiniSearch snapshot imports aligned,
and avoids carrying mutable radix fallbacks in product bundles.

### Flat postings

Postings are stored as global typed-array columns shared by the entire index:

  - One global column for document ids
  - One global column for term frequencies
  - Metadata columns that locate each posting-list segment

At runtime, a posting list is therefore just an `(offset, length)` window into
contiguous arrays. No per-list object graph needs to be allocated in order to
iterate through the postings.

This layout is possible precisely because the index is immutable. Posting lists
never need to grow in place, shrink, or keep insertion-friendly slack. Once the
build is complete, the final arrays can be packed tightly.

### Dense and sparse field layouts

The posting metadata uses two layouts depending on field count and sparsity.

For compact field structures, the layout can be dense: each `(term, field)` slot
has a direct offset and length entry. This is fast and can be smaller when the
matrix is naturally dense.

For wider or sparse field structures, most `(term, field)` combinations are
empty. A fully dense `term x field` matrix would waste space, so frozen indexes
store only the non-empty field segments for each term, together with a short
per-term range into that sparse metadata.

The caller does not choose between these layouts. The representation is selected
automatically from the field structure and non-empty slot count of the index.

### Adaptive numeric widths

The frozen representation saves further space by adapting element widths to the
actual corpus:

  - Document ids use `Uint16` up to 65535 documents, otherwise `Uint32`
  - Term frequencies use `Uint8` or `Uint16`, never `Uint32`
  - Dense and sparse posting metadata use packed `u8` / `u16` / `u32` index
    columns where possible
  - Sparse field ids use `u8` or `u16`, depending on field count
  - Field-length data on the binary wire uses adaptive widths as well

This is another consequence of the fixed-corpus design. Once the final maxima
are known, the index can choose the narrowest representation that still holds
the data.

### Stored fields and external ids

The frozen index separates search-time metadata from posting data:

  - External document ids are stored independently from posting lists
  - Stored fields are kept in their own layout and are optional
  - The internal short-id space is optimized for search and scoring

This distinction is important because the serving path needs two different
things:

  - Dense numeric ids for compact postings and field-length tables
  - Stable application-facing ids and optional stored fields for final results

Stored fields are columnar at rest. Single-field layouts avoid materializing a
per-document row object on the common finalization path, while multi-field
layouts still present the expected public result shape.

### Field lengths and aggregation data

BM25-style scoring needs field-length and corpus-wide aggregation data. Frozen
indexes therefore store:

  - A field-length matrix keyed by short document id and field id
  - Per-field average lengths
  - Total live document count

These arrays are part of the frozen runtime snapshot, not derived on demand at
query time. This keeps the scoring path simple and consistent with the search
layer.

## Construction and import paths

There are several public ways to obtain a `FrozenMiniSearch` index, each aimed
at a different workflow.

### Direct trusted builds

These paths construct a frozen index directly from application documents:

  - `FrozenMiniSearch.fromDocuments(documents, options)`
  - `buildFrozenFromDocuments(documents, options)`
  - `createFrozenIndexBuilder(options, hints?)` followed by
    `freezeFrozenIndexBuilder(builder)`
  - `FrozenMiniSearch.fromAsyncIterable(iterable, options, hints?)`

The direct build path is the native workflow for fixed corpora. It builds the
packed representation directly from document input.

The builder variants exist for cases where documents arrive incrementally or in
streams. Hints such as `estimatedDocumentCount` and
`estimatedPostingsPerSlot` can improve preallocation, but they do not change the
final search behavior.

Internally, current builders use:

  - Flat term deduplication until final packing
  - Adaptive typed scratch columns for document ids and frequencies
  - A typed `slotIds` column plus stable counting-sort finalization for postings
  - A fast path that avoids allocating a duplicate-id `Set` while numeric ids
    stay dense
  - Explicit release of transient scratch state after freeze

These paths are treated as trusted builds: the project's own builder is
producing the structures, so assembly can skip some redundant post-build
validation that would only re-check invariants the builder itself already
enforced.

### JSON migration and interchange

`FrozenMiniSearch` can also import and export the `MiniSearch` JSON wire format:

  - `FrozenMiniSearch.toJSON()`
  - `FrozenMiniSearch.fromJSON(json, options?)`

This path exists for migration and interoperability. It allows:

  - Importing existing `MiniSearch` snapshots into frozen indexes
  - Exporting frozen indexes in a format readable by `MiniSearch`
  - Keeping JSON as an interchange format without requiring the `minisearch`
    package at runtime

`fromJSON()` is the canonical import API. The older lowercase alias is gone.

Unlike the direct trusted build path, `fromJSON()` validates the imported
snapshot. This is the right default because JSON input may come from outside the
current process and should not be trusted blindly.

Validation rejects malformed structure, out-of-range document or field ids,
duplicate terms, and non-canonical integer object keys such as leading-zero
keys. The import path also keeps optimized accumulation paths for supported
MiniSearch snapshot versions so validation does not force unnecessary hot-path
branching while building the frozen representation.

### Binary persistence

For serving and deployment, the preferred persistence path is the frozen binary
snapshot API:

  - Node: `saveBinarySync()`, `saveBinaryAsync()`, `loadBinarySync()`,
    `loadBinaryAsync()`
  - Browser entry: `saveBinaryAsync()`, `loadBinaryAsync()`

This path is the native on-disk and over-the-wire format for frozen indexes. It
is the format to optimize for in production deployments.

The Node and browser entry points intentionally differ here. On Node, both sync
and async binary APIs are available. On the browser entry, binary save/load is
async-only and works on `Uint8Array` rather than `Buffer`.

### Trust boundaries

The three acquisition paths differ in how much validation they require:

  - Direct frozen builds trust their own construction pipeline
  - `fromJSON()` validates imported MiniSearch snapshots before assembly
  - Binary load validates the decoded snapshot during the decode phase, then
    assembles from that validated data

This split is part of the design. The project tries to validate untrusted
external representations aggressively, while avoiding needless repeated checks
inside trusted internal pipelines.

Ownership also differs by path. Direct builds own their runtime arrays.
Compressed binary loads decode into an owned payload that can often be kept as
the backing storage. Raw binary loads may alias the caller-provided wire buffer,
so the load path materializes ownership where needed before exposing the index.

## Binary snapshot design

Frozen indexes can be serialized to a self-describing binary snapshot. The
format is designed around two goals:

  - Loading should be close to "take views over bytes" rather than rebuild a
    large object graph
  - Corrupt or unsupported input should fail clearly and early

### MSv5 framing

The current binary format is the MSv5 snapshot format. A snapshot contains a
fixed header and a set of independently described sections. The sections cover
the core metadata required to reconstruct the runtime snapshot, including:

  - counts and global metadata
  - field names
  - external document ids
  - stored fields
  - packed term index
  - field-length data
  - posting data and its metadata

The format is intentionally self-describing enough that readers can validate the
shape of the snapshot before exposing it as a usable index.

### Section layout and validation

The wire format closely mirrors the in-memory frozen structures. This keeps the
decode step simple and predictable: read metadata, validate bounds and
invariants, then materialize the runtime snapshot from typed-array views or
owned decoded sections.

Validation on load includes checks such as:

  - supported format version and magic bytes
  - monotonic and in-bounds section offsets
  - section checksums
  - posting bounds and layout coherence
  - packed term-index invariants

The goal is not to "parse whatever bytes are present." The goal is to reject
snapshots that do not satisfy the invariants required by the frozen runtime.

### Compact posting metadata on the wire

MSv5 stores posting metadata at its native packed width. Dense offsets and
lengths, sparse term starts, sparse offsets, and sparse lengths can be written
as `u8`, `u16`, or `u32` sections depending on the maxima observed in the
frozen layout.

On load, those sections are read back as typed-array views with the same width
when possible. Older snapshots that wrote this metadata as `u32` remain
readable, but newly written compact metadata requires readers that understand
the current MSv5 shape.

This is a good example of the frozen format's general philosophy: keep the wire
close to the runtime shape, use narrow columns when the corpus allows it, and
validate enough structure that the query engine can trust the decoded snapshot.

### Compression strategy

The binary writer uses a single-payload compression strategy rather than
compressing each logical section independently. The logical sections are first
assembled into one aligned payload, then that payload may be written raw or
compressed.

This design typically gives a better compression ratio than per-section
compression while keeping the format structurally simple.

On Node, the public API exposes codec selection through `saveBinarySync()` and
`saveBinaryAsync()`. The browser entry exposes async binary save/load with the
subset of codecs supported by the browser path.

`compression: 'auto'` prefers portable zlib when it shrinks the payload, and
falls back to raw when compression does not help. zstd remains a Node-only
option on runtimes with native support. Browser binary I/O uses native
`CompressionStream` / `DecompressionStream` for zlib, and does not support
zstd.

### Runtime split

The runtime split is deliberate:

  - Node supports sync and async binary save/load
  - Browser supports async binary save/load only
  - Browser binary APIs operate on `Uint8Array`
  - Node binary APIs operate on `Buffer`

This keeps the browser API aligned with non-blocking and portable execution
constraints, while allowing server-side code to choose between synchronous and
asynchronous workflows.

### Bounded-memory async load

`loadBinaryAsync()` exists for more than API symmetry. When compressed payloads
are involved, the async path can decompress and materialize data in a bounded
way, rather than requiring the whole decoded payload to be processed through one
monolithic synchronous step.

That bounded-memory behavior is especially relevant to large snapshots and is
part of the reason the binary path is preferred over JSON for serving
workloads.

## Performance and distribution boundaries

The project keeps a firm boundary between product runtime code and diagnostic
tooling.

Published bundles should contain only the runtime needed to build, load, and
query frozen indexes. Development-only helpers such as profiler hooks, retained
memory estimators, and string iterators for packed radix parity are kept out of
the shipped `dist` bundles.

Benchmarks and tests are allowed to inspect internal structures, but they do so
through explicit harness modules:

  - Source-based benchmark probes import internals through
    `benchmarks/harness/frozenSourceInternals.ts`
  - Distribution-based benchmark probes use the corresponding dist harness
  - Retained-memory breakdown helpers live under `testSupport`
  - Packed radix string iterators used for parity and benchmarks live under
    `testSupport`

This keeps the product import graph small while preserving enough visibility to
measure memory, build peaks, binary sizes, load times, and search behavior.

Detailed performance comparisons live in `benchmarks/VS_REFERENCE.md`, with the
root README linking to the latest reference report. The design document does
not try to duplicate benchmark tables; it explains the architectural choices
that those benchmarks exercise.

## Design limits and explicit trade-offs

The frozen architecture has some important limits that are consequences of the
design, not incidental implementation quirks.

  - `FrozenMiniSearch` is read-only. Live mutation is intentionally out of
    scope; changes should happen by rebuilding frozen data out of band.
  - Term frequencies are capped at `65535`, because frozen postings use
    `Uint8`/`Uint16` frequencies and never widen to `Uint32`.
  - Snapshot data does not serialize executable options such as `tokenize`,
    `processTerm`, `extractField`, or `stringifyField`. If custom functions were
    used at build time, the corresponding load/query options must remain
    consistent.
  - `fields` is optional on load because field names are embedded in snapshots,
    but if it is supplied it must match the indexed fields exactly.
  - Browser binary support is async-only by design.
  - Validation depth depends on the acquisition path: trusted builds, JSON
    migration, and binary load do not pay the same validation costs.
  - Binary snapshots are designed for the current frozen runtime shape, not as a
    general-purpose MiniSearch storage format.

These constraints are acceptable because they follow directly from the main
design goal: optimize the fixed-corpus serving case while preserving a familiar
search contract.

## Internal modules

The implementation is split into a few internal subsystems with clear
responsibilities.

### Packed term dictionary

`PackedRadixTree` is the frozen term dictionary module. It owns the packed tree
representation and term traversal logic used by exact, prefix, fuzzy, and
iteration-based search operations.

This module is intentionally internal. Users consume it through
`FrozenMiniSearch`, not as a standalone public data structure.

### Postings and scoring inputs

The postings modules are responsible for:

  - representing dense and sparse posting layouts
  - exposing flyweight-style access to per-term/per-field postings
  - validating frozen posting invariants
  - supplying the shared query engine with the scoring inputs it needs

This separation keeps search semantics independent from the concrete storage
layout.

### Builder and indexing core

The indexing core is responsible for extracting fields, tokenizing text,
processing terms, tracking field lengths, assigning short ids, and accumulating
postings.

The builder is optimized for transient memory as well as final index size.
Scratch columns grow adaptively, the term dictionary is packed only once at
freeze time, and post-freeze scratch state is released so long-running build
processes do not retain unnecessary buffers.

### Binary codec layer

The binary codec layer is responsible for:

  - mapping runtime snapshots to MSv5 sections
  - encoding and decoding binary payloads
  - handling compression and checksums
  - validating wire-level invariants before assembly
  - preserving ownership rules between raw and decoded payloads

Its job is persistence, not search logic.

### Builder, assembly, and validation

The project also separates:

  - document ingestion and incremental construction
  - assembly of a runtime frozen snapshot
  - validation of imported or decoded data
  - test and benchmark access to internal diagnostics

This split is important because different acquisition paths have different
trust levels. Direct builds, JSON migration, and binary load all end up
producing the same frozen runtime shape, but they do not reach it through the
same validation pipeline.
