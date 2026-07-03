import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenMemoryBreakdown } from '../testSupport/frozenMemoryBreakdown.js'
import { frozenFromMiniSearch } from '../testSupport/frozenImportHelpers'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title'],
  searchOptions: { prefix: true },
}

function validSnapshot(overrides = {}) {
  return {
    documentCount: 1,
    nextId: 1,
    documentIds: { 0: 'a' },
    fieldIds: { text: 0 },
    fieldLength: { 0: [1] },
    averageFieldLength: [1],
    storedFields: {},
    index: [['hello', { 0: { 0: 1 } }]],
    serializationVersion: 2,
    ...overrides,
  }
}

describe('fromMiniSearch loaders', () => {
  test('fromJSON matches reference search', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const json = JSON.stringify(reference)
    const frozen = FrozenMiniSearch.fromJSON(json, options)
    expect(frozen.search('zen')).toEqual(reference.search('zen'))
    expect(frozen.search('ishmael', { prefix: true }).map(r => r.id)).toEqual(
      reference.search('ishmael', { prefix: true }).map(r => r.id),
    )
  })

  test('fromJSON is the only public MiniSearch JSON loader name', () => {
    expect(typeof FrozenMiniSearch.fromJSON).toBe('function')
    expect('fromJson' in FrozenMiniSearch).toBe(false)
  })

  test('fromMiniSearch instance uses toJSON()', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, reference, options)
    expect(frozen.documentCount).toBe(reference.documentCount)
    expect(frozen.search('zen art', { combineWith: 'AND' }).length).toBeGreaterThan(0)
  })

  test('fromJSON accepts serializationVersion 1 wire entries', () => {
    const snapshot = {
      documentCount: 1,
      nextId: 1,
      documentIds: { 0: 'a' },
      fieldIds: { text: 0 },
      fieldLength: { 0: [1] },
      averageFieldLength: [1],
      storedFields: {},
      dirtCount: 2,
      index: [
        ['hello', { 0: { ds: { 0: 1 } } }],
      ],
      serializationVersion: 1,
    }
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] })
    expect(frozen.search('hello').map(r => r.id)).toEqual(['a'])
  })

  test('fromJSON remaps sparse shortIds with gaps', () => {
    const snapshot = {
      documentCount: 2,
      nextId: 3,
      documentIds: { 0: 'a', 2: 'c' },
      fieldIds: { t: 0 },
      fieldLength: { 0: [1], 2: [1] },
      averageFieldLength: [1],
      storedFields: {},
      index: [
        ['alpha', { 0: { 0: 1 } }],
        ['gamma', { 0: { 2: 1 } }],
      ],
      serializationVersion: 2,
    }
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['t'] })
    expect(frozen.search('alpha').map(r => r.id)).toEqual(['a'])
    expect(frozen.search('gamma').map(r => r.id)).toEqual(['c'])
  })

  test('fromJSON ignores postings for discarded shortIds in dirty snapshots', () => {
    const snapshot = {
      documentCount: 2,
      nextId: 3,
      documentIds: { 0: 'a', 2: 'c' },
      fieldIds: { t: 0 },
      fieldLength: { 0: [1], 2: [1] },
      averageFieldLength: [1],
      storedFields: {},
      dirtCount: 1,
      index: [
        ['alpha', { 0: { 0: 1, 1: 1 } }],
        ['gamma', { 0: { 2: 1 } }],
      ],
      serializationVersion: 2,
    }
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['t'] })
    expect(frozen.search('alpha').map(r => r.id)).toEqual(['a'])
    expect(frozen.search('gamma').map(r => r.id)).toEqual(['c'])
  })

  test('fromJSON loads an empty snapshot', () => {
    const snapshot = {
      documentCount: 0,
      nextId: 0,
      documentIds: {},
      fieldIds: { text: 0 },
      fieldLength: {},
      averageFieldLength: [0],
      storedFields: {},
      index: [],
      serializationVersion: 2,
    }
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] })
    expect(frozen.documentCount).toBe(0)
    expect(frozen.search('anything')).toEqual([])
  })

  test('fromJSON rejects unsupported serializationVersion', () => {
    const snapshot = validSnapshot({ serializationVersion: 99 })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/unsupported MiniSearch serializationVersion 99/)
  })

  test('fromJSON rejects fields that do not match the snapshot', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const json = JSON.stringify(reference)
    expect(() => FrozenMiniSearch.fromJSON(json, { fields: ['title'] }))
      .toThrow(/option "fields" must match/)
  })

  test('fromJSON rejects a non-integer posting docId key', () => {
    const snapshot = validSnapshot({
      index: [['hello', { 0: { oops: 1 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot/)
  })

  test('fromJSON rejects a partially numeric posting docId key', () => {
    const snapshot = validSnapshot({
      index: [['hello', { 0: { '0abc': 1 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot/)
  })

  test('fromJSON rejects a posting docId outside nextId', () => {
    const snapshot = validSnapshot({
      index: [['hello', { 0: { 99: 1 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index shortId 99 must be < nextId 1/)
  })

  test('fromJSON rejects malformed index entries', () => {
    const snapshot = validSnapshot({
      index: ['hello'],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot|FrozenTermIndex/)
  })

  test('fromJSON rejects duplicate index terms', () => {
    const snapshot = validSnapshot({
      index: [
        ['hello', { 0: { 0: 1 } }],
        ['hello', { 0: { 0: 1 } }],
      ],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot|FrozenTermIndex/)
  })

  test('fromJSON rejects malformed documentIds keys', () => {
    const snapshot = validSnapshot({
      documentIds: { oops: 'a' },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentIds key "oops"/)
  })

  test('fromJSON rejects empty documentIds keys', () => {
    const snapshot = validSnapshot({
      documentIds: { '': 'a' },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentIds key "" must be a non-negative integer/)
  })

  test('fromJSON rejects leading-zero documentIds keys', () => {
    const snapshot = validSnapshot({
      documentIds: { '01': 'a' },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentIds key "01" must be a non-negative integer/)
  })

  test('fromJSON rejects documentIds keys above MAX_SAFE_INTEGER', () => {
    const snapshot = validSnapshot({
      documentIds: { '9007199254740993': 'a' },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentIds key "9007199254740993" must be a non-negative integer/)
  })

  test('fromJSON rejects fieldIds outside the field count', () => {
    const snapshot = validSnapshot({
      fieldIds: { text: 1 },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: fieldIds.text must be < field count 1/)
  })

  test('fromJSON rejects malformed fieldLength rows', () => {
    const snapshot = validSnapshot({
      fieldLength: { 0: 1 },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: fieldLength shortId 0 must be an array/)
  })

  test('fromJSON rejects non-object snapshot root', () => {
    expect(() => FrozenMiniSearch.fromJSON('null', { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: snapshot must be an object/)
    expect(() => FrozenMiniSearch.fromJSON('[]', { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: snapshot must be an object/)
  })

  test('fromJSON rejects non-integer documentCount and nextId', () => {
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(validSnapshot({ documentCount: 1.5 })), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentCount must be a non-negative integer/)
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(validSnapshot({ nextId: -1 })), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: nextId must be a non-negative integer/)
  })

  test('fromJSON rejects documentCount greater than nextId', () => {
    const snapshot = validSnapshot({ documentCount: 2, nextId: 1 })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentCount 2 must be <= nextId 1/)
  })

  test('fromJSON rejects documentIds count greater than documentCount', () => {
    const snapshot = validSnapshot({
      documentCount: 1,
      nextId: 3,
      documentIds: { 0: 'a', 1: 'b' },
      fieldLength: { 0: [1], 1: [1] },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentIds count 2 must be <= documentCount 1/)
  })

  test('fromJSON rejects duplicate and incomplete fieldIds', () => {
    const dup = validSnapshot({
      fieldIds: { a: 0, b: 0 },
      fieldLength: { 0: [1] },
      averageFieldLength: [1, 1],
      index: [['hello', { 0: { 0: 1 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(dup), { fields: ['a', 'b'] }))
      .toThrow(/invalid MiniSearch snapshot: fieldId 0 is assigned more than once/)
  })

  test('fromJSON rejects storedFields and fieldLength shortIds missing from documentIds', () => {
    const sparse = {
      ...validSnapshot(),
      nextId: 2,
      documentCount: 1,
      documentIds: { 0: 'a' },
      fieldLength: { 0: [1] },
    }
    const stored = { ...sparse, storedFields: { 1: { txt: 'x' } } }
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(stored), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: storedFields shortId 1 is missing from documentIds/)

    const lengths = { ...sparse, fieldLength: { 0: [1], 1: [1] } }
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(lengths), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: fieldLength shortId 1 is missing from documentIds/)
  })

  test('fromJSON rejects malformed averageFieldLength and index', () => {
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(validSnapshot({ averageFieldLength: 1 })), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: averageFieldLength must be an array/)
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(validSnapshot({
      averageFieldLength: [1, 1],
    })), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: averageFieldLength length must equal field count 1/)
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(validSnapshot({
      averageFieldLength: [-1],
    })), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: averageFieldLength field 0 must be a non-negative number/)
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(validSnapshot({ index: 'bad' })), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index must be an array/)
  })

  test('fromJSON rejects incomplete fieldLength coverage and invalid frequencies', () => {
    const snapshot = validSnapshot({ fieldLength: {} })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: fieldLength must cover all 1 active documents/)

    const badFreq = validSnapshot({
      index: [['hello', { 0: { 0: 0 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(badFreq), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index posting frequency must be a positive integer/)
  })

  test('fromJSON accepts serializationVersion 1 entries without ds wrapper', () => {
    const snapshot = validSnapshot({
      serializationVersion: 1,
      index: [['hello', { 0: { 0: 1 } }]],
    })
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] })
    expect(frozen.search('hello').map(r => r.id)).toEqual(['a'])
  })

  test('fromJSON postings layout matches fromDocuments', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const fromJSON = FrozenMiniSearch.fromJSON(JSON.stringify(reference), options)
    const fromDocs = FrozenMiniSearch.fromDocuments(docs, options)

    expect(frozenMemoryBreakdown(fromJSON).postings).toEqual(frozenMemoryBreakdown(fromDocs).postings)
    expect(fromJSON.termCount).toBe(fromDocs.termCount)
    expect(fromJSON.search('zen art', { combineWith: 'AND' }).map(r => r.id))
      .toEqual(fromDocs.search('zen art', { combineWith: 'AND' }).map(r => r.id))
  })

  test('fromJSON frozen toJSON round-trip is deterministic and search-equivalent', () => {
    const direct = FrozenMiniSearch.fromDocuments(docs, options)
    const snapshot = JSON.stringify(direct.toJSON())
    const viaJsonA = FrozenMiniSearch.fromJSON(snapshot, options)
    const viaJsonB = FrozenMiniSearch.fromJSON(snapshot, options)
    const a = Buffer.from(viaJsonA.saveBinarySync())
    const b = Buffer.from(viaJsonB.saveBinarySync())
    expect(a.equals(b)).toBe(true)
    expect(viaJsonA.search('zen art', { combineWith: 'AND' }).map(r => r.id))
      .toEqual(direct.search('zen art', { combineWith: 'AND' }).map(r => r.id))
  })
})
