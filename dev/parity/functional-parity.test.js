import MiniSearch from 'minisearch'
import FrozenMiniSearch, { freezeFrozenIndexBuilder } from '../../src/FrozenMiniSearch'
import { createFrozenIndexBuilder } from '../../src/frozenBuild'
import {
  frozenFromMiniSearch,
  frozenFromMiniSearchSnapshot,
} from '../../testSupport/frozenImportHelpers'
import { frozenMemoryBreakdown } from '../../testSupport/frozenMemoryBreakdown.js'
import { overflowFrequencies } from '../../benchmarks/benchmarkScenarios.js'
import {
  expectSameResults,
  expectSameSuggestions,
  expectSameWildcardResults,
} from './parityHarness.js'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance', category: 'fiction' },
  { id: 3, title: 'Neuromancer', text: 'cyberspace matrix hacker', category: 'sci-fi' },
  { id: 4, title: 'Zen Archery', text: 'zen archery art practice', category: 'non-fiction' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title', 'category'],
  searchOptions: { prefix: true, fuzzy: 0.2 },
}

function buildEngines() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
  return { mutable, frozen }
}

describe('FrozenMiniSearch parity with MiniSearch', () => {
  let mutable
  let frozen

  beforeEach(() => {
    ({ mutable, frozen } = buildEngines())
  })

  test('shared query engine: freeze, fromDocuments, and builder agree', () => {
    const viaFromMiniSearch = buildFrozenViaFreeze()
    const viaDocs = buildFrozenDirect()
    const viaBuilder = buildFrozenViaBuilder()
    const queries = [
      'zen',
      'zen whale',
      { combineWith: 'AND', queries: ['zen', 'art'] },
      'neur',
      FrozenMiniSearch.wildcard,
    ]
    const searchOpts = [
      {},
      { combineWith: 'OR' },
      { prefix: true },
      { fuzzy: 0.3 },
      { boost: { title: 2 } },
      { filter: r => r.category === 'fiction' },
    ]
    for (const q of queries) {
      for (const opts of searchOpts) {
        expectSameResults(viaFromMiniSearch, viaDocs, q, opts)
        expectSameResults(viaFromMiniSearch, viaBuilder, q, opts)
      }
    }
  })

  test('exact search', () => {
    expectSameResults(mutable, frozen, 'zen')
  })

  test('OR combine', () => {
    expectSameResults(mutable, frozen, 'zen whale', { combineWith: 'OR' })
  })

  test('AND combine', () => {
    expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND' })
  })

  test('prefix search', () => {
    expectSameResults(mutable, frozen, 'neur', { prefix: true })
  })

  test('fuzzy search', () => {
    expectSameResults(mutable, frozen, 'neuromancr', { fuzzy: 0.3 })
  })

  test('wildcard', () => {
    expectSameWildcardResults(mutable, frozen)
  })

  test('arbitrary Symbol("*") is NOT treated as wildcard', () => {
    // Wildcard is matched by strict identity on WILDCARD_QUERY only — no
    // description-based widening. This guards the contract.
    const rogue = Symbol('*')
    expect(() => frozen.search(rogue)).toThrow(/invalid query/)
  })

  test('filter', () => {
    const filter = r => r.category === 'fiction'
    expectSameResults(mutable, frozen, 'zen', { filter })
  })

  test('boostDocument', () => {
    const boostDocument = id => (id === 2 ? 2 : 1)
    expectSameResults(mutable, frozen, 'zen', { boostDocument })
  })

  test('nested query', () => {
    expectSameResults(mutable, frozen, {
      combineWith: 'AND',
      queries: ['zen', { combineWith: 'OR', queries: ['motorcycle', 'archery'] }],
    })
  })

  test('AND_NOT combine', () => {
    expectSameResults(mutable, frozen, 'matrix zen', { combineWith: 'AND_NOT' })
    expect(mutable.search('matrix zen', { combineWith: 'AND_NOT' }).map(r => r.id)).toEqual([3])
  })

  test('AND_NOT inherits combineWith into nested combination without explicit operator', () => {
    // Per MiniSearch 7.2 behavior: a child QueryCombination that does not
    // specify `combineWith` inherits the parent's `combineWith`. Here the
    // parent is AND_NOT, so the inner { queries: ['matrix', 'whale'] }
    // becomes effectively AND_NOT, not OR.
    const extendedDocs = [
      ...docs,
      { id: 5, title: 'Ocean Life', text: 'whale dolphin ocean marine biology', category: 'science' },
    ]
    const extendedOpts = { ...options, searchOptions: { prefix: true, fuzzy: 0.2 } }
    const extendedMutable = new MiniSearch(extendedOpts)
    extendedMutable.addAll(extendedDocs)
    const extendedFrozen = frozenFromMiniSearch(FrozenMiniSearch, extendedMutable, extendedOpts)
    const query = {
      combineWith: 'AND_NOT',
      queries: ['ocean', { queries: ['matrix', 'whale'] }],
    }
    expectSameResults(extendedMutable, extendedFrozen, query)
  })

  test('field boost', () => {
    expectSameResults(mutable, frozen, 'zen', { boost: { title: 2 } })
  })

  test('autoSuggest parity', () => {
    expectSameSuggestions(frozen.autoSuggest('zen ar'), mutable.autoSuggest('zen ar'))
  })

  test('has and getStoredFields', () => {
    expect(frozen.has(1)).toBe(true)
    expect(frozen.has(999)).toBe(false)
    expect(frozen.getStoredFields(3)).toEqual(mutable.getStoredFields(3))
  })

  test('boostTerm parity', () => {
    const boostTerm = term => (term === 'zen' ? 2 : 1)
    expectSameResults(mutable, frozen, 'zen art', { boostTerm })
  })

  test('fields restriction parity', () => {
    expectSameResults(mutable, frozen, 'zen', { fields: ['title'] })
  })

  test('search tokenize and processTerm parity', () => {
    const tokenize = q => q.split(/\s+/)
    const processTerm = t => t.toLowerCase()
    expectSameResults(mutable, frozen, 'ZEN Art', { tokenize, processTerm })
  })

  test('search processTerm array parity', () => {
    const corpus = [
      { id: 1, text: 'alpha beta' },
      { id: 2, text: 'gamma' },
    ]
    const opts = { fields: ['text'] }
    const ms = new MiniSearch(opts)
    ms.addAll(corpus)
    const fr = frozenFromMiniSearch(FrozenMiniSearch, ms, opts)
    expectSameResults(ms, fr, 'combo', {
      processTerm: term => term === 'combo' ? ['alpha', 'beta'] : term,
      combineWith: 'AND',
    })
  })

  test('search processTerm falsy values are skipped', () => {
    const corpus = [
      { id: 1, text: 'alpha beta' },
      { id: 2, text: 'beta' },
    ]
    const opts = { fields: ['text'] }
    const ms = new MiniSearch(opts)
    ms.addAll(corpus)
    const fr = frozenFromMiniSearch(FrozenMiniSearch, ms, opts)
    const processTerm = term => {
      if (term === 'false') return false
      if (term === 'null') return null
      if (term === 'undefined') return undefined
      if (term === 'empty') return ''
      if (term === 'array') return ['', 'alpha']
      return term
    }
    expectSameResults(ms, fr, 'false null undefined empty array', {
      processTerm,
    })
  })

  test('functional query options receive normalized terms array', () => {
    const seen = { prefix: [], fuzzy: [], boostTerm: [] }
    const record = key => (term, index, terms) => {
      seen[key].push([term, index, [...terms]])
      return key === 'boostTerm' ? 1 : false
    }
    frozen.search('ZEN Art', {
      tokenize: q => q.split(/\s+/),
      processTerm: term => term.toLowerCase(),
      prefix: record('prefix'),
      fuzzy: record('fuzzy'),
      boostTerm: record('boostTerm'),
    })
    const expected = [
      ['zen', 0, ['zen', 'art']],
      ['art', 1, ['zen', 'art']],
    ]
    expect(seen.prefix).toEqual(expected)
    expect(seen.fuzzy).toEqual(expected)
    expect(seen.boostTerm).toEqual(expected)
  })

  test('prefix and fuzzy combinations remain unchanged', () => {
    expectSameResults(mutable, frozen, 'neur', { prefix: true, fuzzy: false })
    expectSameResults(mutable, frozen, 'neuromancr', { prefix: false, fuzzy: 0.3 })
    expectSameResults(mutable, frozen, 'neur', { prefix: true, fuzzy: 0.3 })
  })

  test('explicit weights parity', () => {
    expectSameResults(mutable, frozen, 'neur', {
      prefix: true,
      weights: { fuzzy: 0.5, prefix: 0.4 },
    })
  })

  test('explicit bm25 parity', () => {
    expectSameResults(mutable, frozen, 'zen', {
      bm25: { k: 1.5, b: 0.6, d: 0.4 },
    })
  })
})

describe('FrozenMiniSearch custom indexing options', () => {
  test('custom idField and extractField parity', () => {
    const customDocs = [
      { key: 'a', body: 'hello world' },
      { key: 'b', body: 'hello again' },
    ]
    const customOpts = {
      fields: ['body'],
      idField: 'key',
      extractField: (doc, field) => doc[field],
    }
    const mutable = new MiniSearch(customOpts)
    mutable.addAll(customDocs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, customOpts)
    const direct = FrozenMiniSearch.fromDocuments(customDocs, customOpts)
    expectSameResults(frozen, direct, 'hello')
    expect(frozen.has('a')).toBe(true)
    expect(frozen.has('b')).toBe(true)
    expect(frozen.has('c')).toBe(false)
    expect(direct.has('a')).toBe(true)
    expect(direct.has('b')).toBe(true)
  })

  test('custom stringifyField parity', () => {
    const customDocs = [{ id: 1, tags: ['alpha', 'beta'] }]
    const customOpts = {
      fields: ['tags'],
      stringifyField: value => value.join(' '),
    }
    const mutable = new MiniSearch(customOpts)
    mutable.addAll(customDocs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, customOpts)
    const direct = FrozenMiniSearch.fromDocuments(customDocs, customOpts)
    expectSameResults(frozen, direct, 'alpha')
  })
})

describe('FrozenMiniSearch freeze after discard', () => {
  test('search parity without vacuum', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    mutable.discard(3)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    expectSameResults(mutable, frozen, 'zen')
    expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND' })
    expectSameWildcardResults(mutable, frozen)
  })

  test('binary round-trip after discard without vacuum', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    mutable.discard(3)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
    expect(loaded.search(FrozenMiniSearch.wildcard)).toEqual(frozen.search(FrozenMiniSearch.wildcard))
  })
})

describe('FrozenMiniSearch binary round-trip', () => {
  test('search results match after saveBinary/loadBinary', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const buf = frozen.saveBinarySync()
    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)

    expect(loaded.search('zen motorcycle')).toEqual(frozen.search('zen motorcycle'))
    expect(loaded.search('neur', { prefix: true })).toEqual(frozen.search('neur', { prefix: true }))
    expect(loaded.documentCount).toBe(frozen.documentCount)
    expect(loaded.termCount).toBe(frozen.termCount)
  })

  test('autoSuggest keeps defaults and ordering after saveBinary/loadBinary', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options)

    expect(loaded.autoSuggest('zen ar')).toEqual(frozen.autoSuggest('zen ar'))
  })

  test('loadBinary rejects fields not in snapshot', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, options).saveBinarySync()
    expect(() => FrozenMiniSearch.loadBinarySync(buf, { fields: ['title', 'missing'] }))
      .toThrow(/must match the indexed fields exactly/)
  })

  test('loadBinary rejects field subset', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, options).saveBinarySync()
    expect(() => FrozenMiniSearch.loadBinarySync(buf, { fields: ['title'] }))
      .toThrow(/must match the indexed fields exactly/)
  })

  test('overflow frequencies survive saveBinary round-trip', () => {
    const corpus = overflowFrequencies(40, 400)
    const opts = { fields: ['txt'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), opts)
    const before = frozen.search('alpha', { combineWith: 'OR' })
    const after = loaded.search('alpha', { combineWith: 'OR' })
    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].id).toBe(before[i].id)
      expect(after[i].score).toBeCloseTo(before[i].score, 10)
    }
  })

  test('saveBinary writes MSv5 for multi-field index', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, options).saveBinarySync()
    expect(buf.toString('ascii', 0, 4)).toBe('MSv5')
    expect(buf.readUInt16LE(4)).toBe(5)
  })

  test('Uint32 doc ids when document count exceeds 65535', () => {
    // Synthetic snapshot keeps nextId > 65535 without indexing 65k docs.
    const snapshot = {
      documentCount: 65536,
      nextId: 65536,
      documentIds: { 65535: 'max' },
      fieldIds: { txt: 0 },
      fieldLength: { 65535: [1] },
      averageFieldLength: [1],
      storedFields: {},
      dirtCount: 0,
      index: [
        ['alpha', { 0: { 65535: 1 } }],
        ['beta', { 0: { 65535: 1 } }],
      ],
      serializationVersion: 2,
    }
    const opts = { fields: ['txt'] }
    const frozen = frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, opts)
    expect(frozen.documentCount).toBe(65536)
    expect(frozen.search('alpha').map(r => r.id)).toEqual(['max'])
    expect(frozenMemoryBreakdown(frozen).postings.docIdWidth).toBe(32)
    const buf = frozen.saveBinarySync()
    expect(buf.toString('ascii', 0, 4)).toBe('MSv5')
    expect(buf.readUInt16LE(6) & 1).toBe(0)
    const loaded = FrozenMiniSearch.loadBinarySync(buf, opts)
    expect(loaded.search('alpha').map(r => r.id)).toEqual(['max'])
    expect(loaded.search('beta').map(r => r.id)).toEqual(['max'])
  })

  test('saveBinary writes MSv5 with Uint16 doc ids when nextId <= 65535', () => {
    const docsBig = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      text: `hello world ${i}`,
    }))
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(docsBig)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, { fields: ['text'] }).saveBinarySync()
    expect(buf.toString('ascii', 0, 4)).toBe('MSv5')
    expect(buf.readUInt16LE(4)).toBe(5)
    expect(buf.readUInt16LE(6) & 1).toBe(1)
  })

  test('loadBinary without fields option', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), {})
    expectSameResults(frozen, loaded, 'zen')
  })
})

function buildFrozenViaFreeze() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  return frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
}

function buildFrozenDirect() {
  return FrozenMiniSearch.fromDocuments(docs, options)
}

describe('FrozenMiniSearch.fromDocuments', () => {
  test('parity with freeze on standard corpus', () => {
    const frozen = buildFrozenViaFreeze()
    const direct = buildFrozenDirect()
    expect(direct.documentCount).toBe(frozen.documentCount)
    expect(direct.termCount).toBe(frozen.termCount)
    expectSameResults(frozen, direct, 'zen')
    expectSameResults(frozen, direct, 'zen whale', { combineWith: 'OR' })
    expectSameResults(frozen, direct, 'neur', { prefix: true })
    expectSameResults(frozen, direct, FrozenMiniSearch.wildcard)
    expectSameSuggestions(direct.autoSuggest('zen ar'), frozen.autoSuggest('zen ar'))
  })

  test('optional field null matches freeze BM25', () => {
    const sparseDocs = [
      { id: 1, title: 'alpha beta', text: 'one two' },
      { id: 2, title: null, text: 'three four' },
      { id: 3, title: 'gamma', text: 'five six' },
    ]
    const sparseOpts = { fields: ['title', 'text'] }
    const mutable = new MiniSearch(sparseOpts)
    mutable.addAll(sparseDocs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, sparseOpts)
    const direct = FrozenMiniSearch.fromDocuments(sparseDocs, sparseOpts)
    expectSameResults(frozen, direct, 'three')
    expectSameResults(frozen, direct, 'alpha gamma', { combineWith: 'OR' })
  })

  test('processTerm returning false/null skips terms during indexing', () => {
    const corpus = [
      { id: 1, text: 'the quick brown fox' },
      { id: 2, text: 'a lazy dog' },
    ]
    const opts = {
      fields: ['text'],
      processTerm: term => {
        const lower = term.toLowerCase()
        if (lower === 'the') return false
        if (lower === 'a') return null
        return lower
      },
    }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, opts)
    const direct = FrozenMiniSearch.fromDocuments(corpus, opts)
    expect(mutable.search('the')).toEqual([])
    expect(frozen.search('the')).toEqual([])
    expect(direct.search('the')).toEqual([])
    expectSameResults(mutable, frozen, 'quick')
    expectSameResults(mutable, frozen, 'dog')
    expectSameResults(mutable, frozen, 'lazy')
  })

  test('processTerm returning array', () => {
    const corpus = [{ id: 1, text: 'FooBar' }]
    const opts = {
      fields: ['text'],
      processTerm: term => [term.toLowerCase(), term.toUpperCase()],
    }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, opts)
    const direct = FrozenMiniSearch.fromDocuments(corpus, opts)
    expectSameResults(frozen, direct, 'foo')
    expectSameResults(frozen, direct, 'BAR')
  })

  test('processTerm array keeps empty-string entries like freeze', () => {
    const corpus = [{ id: 1, text: 'FooBar' }]
    const opts = {
      fields: ['text'],
      processTerm: () => ['', 'foo'],
    }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, opts)
    const direct = FrozenMiniSearch.fromDocuments(corpus, opts)
    expect(direct.termCount).toBe(frozen.termCount)
    expect(direct.search('foo')).toEqual(frozen.search('foo'))
  })

  test('overflow frequencies parity with freeze', () => {
    const corpus = overflowFrequencies(40, 400)
    const opts = { fields: ['txt'] }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, opts)
    const direct = FrozenMiniSearch.fromDocuments(corpus, opts)
    const a = frozen.search('alpha', { combineWith: 'OR' })
    const b = direct.search('alpha', { combineWith: 'OR' })
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) {
      expect(b[i].id).toBe(a[i].id)
      expect(b[i].score).toBeCloseTo(a[i].score, 10)
    }
  })

  test('binary round-trip after fromDocuments', () => {
    const direct = buildFrozenDirect()
    const loaded = FrozenMiniSearch.loadBinarySync(direct.saveBinarySync(), options)
    const frozen = buildFrozenViaFreeze()
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('rejects missing and duplicate IDs like MiniSearch', () => {
    expect(() => FrozenMiniSearch.fromDocuments([{ text: 'a' }], { fields: ['text'] }))
      .toThrow(/does not have ID/)
    expect(() => FrozenMiniSearch.fromDocuments([
      { id: 1, text: 'a' },
      { id: 1, text: 'b' },
    ], { fields: ['text'] }))
      .toThrow(/duplicate ID/)
  })

  test('empty corpus', () => {
    const direct = FrozenMiniSearch.fromDocuments([], options)
    expect(direct.documentCount).toBe(0)
    expect(direct.search('zen')).toEqual([])
  })
})

function buildFrozenViaBuilder(corpus = docs, opts = options, hints) {
  const builder = createFrozenIndexBuilder(opts, hints)
  for (let i = 0; i < corpus.length; i++) {
    builder.add(corpus[i])
  }
  return freezeFrozenIndexBuilder(builder)
}

describe('FrozenIndexBuilder', () => {
  test('parity with fromDocuments on standard corpus', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder()
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expect(fromBuilder.termCount).toBe(fromDocs.termCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
    expectSameResults(fromDocs, fromBuilder, 'zen whale', { combineWith: 'OR' })
    expect(fromBuilder.autoSuggest('zen ar')).toEqual(fromDocs.autoSuggest('zen ar'))
  })

  test('parity without estimatedDocumentCount hint', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder(docs, options, undefined)
    expectSameResults(fromDocs, fromBuilder, 'zen')
  })

  test('parity with underestimated estimatedDocumentCount', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder(docs, options, { estimatedDocumentCount: 1 })
    expectSameResults(fromDocs, fromBuilder, 'neur', { prefix: true })
  })

  test('parity and correct sizes with overestimated estimatedDocumentCount', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder(docs, options, { estimatedDocumentCount: docs.length + 100 })
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
    // Internal arrays must not be padded to the overestimate
    const breakdown = frozenMemoryBreakdown(fromBuilder)
    const directBreakdown = frozenMemoryBreakdown(fromDocs)
    expect(breakdown.documentCount).toBe(directBreakdown.documentCount)
    expect(breakdown.storedFieldsJsonBytes).toBe(directBreakdown.storedFieldsJsonBytes)
  })

  test('binary round-trip after builder freeze', () => {
    const built = buildFrozenViaBuilder()
    const loaded = FrozenMiniSearch.loadBinarySync(built.saveBinarySync(), options)
    const fromDocs = buildFrozenDirect()
    expect(loaded.search('zen')).toEqual(fromDocs.search('zen'))
  })

  test('saveBinary is deterministic and path-independent', () => {
    // The flat term dedup must assign identical term indices on every build,
    // and fromDocuments / builder-freeze must emit byte-identical output.
    const a = Buffer.from(buildFrozenDirect().saveBinarySync())
    const b = Buffer.from(buildFrozenDirect().saveBinarySync())
    const c = Buffer.from(buildFrozenViaBuilder().saveBinarySync())
    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(true)
  })

  test('fromJSON frozen toJSON round-trip is deterministic and search-equivalent', () => {
    const fromDocs = buildFrozenDirect()
    const snapshot = JSON.stringify(fromDocs.toJSON())
    const viaJsonA = FrozenMiniSearch.fromJSON(snapshot, options)
    const viaJsonB = FrozenMiniSearch.fromJSON(snapshot, options)
    const a = Buffer.from(viaJsonA.saveBinarySync())
    const b = Buffer.from(viaJsonB.saveBinarySync())
    expect(a.equals(b)).toBe(true)
    expectSameResults(fromDocs, viaJsonA, 'zen whale', { combineWith: 'OR' })
    expectSameResults(fromDocs, viaJsonB, 'zen whale', { combineWith: 'OR' })
  })

  test('empty index via freeze without add', () => {
    const empty = freezeFrozenIndexBuilder(createFrozenIndexBuilder(options))
    expect(empty.documentCount).toBe(0)
    expect(empty.search('zen')).toEqual([])
  })

  test('cannot add after freeze', () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    expect(() => builder.add(docs[1])).toThrow(/cannot add after freezeParams/i)
  })

  test('cannot freeze twice', () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    expect(() => builder.freezeParams()).toThrow(/freezeParams\(\) already called/i)
  })

  test('rejects duplicate ID like fromDocuments', () => {
    const builder = createFrozenIndexBuilder({ fields: ['text'] })
    builder.add({ id: 1, text: 'a' })
    expect(() => builder.add({ id: 1, text: 'b' })).toThrow(/duplicate ID/)
  })
})

describe('FrozenMiniSearch.fromAsyncIterable', () => {
  test('parity with fromDocuments', async () => {
    async function* docStream() {
      for (const doc of docs) yield doc
    }
    const fromDocs = buildFrozenDirect()
    const fromAsync = await FrozenMiniSearch.fromAsyncIterable(docStream(), options)
    expect(fromAsync.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromAsync, 'zen')
    expectSameResults(fromDocs, fromAsync, 'zen art', { combineWith: 'AND' })
  })

  test('parity with estimatedDocumentCount hint', async () => {
    async function* docStream() {
      for (const doc of docs) yield doc
    }
    const fromDocs = buildFrozenDirect()
    const fromAsync = await FrozenMiniSearch.fromAsyncIterable(docStream(), options, {
      estimatedDocumentCount: docs.length,
    })
    expect(fromAsync.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromAsync, 'zen')
  })

  test('correct sizes with overestimated estimatedDocumentCount', async () => {
    async function* docStream() {
      for (const doc of docs) yield doc
    }
    const fromDocs = buildFrozenDirect()
    const fromAsync = await FrozenMiniSearch.fromAsyncIterable(docStream(), options, {
      estimatedDocumentCount: docs.length + 100,
    })
    expect(fromAsync.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromAsync, 'zen')
    const breakdown = frozenMemoryBreakdown(fromAsync)
    const directBreakdown = frozenMemoryBreakdown(fromDocs)
    expect(breakdown.documentCount).toBe(directBreakdown.documentCount)
    expect(breakdown.storedFieldsJsonBytes).toBe(directBreakdown.storedFieldsJsonBytes)
  })
})

describe('FrozenIndexBuilder.addAll / addAllAsync', () => {
  test('addAll parity with fromDocuments', () => {
    const fromDocs = buildFrozenDirect()
    const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: docs.length })
    builder.addAll(docs)
    const fromBuilder = freezeFrozenIndexBuilder(builder)
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
    expectSameResults(fromDocs, fromBuilder, 'zen art', { combineWith: 'AND' })
  })

  test('addAllAsync parity with fromDocuments', async () => {
    const fromDocs = buildFrozenDirect()
    const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: docs.length })
    await builder.addAllAsync(docs)
    const fromBuilder = freezeFrozenIndexBuilder(builder)
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
  })

  test('addAllAsync accepts chunkSize option', async () => {
    const builder = createFrozenIndexBuilder(options)
    await builder.addAllAsync(docs, { chunkSize: 3 })
    const frozen = freezeFrozenIndexBuilder(builder)
    expect(frozen.documentCount).toBe(docs.length)
  })

  test('addAllAsync rejects non-positive chunkSize', () => {
    const builder = createFrozenIndexBuilder(options)
    expect(() => builder.addAllAsync(docs, { chunkSize: 0 }))
      .toThrow(/chunkSize must be a positive integer/)
    expect(() => builder.addAllAsync(docs, { chunkSize: -1 }))
      .toThrow(/chunkSize must be a positive integer/)
  })

  test('cannot addAll after freeze', () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    expect(() => builder.addAll([docs[1]])).toThrow(/cannot add after freezeParams/i)
  })

  test('cannot addAllAsync after freeze', async () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    await expect(builder.addAllAsync([docs[1]])).rejects.toThrow(/cannot add after freezeParams/i)
  })
})

describe('memoryBreakdown', () => {
  test('returns sensible structure sizes', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const b = frozenMemoryBreakdown(frozen)
    expect(b.termCount).toBeGreaterThan(0)
    expect(b.postings.totalTypedBytes).toBeGreaterThan(0)
    expect(b.termIndex.nodeCount).toBeGreaterThan(0)
    expect(b.estimatedStructuredBytes).toBeGreaterThan(0)
  })
})

describe('fieldLengthMatrix adaptive width', () => {
  test('uses Uint8 for typical multi-field corpus', () => {
    const frozen = buildFrozenDirect()
    const params = frozenMemoryBreakdown(frozen)
    // 4 docs × 2 fields × 1 byte
    expect(params.documents.fieldLengthMatrixBytes).toBe(8)
  })

  test('uses Uint16 when a field exceeds 255 unique terms', () => {
    const corpus = [{ id: 1, text: Array.from({ length: 300 }, (_, i) => `term${i}`).join(' ') }]
    const opts = { fields: ['text'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    expect(frozenMemoryBreakdown(frozen).documents.fieldLengthMatrixBytes).toBe(2)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), opts)
    expect(loaded.search('term0')).toEqual(frozen.search('term0'))
    expect(frozenMemoryBreakdown(loaded).documents.fieldLengthMatrixBytes).toBe(2)
  })

  test('uses Uint32 when a field exceeds 65535 unique terms', () => {
    const corpus = [{ id: 1, text: Array.from({ length: 70000 }, (_, i) => `term${i}`).join(' ') }]
    const opts = { fields: ['text'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    expect(frozenMemoryBreakdown(frozen).documents.fieldLengthMatrixBytes).toBe(4)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), opts)
    expect(frozenMemoryBreakdown(loaded).documents.fieldLengthMatrixBytes).toBe(4)
    expect(loaded.search('term0')).toEqual(frozen.search('term0'))
  })

  test('fromMiniSearch uses Uint32 for extreme field lengths', () => {
    const corpus = [{ id: 1, text: Array.from({ length: 70000 }, (_, i) => `term${i}`).join(' ') }]
    const opts = { fields: ['text'] }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, opts)
    expect(frozenMemoryBreakdown(frozen).documents.fieldLengthMatrixBytes).toBe(4)
  })

  test('saveBinary round-trip preserves search with Uint8 matrix', () => {
    const frozen = buildFrozenDirect()
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options)
    expectSameResults(frozen, loaded, 'zen')
    expectSameResults(frozen, loaded, 'neur', { prefix: true })
  })

  test('freeze after discard keeps adaptive matrix', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    mutable.discard(3)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    expect(frozenMemoryBreakdown(frozen).documents.fieldLengthMatrixBytes).toBe(6)
    expectSameResults(mutable, frozen, 'zen')
  })
})

describe('allFreqs adaptive width', () => {
  test('uses Uint8 for typical corpus', () => {
    const frozen = buildFrozenDirect()
    const { postings } = frozenMemoryBreakdown(frozen)
    expect(postings.allFreqsBytes).toBe(postings.allDocIdsBytes / 2)
  })

  test('uses Uint16 when a term frequency exceeds 255', () => {
    const corpus = overflowFrequencies(4, 400)
    const opts = { fields: ['txt'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    const { postings } = frozenMemoryBreakdown(frozen)
    expect(postings.allFreqsBytes).toBe(postings.allDocIdsBytes)
  })

  test('overflow frequencies match mutable MiniSearch scores', () => {
    const corpus = overflowFrequencies(40, 400)
    const opts = { fields: ['txt'] }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, opts)
    const ms = mutable.search('alpha', { combineWith: 'OR' })
    const fr = frozen.search('alpha', { combineWith: 'OR' })
    expect(fr.length).toBe(ms.length)
    for (let i = 0; i < ms.length; i++) {
      expect(fr[i].id).toBe(ms[i].id)
      expect(fr[i].score).toBeCloseTo(ms[i].score, 10)
    }
  })

  test('saveBinary round-trip preserves u8 or u16 width and scores', () => {
    const corpus = overflowFrequencies(4, 400)
    const opts = { fields: ['txt'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    const beforeBytes = frozenMemoryBreakdown(frozen).postings.allFreqsBytes
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), opts)
    expect(frozenMemoryBreakdown(loaded).postings.allFreqsBytes).toBe(beforeBytes)
    const a = frozen.search('alpha', { combineWith: 'OR' })
    const b = loaded.search('alpha', { combineWith: 'OR' })
    for (let i = 0; i < a.length; i++) {
      expect(b[i].score).toBeCloseTo(a[i].score, 10)
    }
  })
})

describe('owned snapshot independence', () => {
  test('freeze keeps fieldIds independent of mutable source', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const before = frozen.search('zen')
    mutable._fieldIds.title = 99
    expect(frozen.search('zen')).toEqual(before)
  })

  test('loadBinary survives wire buffer mutation after owned copy', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, options).saveBinarySync()
    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
    const before = loaded.search('zen')
    buf.fill(0)
    expect(loaded.search('zen')).toEqual(before)
  })
})
