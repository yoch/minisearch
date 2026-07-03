import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenFromMiniSearchSnapshot } from '../testSupport/frozenImportHelpers'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title'],
  searchOptions: { prefix: true },
}

function searchIds(index, query, searchOptions = {}) {
  return index.search(query, searchOptions).map(r => r.id)
}

function searchScores(index, query, searchOptions = {}) {
  return index.search(query, searchOptions).map(r => r.score)
}

describe('toJSON MiniSearch wire export', () => {
  test('round-trip preserves search results', () => {
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    const snapshot = frozen.toJSON()
    const reloaded = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), options)

    expect(reloaded.search('zen')).toEqual(frozen.search('zen'))
    expect(searchIds(reloaded, 'ishmael', { prefix: true })).toEqual(
      searchIds(frozen, 'ishmael', { prefix: true }),
    )
    expect(reloaded.autoSuggest('zen ar')).toEqual(frozen.autoSuggest('zen ar'))
    expect(snapshot.serializationVersion).toBe(2)
    expect(snapshot.dirtCount).toBe(0)
  })

  test('exported snapshot loads in MiniSearch with equivalent scores', () => {
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    const reference = new MiniSearch(options)
    reference.addAll(docs)

    const mutable = MiniSearch.loadJSON(JSON.stringify(frozen.toJSON()), options)

    expect(searchIds(mutable, 'zen')).toEqual(searchIds(reference, 'zen'))

    const andMutable = searchScores(mutable, 'zen art', { combineWith: 'AND' })
    const andReference = searchScores(reference, 'zen art', { combineWith: 'AND' })
    expect(andMutable.length).toBe(andReference.length)
    for (let i = 0; i < andMutable.length; i++) {
      expect(andMutable[i]).toBeCloseTo(andReference[i], 6)
    }

    const mutableScores = searchScores(mutable, 'ishmael', { prefix: true })
    const referenceScores = searchScores(reference, 'ishmael', { prefix: true })
    expect(mutableScores.length).toBe(referenceScores.length)
    for (let i = 0; i < mutableScores.length; i++) {
      expect(mutableScores[i]).toBeCloseTo(referenceScores[i], 6)
    }
  })

  test('round-trip preserves search after sparse MiniSearch snapshot import', () => {
    const options = { fields: ['t'] }
    const snapshot = {
      documentCount: 2,
      nextId: 3,
      documentIds: { 0: 'a', 2: 'c' },
      fieldIds: { t: 0 },
      fieldLength: { 0: [1], 2: [1] },
      averageFieldLength: [1],
      storedFields: {},
      dirtCount: 0,
      index: [
        ['alpha', { 0: { 0: 1 } }],
        ['gamma', { 0: { 2: 1 } }],
      ],
      serializationVersion: 2,
    }

    const frozen = frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options)
    const reloaded = FrozenMiniSearch.fromJSON(JSON.stringify(frozen.toJSON()), options)

    expect(frozen.search('alpha').map(r => r.id)).toEqual(['a'])
    expect(frozen.search('gamma').map(r => r.id)).toEqual(['c'])
    expect(reloaded.search('alpha').map(r => r.id)).toEqual(['a'])
    expect(reloaded.search('gamma').map(r => r.id)).toEqual(['c'])
  })
})
