import { IncrementalPostingsAccumulator } from './incrementalPostings'
import { choosePostingsLayout, collectDocIdsFromFrozenLayout, validateFrozenPostingsLayout } from './frozenPostings'
import { shouldSeekAllowedDocs } from './compactPostings'

function buildLayout(fieldCount, postings, nextId = 10) {
  const acc = new IncrementalPostingsAccumulator(fieldCount)
  for (const { termIndex, fieldId, docId, freq } of postings) {
    acc.append(termIndex, fieldId, docId, freq)
  }
  const termCount = postings.reduce((m, p) => Math.max(m, p.termIndex + 1), 0)
  return acc.finalize(termCount, nextId)
}

function expectValidateFail(layout, documentCount, nextId, message) {
  expect(() => validateFrozenPostingsLayout(layout, documentCount, nextId))
    .toThrow(message)
}

describe('choosePostingsLayout', () => {
  test('single field prefers dense when slots have postings', () => {
    expect(choosePostingsLayout(1, 100, 50)).toBe('dense')
  })

  test('zero non-empty slots prefers sparse metadata', () => {
    // denseBytes = 100 * 1 * 8 = 800; sparseBytes = 101 * 4 = 404
    expect(choosePostingsLayout(1, 100, 0)).toBe('sparse')
  })

  test('tie on metadata bytes prefers dense', () => {
    // denseBytes = 2 * 3 * 8 = 48
    // sparseBytes = 3 * 4 + 4 * (1 + 8) = 12 + 36 = 48
    expect(choosePostingsLayout(3, 2, 4)).toBe('dense')
  })

  test('multi-field dense when most slots are non-empty', () => {
    // 3 terms x 4 fields, all 12 slots filled
    // denseBytes = 3 * 4 * 8 = 96
    // sparseBytes = 4 * 4 + 12 * (1 + 8) = 16 + 108 = 124
    expect(choosePostingsLayout(4, 3, 12)).toBe('dense')
  })

  test('multi-field sparse when few slots are non-empty', () => {
    // 10 terms x 4 fields, 3 non-empty slots
    // denseBytes = 10 * 4 * 8 = 320
    // sparseBytes = 11 * 4 + 3 * (1 + 8) = 44 + 27 = 71
    expect(choosePostingsLayout(4, 10, 3)).toBe('sparse')
  })

  test('uses 16-bit sparse field ids when fieldCount exceeds 255', () => {
    // denseBytes = 1 * 256 * 8 = 2048
    // sparseBytes = 2 * 4 + 1 * (2 + 8) = 8 + 10 = 18
    expect(choosePostingsLayout(256, 1, 1)).toBe('sparse')
  })

  test('empty term count prefers dense', () => {
    expect(choosePostingsLayout(4, 0, 0)).toBe('dense')
  })
})

describe('validateFrozenPostingsLayout', () => {
  const densePostings = [
    { termIndex: 0, fieldId: 0, docId: 1, freq: 2 },
    { termIndex: 1, fieldId: 0, docId: 0, freq: 1 },
  ]
  const sparsePostings = [
    { termIndex: 0, fieldId: 0, docId: 1, freq: 1 },
    { termIndex: 0, fieldId: 2, docId: 1, freq: 3 },
    { termIndex: 1, fieldId: 1, docId: 0, freq: 2 },
  ]

  test('accepts valid dense and sparse layouts', () => {
    validateFrozenPostingsLayout(buildLayout(1, densePostings), 2, 10)
    validateFrozenPostingsLayout(buildLayout(4, sparsePostings), 2, 10)
  })

  test('rejects non-positive fieldCount', () => {
    const layout = buildLayout(1, densePostings)
    expectValidateFail({ ...layout, fieldCount: 0 }, 2, 10, /fieldCount must be positive/)
  })

  test('rejects nextId mismatch', () => {
    const layout = buildLayout(1, densePostings)
    expectValidateFail(layout, 2, 11, /nextId mismatch/)
  })

  test('rejects negative termCount', () => {
    const layout = buildLayout(1, densePostings)
    expectValidateFail({ ...layout, termCount: -1 }, 2, 10, /termCount out of range/)
  })

  test('rejects allDocIds / allFreqs length mismatch', () => {
    const layout = buildLayout(1, densePostings)
    const shortFreqs = layout.allFreqs.subarray(0, layout.allFreqs.length - 1)
    expectValidateFail({ ...layout, allFreqs: shortFreqs }, 2, 10, /length mismatch/)
  })

  test('rejects dense slot metadata length mismatch', () => {
    const layout = buildLayout(1, densePostings)
    expectValidateFail({
      ...layout,
      denseOffsets: layout.denseOffsets.subarray(0, layout.denseOffsets.length - 1),
    }, 2, 10, /dense postings slot count mismatch/)
  })

  test('rejects dense posting slot past allDocIds bounds', () => {
    const layout = buildLayout(1, densePostings)
    const denseLengths = new Uint32Array(layout.denseLengths)
    denseLengths[0] = layout.allDocIds.length + 1
    expectValidateFail({ ...layout, denseLengths }, 2, 10, /exceeds allDocIds bounds/)
  })

  test('rejects dense posting docId >= nextId', () => {
    const layout = buildLayout(1, [{ termIndex: 0, fieldId: 0, docId: 10, freq: 1 }], 10)
    expectValidateFail(layout, 9, 10, /posting docId 10 >= nextId 10/)
  })

  test('rejects sparse sparseFieldIdWidth mismatch', () => {
    const layout = buildLayout(4, sparsePostings)
    expect(layout.layout).toBe('sparse')
    expectValidateFail({ ...layout, sparseFieldIdWidth: 16 }, 2, 10, /sparseFieldIdWidth mismatch/)
  })

  test('rejects sparse sparseTermStarts length mismatch', () => {
    const layout = buildLayout(4, sparsePostings)
    expectValidateFail({
      ...layout,
      sparseTermStarts: layout.sparseTermStarts.subarray(0, layout.sparseTermStarts.length - 1),
    }, 2, 10, /sparseTermStarts length mismatch/)
  })

  test('rejects sparse metadata slot count mismatch', () => {
    const layout = buildLayout(4, sparsePostings)
    expectValidateFail({
      ...layout,
      sparseOffsets: layout.sparseOffsets.subarray(0, layout.sparseOffsets.length - 1),
    }, 2, 10, /sparse slot count mismatch/)
  })

  test('rejects sparse fieldId >= fieldCount', () => {
    const layout = buildLayout(4, sparsePostings)
    const fieldIds = layout.sparseFieldIds instanceof Uint16Array
      ? new Uint16Array(layout.sparseFieldIds)
      : new Uint8Array(layout.sparseFieldIds)
    fieldIds[0] = 4
    expectValidateFail({ ...layout, sparseFieldIds: fieldIds }, 2, 10, /sparse fieldId 4 >= fieldCount 4/)
  })

  test('rejects sparse slot past allDocIds bounds', () => {
    const layout = buildLayout(4, sparsePostings)
    const sparseLengths = new Uint32Array(layout.sparseLengths)
    sparseLengths[0] = layout.allDocIds.length + 1
    expectValidateFail({ ...layout, sparseLengths }, 2, 10, /sparse slot 0 exceeds allDocIds bounds/)
  })

  test('rejects sparse posting docId >= nextId', () => {
    const layout = buildLayout(4, [{ termIndex: 0, fieldId: 0, docId: 10, freq: 1 }], 10)
    expectValidateFail(layout, 9, 10, /posting docId 10 >= nextId 10/)
  })

  test('rejects documentCount inconsistent with nextId', () => {
    const layout = buildLayout(1, densePostings)
    expectValidateFail(layout, 11, 10, /documentCount inconsistent with nextId/)
  })

  test('routes failures through custom fail callback', () => {
    const layout = buildLayout(1, densePostings)
    const fail = vi.fn((detail) => { throw new Error(`custom:${detail}`) })
    expect(() => validateFrozenPostingsLayout(layout, 11, 10, fail)).toThrow(/custom:documentCount/)
    expect(fail).toHaveBeenCalled()
  })
})

function collectDocIds(layout, termIndex, fieldBoosts, context, allowedDocs) {
  const docIds = new Set()
  collectDocIdsFromFrozenLayout(layout, termIndex, fieldBoosts, context, docIds, allowedDocs)
  return [...docIds].sort((a, b) => a - b)
}

function makeCollectContext(fieldIds, documentCount = 10) {
  return {
    documentCount,
    avgFieldLength: new Float32Array(Object.keys(fieldIds).length || 1),
    fieldIds,
    getFieldLength: () => 5,
    getExternalId: docId => docId,
    resolveTermByIndex: () => '',
    getStoredFields: () => undefined,
  }
}

function rangePostings(termIndex, fieldId, from, to) {
  const postings = []
  for (let docId = from; docId <= to; docId++) {
    postings.push({ termIndex, fieldId, docId, freq: 1 })
  }
  return postings
}

describe('collectDocIdsFromFrozenLayout', () => {
  test('dense layout unions doc ids across boosted fields for one term', () => {
    const layout = buildLayout(2, [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 1 },
      { termIndex: 0, fieldId: 0, docId: 3, freq: 1 },
      { termIndex: 0, fieldId: 1, docId: 2, freq: 1 },
      { termIndex: 0, fieldId: 1, docId: 4, freq: 1 },
    ])
    expect(layout.layout).toBe('dense')

    const context = makeCollectContext({ a: 0, b: 1 })
    const fieldBoosts = { names: ['a', 'b'], boosts: { a: 1, b: 1 } }
    expect(collectDocIds(layout, 0, fieldBoosts, context)).toEqual([1, 2, 3, 4])
  })

  test('sparse layout unions doc ids across boosted fields for one term', () => {
    const layout = buildLayout(4, [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 1 },
      { termIndex: 0, fieldId: 2, docId: 1, freq: 3 },
      { termIndex: 0, fieldId: 2, docId: 5, freq: 2 },
    ])
    expect(layout.layout).toBe('sparse')

    const context = makeCollectContext({ f0: 0, f2: 2 })
    const fieldBoosts = { names: ['f0', 'f2'], boosts: { f0: 1, f2: 1 } }
    expect(collectDocIds(layout, 0, fieldBoosts, context)).toEqual([1, 5])
  })

  test('empty allowedDocs gate collects nothing', () => {
    const layout = buildLayout(1, [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 1 },
      { termIndex: 0, fieldId: 0, docId: 2, freq: 1 },
    ])
    const context = makeCollectContext({ txt: 0 })
    const fieldBoosts = { names: ['txt'], boosts: { txt: 1 } }
    expect(collectDocIds(layout, 0, fieldBoosts, context, new Set())).toEqual([])
  })

  test('long postings use seek path and honor selective allowedDocs', () => {
    const layout = buildLayout(1, rangePostings(0, 0, 0, 2999), 3000)
    const postingLength = layout.denseLengths[0]
    const allowed = new Set([5, 100, 999])
    expect(shouldSeekAllowedDocs(allowed.size, postingLength)).toBe(true)

    const context = makeCollectContext({ txt: 0 }, 3000)
    const fieldBoosts = { names: ['txt'], boosts: { txt: 1 } }
    expect(collectDocIds(layout, 0, fieldBoosts, context, allowed)).toEqual([5, 100, 999])
  })

  test('short postings use scan path and honor selective allowedDocs', () => {
    const layout = buildLayout(1, rangePostings(0, 0, 0, 99), 100)
    const postingLength = layout.denseLengths[0]
    const allowed = new Set([4, 40, 41, 42])
    expect(shouldSeekAllowedDocs(allowed.size, postingLength)).toBe(false)

    const context = makeCollectContext({ txt: 0 }, 100)
    const fieldBoosts = { names: ['txt'], boosts: { txt: 1 } }
    expect(collectDocIds(layout, 0, fieldBoosts, context, allowed)).toEqual([4, 40, 41, 42])
  })

  test('skips fields omitted from fieldBoosts', () => {
    const layout = buildLayout(2, [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 1 },
      { termIndex: 0, fieldId: 1, docId: 2, freq: 1 },
    ])
    const context = makeCollectContext({ a: 0, b: 1 })
    const fieldBoosts = { names: ['a'], boosts: { a: 1 } }
    expect(collectDocIds(layout, 0, fieldBoosts, context)).toEqual([1])
  })
})
