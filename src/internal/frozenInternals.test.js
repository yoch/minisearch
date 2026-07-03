import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../FrozenMiniSearch'
import { buildFrozenAssembleParamsFromMiniSearchSnapshot, parseSnapshotIndex } from '../fromMiniSearch'
import { defaultAutoSuggestOptions } from '../searchDefaults'
import {
  frozenAssembleWithCtor,
  frozenFromMiniSearch,
} from '../../testSupport/frozenImportHelpers'
import {
  executeRaw,
  finalizeRaw,
  frozenPostings,
  mergedAutoSuggestOptions,
} from './frozenInternals'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title'],
  searchOptions: { prefix: true },
  autoSuggestOptions: { prefix: true },
}

function assembleParams() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  return buildFrozenAssembleParamsFromMiniSearchSnapshot(mutable.toJSON(), options)
}

describe('frozenInternals helpers', () => {
  test('frozenAssembleWithCtor rejects fieldLengthMatrix size mismatch', () => {
    const params = assembleParams()
    params.fieldLengthMatrix = new Uint8Array(1)
    expect(() => frozenAssembleWithCtor(params, false, 'minisearch-json', FrozenMiniSearch))
      .toThrow(/fieldLengthMatrix size mismatch/)
  })

  test('frozenAssembleWithCtor rejects avgFieldLength size mismatch', () => {
    const params = assembleParams()
    params.avgFieldLength = new Float32Array(99)
    expect(() => frozenAssembleWithCtor(params, false, 'minisearch-json', FrozenMiniSearch))
      .toThrow(/avgFieldLength size mismatch/)
  })

  test('frozenAssembleWithCtor trustedSource skips postings validation', () => {
    const params = assembleParams()
    const badDocIds = new Uint32Array(params.postings.allDocIds)
    badDocIds[0] = params.nextId
    params.postings = { ...params.postings, allDocIds: badDocIds }

    expect(() => frozenAssembleWithCtor(params, false, 'minisearch-json', FrozenMiniSearch))
      .toThrow(/posting docId/)

    const trusted = frozenAssembleWithCtor(params, true, 'minisearch-json', FrozenMiniSearch)
    expect(trusted.termCount).toBe(params.termCount)
  })

  test('parseSnapshotIndex builds postings for every snapshot term', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const snapshot = mutable.toJSON()
    const parsed = parseSnapshotIndex(snapshot, options.fields.length, snapshot.nextId)
    expect(parsed.termCount).toBe(snapshot.index.length)
    const postings = parsed.accumulator.finalize(parsed.termCount, snapshot.nextId)
    expect(postings.termCount).toBe(parsed.termCount)
    expect(postings.allDocIds.length).toBeGreaterThan(0)
  })

  test('executeRaw + finalizeRaw matches frozen.search', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const engine = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const query = 'ishmael'
    const searchOptions = { prefix: true }
    const raw = executeRaw(engine, query, searchOptions)
    const decomposed = finalizeRaw(engine, raw, query, searchOptions)
    expect(decomposed).toEqual(engine.search(query, searchOptions))
  })

  test('frozenPostings exposes the live postings layout', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const postings = frozenPostings(frozen)
    expect(postings.termCount).toBe(frozen.termCount)
    expect(postings.layout).toMatch(/^(dense|sparse)$/)
    expect(postings.allDocIds.length).toBe(postings.allFreqs.length)
  })

  test('mergedAutoSuggestOptions layers overrides on frozen defaults', () => {
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    expect(mergedAutoSuggestOptions(frozen)).toEqual({
      ...defaultAutoSuggestOptions,
      prefix: true,
    })
    expect(mergedAutoSuggestOptions(frozen, { fuzzy: 0.2 })).toEqual({
      ...defaultAutoSuggestOptions,
      prefix: true,
      fuzzy: 0.2,
    })
    expect(mergedAutoSuggestOptions(frozen, { prefix: false }).prefix).toBe(false)
  })
})
