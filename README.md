# FrozenMiniSearch

[![npm version](https://img.shields.io/npm/v/@yoch/frozenminisearch.svg)](https://www.npmjs.com/package/@yoch/frozenminisearch)
[![coverage](https://codecov.io/gh/yoch/frozenminisearch/graph/badge.svg)](https://codecov.io/gh/yoch/frozenminisearch)
[![CI](https://github.com/yoch/frozenminisearch/actions/workflows/main.yml/badge.svg)](https://github.com/yoch/frozenminisearch/actions/workflows/main.yml)
[![Docs](https://github.com/yoch/frozenminisearch/actions/workflows/docs.yml/badge.svg)](https://github.com/yoch/frozenminisearch/actions/workflows/docs.yml)

[API documentation](https://yoch.github.io/frozenminisearch/) · [Live demo](https://yoch.github.io/frozenminisearch/demo/)

**Memory-optimized, read-only full-text search for Node.js and browsers.** FrozenMiniSearch is built for fixed corpora, with compact immutable indexes and [MiniSearch](https://github.com/lucaong/minisearch)-compatible query semantics.

Try the [demo application](https://yoch.github.io/frozenminisearch/demo/) (Billboard Hot 100 search and auto-suggest in the browser).

Use it when your documents are built offline, shipped to production, and queried many times. In that shape, frozen indexes use **~94–95% less index RAM** (totalResident = heapUsed + external on both sides) in the main benchmark set, save to compact binary snapshots, and load faster than MiniSearch JSON.

This package is intentionally focused on fixed-corpus serving: build frozen
directly, persist binary snapshots, then load and query them many times.

---

## Why FrozenMiniSearch?

FrozenMiniSearch is for the common production path where search data changes elsewhere, not inside the web process:

- Build or import the index offline.
- Save it as a compact binary snapshot.
- Load it in many read-only Node.js processes.
- Query with MiniSearch-compatible `search`, `autoSuggest`, filters, boosts, prefix/fuzzy search, wildcard, and `AND` / `OR` / `AND_NOT`.

Internally it uses packed radix postings, typed arrays, and columnar stored fields instead of large JavaScript object graphs. The result is a search engine tuned for resident efficiency, fast loads, and repeatable serving workflows.

<!-- vs-reference:start — pnpm bench:readme -->
### Measured vs MiniSearch

On the main benchmark set vs MiniSearch 7.2.0, frozen indexes use **~95% less index RAM** and win on **27/27 search cases**.

Full comparison table, column definitions, and capture metadata: **[benchmarks/VS_REFERENCE.md](benchmarks/VS_REFERENCE.md)** (`benchmarks/baselines/reference.json` @ `1cdc405`, 2026-07-04).
<!-- vs-reference:end -->

---

## Quick start

```bash
pnpm add @yoch/frozenminisearch
```

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }
const index = FrozenMiniSearch.fromDocuments(documents, options)

index.search('ishmael', { prefix: true })
index.autoSuggest('zen ar')

const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
```

For larger imports, use the incremental builder:

```javascript
import FrozenMiniSearch, {
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} from '@yoch/frozenminisearch'

const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: rows.length })
builder.addAll(rows) // `addAllAsync` for chunked, non-blocking ingestion (browser)
const index = freezeFrozenIndexBuilder(builder)
```

ESM and CommonJS are both supported on Node (`main` → CJS, `module` → ESM). For browsers and bundlers, use the dedicated browser entry (search, build, and **async** binary I/O):

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch/browser'

const index = FrozenMiniSearch.fromDocuments(documents, options)
index.search('ishmael', { prefix: true })

// Load a zlib snapshot from CDN (Uint8Array)
const buf = new Uint8Array(await (await fetch('/index.frozen')).arrayBuffer())
const loaded = await FrozenMiniSearch.loadBinaryAsync(buf, options)
```

See the [hosted demo](https://yoch.github.io/frozenminisearch/demo/) or [examples/plain_js_frozen/README.md](examples/plain_js_frozen/README.md) locally (`pnpm docs:demo:frozen` then serve the repo root).

---

## Usage

### Basic usage

```javascript
const documents = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael. Some years ago...', category: 'fiction' },
  { id: 2, title: 'Zen and the Art of Motorcycle Maintenance', text: 'I can see by my watch...', category: 'fiction' },
  // ...
]

const options = { fields: ['title', 'text'], storeFields: ['title', 'category'] }
const index = FrozenMiniSearch.fromDocuments(documents, options)

index.search('zen art motorcycle')
// => [{ id, title, category, score, match, ... }, ...]
```

Frozen indexes are **read-only**: there is no `add`, `remove`, or `discard`. Rebuild offline or use `createFrozenIndexBuilder` for incremental ingestion before finalizing the index.

### Search options

MiniSearch-compatible options work on `search()` and `autoSuggest()`:

```javascript
index.search('zen', { fields: ['title'] })
index.search('zen', { boost: { title: 2 } })
index.search('moto', { prefix: true })
index.search('ismael', { fuzzy: 0.2 })
index.search('zen', { filter: (result) => result.category === 'fiction' })
index.search('zen', { combineWith: 'AND' }) // OR, AND_NOT

const index = FrozenMiniSearch.fromDocuments(documents, {
  fields: ['title', 'text'],
  searchOptions: { prefix: true, fuzzy: 0.2 },
})
```

Wildcard and nested query combinations are supported (`FrozenMiniSearch.wildcard`, `QueryCombination`).

### Auto-suggestions

```javascript
index.autoSuggest('zen ar')
// => [{ suggestion: 'zen archery art', terms: [...], score }, ...]

index.autoSuggest('neromancer', { fuzzy: 0.2 })
index.autoSuggest('zen ar', { filter: (result) => result.category === 'fiction' })
```

### Field extraction

For nested or computed fields, pass `extractField` at **index build** time (and again when loading binary snapshots if you override defaults):

```javascript
const options = {
  fields: ['title', 'author.name', 'pubYear'],
  extractField: (document, fieldName) => {
    if (fieldName === 'pubYear') {
      return document.pubDate?.getFullYear().toString()
    }
    return fieldName.split('.').reduce((doc, key) => doc && doc[key], document)
  },
}
```

The default extractor is available via `FrozenMiniSearch.getDefault('extractField')`.

### Tokenization

```javascript
const options = {
  fields: ['title', 'text'],
  tokenize: (string, _fieldName) => string.split('-'),
  searchOptions: {
    tokenize: (string) => string.split(/[\s-]+/),
  },
}
```

`FrozenMiniSearch.getDefault('tokenize')` returns the built-in Unicode space/punctuation splitter. Only that **exact function reference** enables the fastest indexing path; equivalent wrappers use the general path.

### Term processing

```javascript
const stopWords = new Set(['and', 'or', 'the'])

const options = {
  fields: ['title', 'text'],
  processTerm: (term) => (stopWords.has(term) ? null : term.toLowerCase()),
  searchOptions: {
    processTerm: (term) => term.toLowerCase(),
  },
}
```

`FrozenMiniSearch.getDefault('processTerm')` downcases terms (no stemming or stop-word list by default).

### Default helpers

```javascript
FrozenMiniSearch.getDefault('tokenize')
FrozenMiniSearch.getDefault('processTerm')
FrozenMiniSearch.getDefault('extractField')
FrozenMiniSearch.getDefault('stringifyField')
```

Use these when wrapping a custom function and delegating to the library default.

---

## Migration and interoperability

For fixed corpora, most serving code can stay the same. Change how the index is built or loaded, then keep calling `search`, `autoSuggest`, `has`, and `getStoredFields`.

Default and named imports both work:

```javascript
// ESM
import FrozenMiniSearch from '@yoch/frozenminisearch'
import { FrozenMiniSearch } from '@yoch/frozenminisearch'

// CommonJS
const FrozenMiniSearch = require('@yoch/frozenminisearch')
const { FrozenMiniSearch } = require('@yoch/frozenminisearch')
```

The native workflow is to build frozen directly:

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch'

const frozen = FrozenMiniSearch.fromDocuments(documents, options)
```

Existing MiniSearch JSON snapshots can be imported through the compatibility path:

```javascript
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '@yoch/frozenminisearch'

const upstream = new MiniSearch(options)
upstream.addAll(documents)

const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(upstream), options)
```

This path is useful for migration and interchange. In normal frozen deployments, you typically build with `fromDocuments`, the builder API, or binary snapshots directly.
Internally, `fromJSON` now packs terms directly into the immutable packed term
index; it no longer routes through any local `SearchableMap` or mutable radix
fallback.

---

## Search API (MiniSearch-compatible)

- `search(query, searchOptions?)` — string, wildcard (`FrozenMiniSearch.wildcard`), or nested `QueryCombination`
- `autoSuggest(queryString, options?)`
- `has(id)`, `getStoredFields(id)`
- `getDefault(optionName)` — built-in `tokenize`, `processTerm`, `extractField`, `stringifyField`, …
- `saveBinarySync` / `loadBinarySync` on **Node** (async variants too); browser entry supports **async** binary only (`Uint8Array`, `raw` / `zlib` / `auto`)

Custom `tokenize` and `processTerm` functions are not stored in snapshots; pass the same functions again when loading.

See [Usage](#usage) above for examples.

---

## Binary snapshots (Node)

Binary snapshots are the preferred production format on Node.js.

```javascript
const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, {}) // field names embedded in snapshot
```

- **Node ≥ 20**
- `compression: 'auto'` uses **zlib** when it shrinks the payload (portable on Node 20+ and in the browser build); falls back to raw when compression does not help.
- Use explicit compression when you need a specific artifact:

```javascript
const portable = index.saveBinarySync({ compression: 'zlib' }) // CDN / browser
const uncompressed = index.saveBinarySync({ compression: 'raw' })
const bestRatio = index.saveBinarySync({ compression: 'zstd' }) // Node 22.15+ only
```

Raw snapshots load in the browser without native compression APIs. zlib snapshots in the browser require `CompressionStream` / `DecompressionStream`. Browser binary I/O is async because it uses native browser stream APIs, but it still materializes the full compressed/decompressed payload in memory. zstd snapshots require Node 22.15+ (read/write on Node; not supported in the browser build).

---

## Benchmarks

See [benchmarks/README.md](benchmarks/README.md).

```bash
pnpm bench                                 # quick smoke (dev profile)
pnpm bench:run                             # full suite (regression profile)
NODE_OPTIONS='--expose-gc' node benchmarks/framework/cli.mjs run --profile=vs-reference
pnpm bench:record && pnpm bench:diff       # capture then diff vs reference.json
node benchmarks/scripts/generate-readme-comparison.mjs --from=benchmarks/baselines/latest.json
```

---

## Development

```bash
pnpm install
pnpm test          # src/ + dev/parity/
pnpm build
node scripts/verify-npm-pack.cjs
```

Parity tests compare against MiniSearch 7. Longer notes and performance work live under [dev/docs/](https://github.com/yoch/frozenminisearch/tree/master/dev/docs) (repository only) and [benchmarks/README.md](benchmarks/README.md).

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **@yoch/frozenminisearch** — memory-optimized frozen indexes and compact binary snapshots

Upstream docs: [MiniSearch](https://lucaong.github.io/minisearch/)
