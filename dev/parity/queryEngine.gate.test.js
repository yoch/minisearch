import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'
import { frozenFromMiniSearch } from '../../testSupport/frozenImportHelpers'
import { frozenTermIndex } from '../../src/internal/frozenInternals'
import { searchNaive } from './queryEngineHarness'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea ocean', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance road', category: 'fiction' },
  { id: 3, title: 'Neuromancer', text: 'cyberspace matrix hacker neural', category: 'sci-fi' },
  { id: 4, title: 'Zen Archery', text: 'zen archery art practice bow', category: 'non-fiction' },
  { id: 5, title: 'Ocean Life', text: 'whale dolphin ocean marine biology', category: 'science' },
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

function sortedIds(results) {
  return results.map(r => r.id).sort((a, b) => a - b)
}

function expectSameResults(mutable, frozen, query, searchOptions = {}, { expectedIds } = {}) {
  const a = mutable.search(query, searchOptions)
  const b = frozen.search(query, searchOptions)
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) {
    expect(b[i].id).toBe(a[i].id)
    expect(b[i].score).toBeCloseTo(a[i].score, 6)
    expect([...b[i].terms].sort()).toEqual([...a[i].terms].sort())
    expect(b[i].match).toEqual(a[i].match)
    expect(b[i].queryTerms).toEqual(a[i].queryTerms)
  }
  if (expectedIds !== undefined) {
    expect(sortedIds(a)).toEqual([...expectedIds].sort((x, y) => x - y))
  }
}

function expectSameAsNaive(engine, query, searchOptions = {}) {
  const gated = engine.search(query, searchOptions)
  const naive = searchNaive(engine, query, searchOptions)
  expect(sortedIds(naive)).toEqual(sortedIds(gated))
  expect(naive.length).toBe(gated.length)
  for (let i = 0; i < gated.length; i++) {
    const g = gated.find(r => r.id === naive[i].id)
    const n = naive[i]
    expect(g).toBeDefined()
    expect(n.score).toBeCloseTo(g.score, 6)
    expect(n.terms).toEqual(g.terms)
    expect(n.match).toEqual(g.match)
    expect(n.queryTerms).toEqual(g.queryTerms)
  }
}

function buildUniformCorpus(docCount, textFn = i => `common token${i}`) {
  const docs = []
  for (let i = 0; i < docCount; i++) {
    docs.push({ id: i, text: typeof textFn === 'function' ? textFn(i) : textFn })
  }
  return docs
}

function buildCommonUniqueCorpus(docCount) {
  return buildUniformCorpus(docCount, i => `common alpha unique${i}`)
}

describe('Gate docId scoring (AND / AND_NOT)', () => {
  let mutable
  let frozen

  beforeEach(() => {
    ({ mutable, frozen } = buildEngines())
  })

  describe('AND combinations', () => {
    test.each([
      ['exact+exact', 'zen art', { combineWith: 'AND' }, [2, 4]],
      ['exact+prefix', 'zen arch', { combineWith: 'AND', prefix: true }, [4]],
      ['exact+fuzzy', 'zen artry', { combineWith: 'AND', fuzzy: 0.3 }, [2, 4]],
      ['prefix+exact', 'neur hacker', { combineWith: 'AND', prefix: true }, [3]],
      ['3 terms', 'zen art motorcycle', { combineWith: 'AND' }, [2]],
    ])('%s', (_label, query, opts, expectedIds) => {
      expectSameResults(mutable, frozen, query, opts, { expectedIds })
    })
  })

  describe('AND_NOT combinations', () => {
    test.each([
      ['left exact vacuous', 'zen art', { combineWith: 'AND_NOT' }, []],
      ['left discriminant', 'matrix zen', { combineWith: 'AND_NOT' }, [3]],
      ['left prefix', 'zen arch', { combineWith: 'AND_NOT', prefix: true }, [2]],
      ['left fuzzy', 'zen artry', { combineWith: 'AND_NOT', fuzzy: 0.3 }, []],
      ['right prefix excluded', 'whale oce', { combineWith: 'AND_NOT', prefix: true }, []],
      ['right fuzzy excluded', 'whale oceon', { combineWith: 'AND_NOT', fuzzy: 0.3 }, []],
    ])('%s', (_label, query, opts, expectedIds) => {
      expectSameResults(mutable, frozen, query, opts, { expectedIds })
    })
  })

  describe('nested combinations', () => {
    test('AND containing OR', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'AND',
        queries: [
          'zen',
          { combineWith: 'OR', queries: ['motorcycle', 'archery'] },
        ],
      }, { expectedIds: [2, 4] })
    })

    test('OR containing AND (inner AND gated)', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'OR',
        queries: [
          { combineWith: 'AND', queries: ['zen', 'art'] },
          'whale',
        ],
      }, { expectedIds: [1, 2, 4, 5] })
    })

    test('AND containing inner AND matches naive oracle', () => {
      const query = {
        combineWith: 'AND',
        queries: [
          'zen',
          { combineWith: 'AND', queries: ['art', 'practice'] },
        ],
      }
      expectSameResults(mutable, frozen, query, {}, { expectedIds: [4] })
      expectSameAsNaive(frozen, query)
    })

    test('AND_NOT with nested negated OR', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'AND_NOT',
        queries: [
          'zen',
          { combineWith: 'OR', queries: ['motorcycle', 'ocean'] },
        ],
      }, { expectedIds: [2, 4] })
    })

    test('AND_NOT with nested negated branch without combineWith (zen)', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'AND_NOT',
        queries: [
          'zen',
          { queries: ['whale', 'ocean'] },
        ],
      }, { expectedIds: [2, 4] })
    })

    test('AND_NOT with nested negated branch without combineWith defaults to OR', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'AND_NOT',
        queries: [
          'ocean',
          { queries: ['matrix', 'whale'] },
        ],
      }, { expectedIds: [1, 5] })
    })

    test('AND_NOT with multiple exclusions matches naive oracle', () => {
      const query = {
        combineWith: 'AND_NOT',
        queries: ['zen', 'motorcycle', 'matrix'],
      }
      expectSameResults(mutable, frozen, query, {}, { expectedIds: [4] })
      expectSameAsNaive(frozen, query)
    })
  })

  describe('with boostDocument', () => {
    const boostDocument = (id, term) => (id === 2 || term === 'archery' ? 2 : 1)

    test('AND with boostDocument', () => {
      expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND', boostDocument }, { expectedIds: [2, 4] })
    })

    test('AND_NOT with boostDocument', () => {
      expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND_NOT', boostDocument }, { expectedIds: [] })
    })

    test('AND_NOT with boostDocument returning 0 excludes boosted doc from positive branch', () => {
      const zeroBoost = (id) => (id === 2 ? 0 : 1)
      expectSameResults(mutable, frozen, 'zen whale', { combineWith: 'AND_NOT', boostDocument: zeroBoost }, { expectedIds: [4] })
      expect(sortedIds(mutable.search('zen whale', { combineWith: 'AND_NOT' }))).toEqual([2, 4])
    })
  })

  describe('non-regression OR and exact', () => {
    test('OR unchanged', () => {
      expectSameResults(mutable, frozen, 'zen whale', { combineWith: 'OR' }, { expectedIds: [1, 2, 4, 5] })
    })

    test('exact single term unchanged', () => {
      expectSameResults(mutable, frozen, 'zen', {}, { expectedIds: [2, 4] })
    })

    test('prefix single term unchanged', () => {
      expectSameResults(mutable, frozen, 'neur', { prefix: true }, { expectedIds: [3] })
    })
  })

  describe('oracle: gated vs naive score-then-combine (frozen)', () => {
    test('frozen AND exact+exact', () => {
      expectSameAsNaive(frozen, 'zen art', { combineWith: 'AND' })
    })

    test('frozen AND exact+prefix', () => {
      expectSameAsNaive(frozen, 'zen arch', { combineWith: 'AND', prefix: true })
    })

    test('frozen AND_NOT', () => {
      expectSameAsNaive(frozen, 'matrix zen', { combineWith: 'AND_NOT' })
    })

    test('empty AND gate returns no results', () => {
      const query = { combineWith: 'AND', queries: ['zen', 'nonexistenttermxyz'] }
      expect(mutable.search(query)).toEqual([])
      expect(frozen.search(query)).toEqual([])
      expectSameAsNaive(frozen, query)
    })
  })

  describe('gate threshold (gateIsSelectiveEnough fallback)', () => {
    test('large intersection uses non-selective path but matches naive oracle', () => {
      const docCount = 6_000
      const ms = new MiniSearch({
        fields: ['text'],
        searchOptions: { prefix: false },
      })
      ms.addAll(buildUniformCorpus(docCount, i => `alpha beta ${i}`))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false } })
      const opts = { combineWith: 'AND' }
      const query = 'alpha beta'
      expectSameAsNaive(frozen, query, opts)
      expect(ms.search(query, opts).length).toBeGreaterThan(1000)
    }, 30_000)

    test('small selective gate still matches naive oracle', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: true } })
      ms.addAll(buildUniformCorpus(200, i => (i < 5 ? `zen item${i}` : `unique${i} alpha`)))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: true } })
      const opts = { combineWith: 'AND', prefix: true }
      expectSameAsNaive(frozen, 'zen uniq', opts)
    })

    test('broad-first AND exact matches naive oracle', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: false } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false } })
      expectSameAsNaive(frozen, 'common unique1', { combineWith: 'AND' })
    })

    test('broad-first AND prefix matches naive oracle', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: true } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: true } })
      expectSameAsNaive(frozen, 'common unique1', { combineWith: 'AND', prefix: true })
    })

    test('broad-first nested AND matches naive oracle', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: false } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false } })
      const query = {
        combineWith: 'AND',
        queries: [
          'common',
          { combineWith: 'AND', queries: ['alpha', 'unique1'] },
        ],
      }
      expectSameAsNaive(frozen, query, {})
    })

    test('broad AND_NOT exclusion removing all matches naive oracle', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: false } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false } })
      expectSameAsNaive(frozen, 'common alpha', { combineWith: 'AND_NOT' })
      expect(frozen.search('common alpha', { combineWith: 'AND_NOT' })).toEqual([])
    })
  })

  describe('boostDocument (results only, not call-count contract)', () => {
    test('gated AND with boostDocument matches naive oracle', () => {
      const boostDocument = (id, term) => (id === 2 || term === 'archery' ? 2 : 1)
      const opts = { combineWith: 'AND', boostDocument }
      expectSameAsNaive(frozen, 'zen art', opts)
    })

    test('broad-first AND with zero boostDocument matches naive oracle', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: false } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false } })
      const boostDocument = (id) => (id === 1 ? 0 : 1)
      expectSameAsNaive(frozen, 'common unique1', { combineWith: 'AND', boostDocument })
      expect(frozen.search('common unique1', { combineWith: 'AND', boostDocument })).toEqual([])
    })
  })

  describe('lazy materialization (frozen only)', () => {
    test('AND resolves fewer derived terms than OR when gate is selective', () => {
      const bigDocs = []
      for (let i = 0; i < 100; i++) {
        bigDocs.push({
          id: i,
          text: i < 3 ? `zen item${i}` : `unique${i} alpha beta`,
        })
      }
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: true } })
      ms.addAll(bigDocs)

      const patchCounter = (frozen) => {
        let count = 0
        const index = frozenTermIndex(frozen)
        const original = index.termByIndex.bind(index)
        index.termByIndex = (termIndex) => {
          count++
          return original(termIndex)
        }
        return () => count
      }

      const frozenAnd = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: true } })
      const getAndCount = patchCounter(frozenAnd)
      frozenAnd.search('zen uniq', { combineWith: 'AND', prefix: true })
      const andResolves = getAndCount()

      const frozenOr = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: true } })
      const getOrCount = patchCounter(frozenOr)
      frozenOr.search('zen uniq', { combineWith: 'OR', prefix: true })
      const orResolves = getOrCount()

      expect(andResolves).toBeLessThan(orResolves)
    })

    test('AND_NOT does not resolve negated branch prefix terms', () => {
      const bigDocs = []
      for (let i = 0; i < 50; i++) {
        bigDocs.push({
          id: i,
          text: i < 2 ? 'zen alpha' : `exclude${i} beta gamma`,
        })
      }
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: true } })
      ms.addAll(bigDocs)
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: true } })

      let resolveCount = 0
      const index = frozenTermIndex(frozen)
      const original = index.termByIndex.bind(index)
      index.termByIndex = (termIndex) => {
        resolveCount++
        return original(termIndex)
      }

      frozen.search('zen exclude', { combineWith: 'AND_NOT', prefix: true })

      // Positive branch may resolve zen-derived prefix terms; negated exclude* branch must not.
      expect(resolveCount).toBeLessThan(50)
    })

    test('broad-first AND avoids scoring the full first branch', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: false } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false } })
      let boostCalls = 0
      const boostDocument = () => {
        boostCalls++
        return 1
      }

      frozen.search('common unique1', { combineWith: 'AND', boostDocument })

      expect(boostCalls).toBeLessThan(100)
    })

    test('prefix broad-first probe stays on sequential gating', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: true } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: true } })
      let boostCalls = 0
      const boostDocument = () => {
        boostCalls++
        return 1
      }

      expectSameAsNaive(frozen, 'common unique1', { combineWith: 'AND', prefix: true, boostDocument })

      expect(boostCalls).toBeGreaterThan(100)
    })

    test('fuzzy broad-first probe stays on sequential gating', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: false, fuzzy: 0.2 } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false, fuzzy: 0.2 } })
      let boostCalls = 0
      const boostDocument = () => {
        boostCalls++
        return 1
      }

      expectSameAsNaive(frozen, 'common unique1', { combineWith: 'AND', fuzzy: 0.2, boostDocument })

      expect(boostCalls).toBeGreaterThan(100)
    })

    test('broad AND_NOT exclusion can return empty without scoring positive branch', () => {
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: false } })
      ms.addAll(buildCommonUniqueCorpus(6000))
      const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, { fields: ['text'], searchOptions: { prefix: false } })
      let boostCalls = 0
      const boostDocument = () => {
        boostCalls++
        return 1
      }

      const results = frozen.search('common alpha', { combineWith: 'AND_NOT', boostDocument })

      expect(results).toEqual([])
      expect(boostCalls).toBe(0)
    })
  })
})
