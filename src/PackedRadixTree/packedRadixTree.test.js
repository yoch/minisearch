import SearchableMap, {
  packSearchableMap,
  packSearchableMapEntries,
  packSearchableMapTree,
  searchableMapTree,
} from '../../testSupport/upstreamSearchableMap.js'
import {
  buildTermTreeSectionColumnar,
  readPackedTermTreeSectionColumnar,
} from '../msv5/packedRadixBinaryMsv5'
import { validateFrozenTermIndexLeaves } from '../frozenTermIndex'
import { sortedFuzzyTuples, sortedMapFuzzy } from '../../testSupport/fuzzyParity.js'
import { packedPrefixEntries } from '../../testSupport/packedRadixStringIterators.js'
import PackedRadixTree from './index'
import { packTermsFromList } from './packTermList'

const terms = ['summer', 'acqua', 'aqua', 'acquire', 'poisson', 'qua']
const keyValues = terms.map((key, i) => [key, i])
const map = SearchableMap.from(keyValues)
const packed = packSearchableMap(map)

function packEntries(entries) {
  return packSearchableMapEntries(entries)
}

function sortedEntries(entries) {
  return [...entries].sort(([aTerm, aIndex], [bTerm, bIndex]) =>
    aTerm < bTerm ? -1 : aTerm > bTerm ? 1 : aIndex - bIndex,
  )
}

function sortedPrefixRefs(tree, prefix) {
  return sortedEntries(
    Array.from(tree.prefixRefs(prefix))
      .map(({ termIndex }) => [tree.termByIndex(termIndex), termIndex]),
  )
}

test('packTermsFromList matches SearchableMap semantics', () => {
  const viaSearchableMap = packEntries(keyValues)
  const direct = packTermsFromList(terms)
  expect(sortedEntries(direct.entries())).toEqual(sortedEntries(viaSearchableMap.entries()))
  expect(sortedPrefixRefs(direct, 'a')).toEqual(sortedPrefixRefs(viaSearchableMap, 'a'))
  for (const [term, termIndex] of keyValues) {
    expect(direct.get(term)).toBe(termIndex)
    expect(direct.get(term)).toBe(viaSearchableMap.get(term))
  }
  expect(direct.size).toBe(viaSearchableMap.size)
})

test('packTermsFromList preserves split-edge lookups and prefix sets', () => {
  const entries = [
    ['acqua', 0],
    ['aqua', 1],
    ['acquire', 2],
  ]
  const direct = packTermsFromList(entries.map(([term]) => term))
  const viaSearchableMap = packEntries(entries)

  expect(sortedEntries(direct.entries())).toEqual(sortedEntries(viaSearchableMap.entries()))
  expect(sortedPrefixRefs(direct, 'a')).toEqual(sortedPrefixRefs(viaSearchableMap, 'a'))
})

test('SearchableMap _tree adapter matches SearchableMap packing', () => {
  const viaAdapterTree = packSearchableMapTree(searchableMapTree(map), map.size)
  expect(Array.from(viaAdapterTree.entries())).toEqual(Array.from(packed.entries()))
  expect(Array.from(viaAdapterTree.prefixRefs('a')).map(({ termIndex }) => [viaAdapterTree.termByIndex(termIndex), termIndex]))
    .toEqual(Array.from(map.atPrefix('a').entries()))
  expectFuzzyMultiset(viaAdapterTree, map, 'acqua', 2)
})

function expectFuzzyMultiset(packed, map, query, maxDistance) {
  const refsAsEntries = Array.from(packed.fuzzyRefs(query, maxDistance))
    .map(({ termIndex, distance }) => [packed.termByIndex(termIndex), termIndex, distance])
  expect(sortedFuzzyTuples(refsAsEntries))
    .toEqual(sortedMapFuzzy(map.fuzzyGet(query, maxDistance)))
}

function expectPackedParity(entries, probes = {}) {
  const {
    gets = [],
    prefixes = ['', 'a', 'ab', 'ac'],
    fuzzyQueries = ['a'],
    fuzzyDistances = [0, 1, 2],
  } = probes

  const m = SearchableMap.from(entries)
  const p = packSearchableMap(m)
  const built = packEntries(entries)
  const packedBuf = buildTermTreeSectionColumnar(p)

  // SearchableMap adapter preserves upstream iteration order; direct packing only
  // guarantees semantic equivalence.
  expect(Array.from(p.entries())).toEqual(Array.from(m.entries()))
  expect(sortedEntries(built.entries())).toEqual(sortedEntries(m.entries()))
  // Order must survive MSv5 columnar wire round-trip.
  expect(Array.from(readPackedTermTreeSectionColumnar(packedBuf, m.size).entries()))
    .toEqual(Array.from(m.entries()))

  for (const term of gets) {
    expect(p.get(term)).toBe(m.get(term))
    expect(built.get(term)).toBe(m.get(term))
  }
  for (const prefix of prefixes) {
    const fromRefs = Array.from(p.prefixRefs(prefix))
      .map(({ termIndex }) => [p.termByIndex(termIndex), termIndex])
    const fromBuiltRefs = Array.from(built.prefixRefs(prefix))
      .map(({ termIndex }) => [built.termByIndex(termIndex), termIndex])
    expect(fromRefs).toEqual(Array.from(m.atPrefix(prefix).entries()))
    expect(sortedEntries(fromBuiltRefs)).toEqual(sortedEntries(m.atPrefix(prefix).entries()))
  }
  // fuzzyRefs: same match set as fuzzyGet; iteration order is not compared.
  for (const query of fuzzyQueries) {
    for (const distance of fuzzyDistances) {
      expectFuzzyMultiset(p, m, query, distance)
      expectFuzzyMultiset(built, m, query, distance)
    }
  }
}

function allTerms(alphabet, maxLength) {
  const terms = ['']
  function visit(prefix, depth) {
    if (depth === maxLength) return
    for (const char of alphabet) {
      const term = prefix + char
      terms.push(term)
      visit(term, depth + 1)
    }
  }
  visit('', 0)
  return terms
}

describe('PackedRadixTree module', () => {
  test('exact get matches SearchableMap', () => {
    for (const term of terms) {
      expect(packed.get(term)).toBe(map.get(term))
    }
    expect(packed.get('missing')).toBeUndefined()
  })

  test('entries match SearchableMap', () => {
    expect(Array.from(packed.entries())).toEqual(Array.from(map.entries()))
  })

  test('entries and prefix iteration preserve leaf position before child edges', () => {
    expectPackedParity([['a', 0], ['ab', 1], ['ac', 2]])
  })

  test('entries and prefix iteration preserve leaf position after child edges', () => {
    expectPackedParity([['ab', 1], ['ac', 2], ['a', 0]])
  })

  test('empty string term matches SearchableMap', () => {
    expectPackedParity([['', 0], ['a', 1], ['ab', 2]])
  })

  test('leaf interleaved between child edges matches SearchableMap', () => {
    // Inserting 'ab', then 'a', then 'ac' puts the LEAF at slot 1 (between edges).
    expectPackedParity([['ab', 0], ['a', 1], ['ac', 2]], {
      gets: ['a', 'ab', 'ac', 'abc'],
    })
  })

  test('multibyte and surrogate-pair terms match SearchableMap', () => {
    const utf8Terms = ['café', 'cafard', 'caféine', 'naïve', '日本', '日本語', '🚀rocket', '🚀ship']
    const entries = utf8Terms.map((term, i) => [term, i])
    expectPackedParity(entries, {
      gets: [...utf8Terms, 'cafe', 'caf', '日', '🚀', '🚀roc'],
      prefixes: ['', 'caf', 'café', '日本', '🚀', '🚀ro', 'naï'],
      fuzzyQueries: ['cafe', 'café', '日本', '🚀ship'],
      fuzzyDistances: [0, 1, 2],
    })
  })

  test('get returns undefined for a strict prefix that ends mid-edge', () => {
    const m = SearchableMap.from([['acquire', 0]])
    const p = packSearchableMap(m)
    expect(p.get('acq')).toBeUndefined()
    expect(p.get('acquire')).toBe(0)
    expect(p.get('acquired')).toBeUndefined()
  })

  test('empty index packs, validates and round-trips', () => {
    const m = SearchableMap.from([])
    const p = packSearchableMap(m)
    expect(() => validateFrozenTermIndexLeaves(p, 0)).not.toThrow()
    expect(Array.from(p.entries())).toEqual([])
    const buf = buildTermTreeSectionColumnar(p)
    const back = readPackedTermTreeSectionColumnar(buf, 0)
    expect(Array.from(back.entries())).toEqual([])
  })

  test('deterministic generated corpora match SearchableMap', () => {
    const generatedTerms = allTerms(['a', 'b', 'c'], 3)
    const orderings = [
      generatedTerms,
      [...generatedTerms].reverse(),
      generatedTerms.filter((_, i) => i % 2 === 0).concat(generatedTerms.filter((_, i) => i % 2 === 1)),
    ]

    for (const ordering of orderings) {
      const entries = ordering.map((term, i) => [term, i])
      const m = SearchableMap.from(entries)
      const p = packSearchableMap(m)

      for (const term of generatedTerms.concat(['d', 'aaad'])) {
        expect(p.get(term)).toBe(m.get(term))
      }
      expect(Array.from(p.entries())).toEqual(Array.from(m.entries()))
      for (const prefix of ['', 'a', 'b', 'c', 'aa', 'ab', 'bc', 'zzz']) {
        const refs = Array.from(p.prefixRefs(prefix))
          .map(({ termIndex }) => [p.termByIndex(termIndex), termIndex])
        expect(refs).toEqual(Array.from(m.atPrefix(prefix).entries()))
      }
      for (const query of ['', 'a', 'ab', 'ba', 'ccc', 'zz']) {
        for (const distance of [0, 1, 2]) {
          expectFuzzyMultiset(p, m, query, distance)
        }
      }
    }
  })

  test('prefixRefs match SearchableMap atPrefix', () => {
    for (const prefix of ['', 'a', 'ac', 'sum', 'xyz']) {
      const fromPacked = Array.from(packed.prefixRefs(prefix))
        .map(({ termIndex }) => [packed.termByIndex(termIndex), termIndex])
      const fromMap = Array.from(map.atPrefix(prefix).entries())
      expect(fromPacked).toEqual(fromMap)
    }
  })

  test('fuzzyRefs match SearchableMap fuzzyGet (same match set)', () => {
    for (const distance of [0, 1, 2, 3]) {
      expectFuzzyMultiset(packed, map, 'acqua', distance)
    }
  })

  test('termByIndex and termLengthByIndex rebuild terms from lazy metadata', () => {
    for (const [term, index] of map.entries()) {
      expect(packed.termByIndex(index)).toBe(term)
      expect(packed.termLengthByIndex(index)).toBe(term.length)
    }
  })

  test('prefixRefs preserve prefix match set and lengths', () => {
    const prefix = 'ac'
    const refs = Array.from(packed.prefixRefs(prefix))
    const rebuilt = refs.map(({ termIndex }) => packed.termByIndex(termIndex))
    expect([...rebuilt].sort()).toEqual(Array.from(map.atPrefix(prefix).entries()).map(([term]) => term).sort())
    for (const ref of refs) {
      expect(ref.length).toBe(packed.termByIndex(ref.termIndex).length)
    }
  })

  test('packedPrefixEntries remains parity-equivalent to SearchableMap atPrefix', () => {
    for (const prefix of ['', 'a', 'ac', 'sum', 'xyz']) {
      expect(Array.from(packedPrefixEntries(packed, prefix)))
        .toEqual(Array.from(map.atPrefix(prefix).entries()))
    }
    const prefix = 'ac'
    const refs = Array.from(packed.prefixRefs(prefix))
      .map(({ termIndex }) => [packed.termByIndex(termIndex), termIndex])
    expect(Array.from(packedPrefixEntries(packed, prefix))).toEqual(refs)
  })

  test('mid-edge prefix includes full terms', () => {
    const m = SearchableMap.from([['acquire', 0]])
    const p = packSearchableMap(m)
    expect(Array.from(p.prefixRefs('acq')).map(({ termIndex }) => [p.termByIndex(termIndex), termIndex]))
      .toEqual([['acquire', 0]])
  })

  test('validateFrozenTermIndexLeaves rejects wrong leaf count', () => {
    expect(() => validateFrozenTermIndexLeaves(packed, map.size + 1)).toThrow(/leaf count/)
  })

  test('validateFrozenTermIndexLeaves rejects duplicate leaf indices', () => {
    const nodeValue = new Uint32Array(packed.nodeValue)
    const leafNodes = Array.from(packed.nodeLeafOrder)
      .map((order, node) => order === 0 ? -1 : node)
      .filter(node => node >= 0)
    nodeValue[leafNodes[1]] = nodeValue[leafNodes[0]]
    const duplicate = PackedRadixTree.fromData({
      size: packed.size,
      nodeCount: packed.nodeCount,
      edgeCount: packed.edgeCount,
      labelHeap: packed.labelHeap,
      nodeEdgeOffset: packed.nodeEdgeOffset,
      nodeValue,
      nodeLeafOrder: packed.nodeLeafOrder,
      edgeLabelStart: packed.edgeLabelStart,
      edgeLabelLength: packed.edgeLabelLength,
      edgeChild: packed.edgeChild,
    })
    expect(() => validateFrozenTermIndexLeaves(duplicate, map.size)).toThrow(/duplicate leaf index/)
  })

  test('validateFrozenTermIndexLeaves rejects malformed packed arrays', () => {
    const malformed = PackedRadixTree.fromData({
      size: 0,
      nodeCount: 1,
      edgeCount: 1,
      labelHeap: 'a',
      nodeEdgeOffset: new Uint32Array([0, 1]),
      nodeValue: new Uint32Array([0]),
      nodeLeafOrder: new Uint32Array([0]),
      edgeLabelStart: new Uint32Array([0]),
      edgeLabelLength: new Uint16Array([1]),
      edgeChild: new Uint32Array([9]),
    })
    expect(() => validateFrozenTermIndexLeaves(malformed, 0)).toThrow(/child out of bounds/)
  })

  test('rejects edge labels that cannot fit the packed length array', () => {
    const longLabel = 'x'.repeat(0x10000)
    expect(() => packEntries([[longLabel, 0]])).toThrow(/edge label too long/)
    expect(() => packTermsFromList([longLabel])).toThrow(/edge label too long/)
  })

  test('term tree section round-trips through MSv5 columnar wire', () => {
    const buf = buildTermTreeSectionColumnar(packed)
    const back = readPackedTermTreeSectionColumnar(buf, map.size)
    for (const term of terms) {
      expect(back.get(term)).toBe(packed.get(term))
    }
    expect(Array.from(back.entries())).toEqual(Array.from(packed.entries()))
  })

  test('columnar decoder rejects truncated section', () => {
    const buf = buildTermTreeSectionColumnar(packed)
    expect(() => readPackedTermTreeSectionColumnar(buf.subarray(0, 8), map.size)).toThrow(/too short/)
  })

  test('columnar decoder rejects termCount mismatch', () => {
    const buf = buildTermTreeSectionColumnar(packed)
    expect(() => readPackedTermTreeSectionColumnar(buf, map.size + 1)).toThrow(/termCount mismatch/)
  })
})
