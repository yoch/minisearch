import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MiniSearch from 'minisearch'
import FrozenMiniSearch, { freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { frozenMemoryBreakdown } from '../testSupport/frozenMemoryBreakdown.js'
import { frozenFromMiniSearch } from '../testSupport/frozenImportHelpers'
import { createFrozenIndexBuilder } from './frozenBuild'
import { MAX_FREQ, readDocId } from './compactPostings'
import { IncrementalPostingsAccumulator, nextGrowableCapacity, simulateColumnGrowth } from './incrementalPostings'
import {
  createFrozenFieldTermFlyweight,
  validateFrozenPostingsLayout,
} from './frozenPostings'

/** Each (term, field) slot occupies one contiguous [offset, offset+length) in global SoA buffers. */
function assertSegmentsPartitionBuffers(layout) {
  expect(layout.allDocIds.length).toBe(layout.allFreqs.length)

  if (layout.layout === 'dense') {
    const slotCount = layout.termCount * layout.fieldCount
    let write = 0
    for (let slot = 0; slot < slotCount; slot++) {
      expect(layout.denseOffsets[slot]).toBe(write)
      write += layout.denseLengths[slot]
    }
    expect(write).toBe(layout.allDocIds.length)
    return
  }

  let write = 0
  for (let i = 0; i < layout.sparseOffsets.length; i++) {
    expect(layout.sparseOffsets[i]).toBe(write)
    write += layout.sparseLengths[i]
  }
  expect(write).toBe(layout.allDocIds.length)
}

/** Hot path: flyweight segment is a single sequential scan over allDocIds[offset+i]. */
function assertHotPathSequentialAccess(layout, termIndex, fieldId) {
  const fly = createFrozenFieldTermFlyweight(layout).bind(termIndex)
  const seg = fly.get(fieldId)
  if (seg == null) return
  const walked = []
  seg.forEachDoc((docId, freq) => walked.push({ docId, freq }))
  expect(seg.length).toBe(walked.length)
  for (let i = 0; i < seg.length; i++) {
    expect(readDocId(seg.docIds, seg.offset + i)).toBe(walked[i].docId)
    expect(seg.freqs[seg.offset + i]).toBe(walked[i].freq)
  }
}

function buildIncremental(fieldCount, postings, nextId = 100) {
  const acc = new IncrementalPostingsAccumulator(fieldCount)
  for (const { termIndex, fieldId, docId, freq } of postings) {
    acc.append(termIndex, fieldId, docId, freq)
  }
  const termCount = postings.reduce((m, p) => Math.max(m, p.termIndex + 1), 0)
  return acc.finalize(termCount, nextId)
}

describe('IncrementalPostingsAccumulator', () => {
  test('dense layout', () => {
    const postings = [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 2 },
      { termIndex: 0, fieldId: 0, docId: 3, freq: 1 },
      { termIndex: 1, fieldId: 0, docId: 0, freq: 4 },
      { termIndex: 1, fieldId: 0, docId: 2, freq: 1 },
    ]
    const layout = buildIncremental(1, postings)
    expect(layout.layout).toBe('dense')
    validateFrozenPostingsLayout(layout, 100, 100)
    assertSegmentsPartitionBuffers(layout)
  })

  test('sparse layout when sparse is cheaper', () => {
    const postings = [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 1 },
      { termIndex: 0, fieldId: 2, docId: 1, freq: 3 },
      { termIndex: 1, fieldId: 1, docId: 0, freq: 2 },
      { termIndex: 1, fieldId: 3, docId: 4, freq: 1 },
      { termIndex: 2, fieldId: 0, docId: 2, freq: 5 },
    ]
    const layout = buildIncremental(4, postings)
    expect(layout.layout).toBe('sparse')
    validateFrozenPostingsLayout(layout, 100, 100)
    assertSegmentsPartitionBuffers(layout)
  })

  test('multi-field dense layout is selected when dense metadata is cheaper', () => {
    const postings = []
    for (let termIndex = 0; termIndex < 3; termIndex++) {
      for (let fieldId = 0; fieldId < 4; fieldId++) {
        postings.push({ termIndex, fieldId, docId: termIndex, freq: fieldId + 1 })
      }
    }
    const layout = buildIncremental(4, postings)
    expect(layout.layout).toBe('dense')
    validateFrozenPostingsLayout(layout, 100, 100)
    assertSegmentsPartitionBuffers(layout)
    assertHotPathSequentialAccess(layout, 1, 2)
  })

  test('dense metadata uses adaptive index widths', () => {
    const layout = buildIncremental(1, [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 2 },
      { termIndex: 1, fieldId: 0, docId: 2, freq: 3 },
    ], 10)

    expect(layout.layout).toBe('dense')
    expect(layout.denseOffsets).toBeInstanceOf(Uint8Array)
    expect(layout.denseLengths).toBeInstanceOf(Uint8Array)
    assertSegmentsPartitionBuffers(layout)
  })

  test('interleaved appends per slot preserve order', () => {
    const postings = [
      { termIndex: 0, fieldId: 1, docId: 0, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 1, freq: 2 },
      { termIndex: 0, fieldId: 1, docId: 2, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 3, freq: 1 },
    ]
    const layout = buildIncremental(3, postings)
    validateFrozenPostingsLayout(layout, 100, 100)
    assertHotPathSequentialAccess(layout, 0, 1)
    assertHotPathSequentialAccess(layout, 5, 0)
  })

  test('finalize clamps frequencies to MAX_FREQ', () => {
    const layout = buildIncremental(1, [{ termIndex: 0, fieldId: 0, docId: 0, freq: MAX_FREQ + 50 }])
    expect(layout.allFreqs[0]).toBe(MAX_FREQ)
  })

  test('fromMiniSearch and incremental builder choose the same dense layout', () => {
    const fields = ['f0', 'f1', 'f2', 'f3']
    const documents = Array.from({ length: 4 }, (_, id) => ({
      id,
      f0: `term${id} common`,
      f1: `term${id} common`,
      f2: `term${id} common`,
      f3: `term${id} common`,
    }))
    const options = { fields, storeFields: [] }
    const mutable = new MiniSearch(options)
    mutable.addAll(documents)

    const fromMiniSearch = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const fromDocuments = FrozenMiniSearch.fromDocuments(documents, options)

    expect(frozenMemoryBreakdown(fromMiniSearch).postings.layout).toBe('dense')
    expect(frozenMemoryBreakdown(fromDocuments).postings.layout).toBe('dense')
    expect(searchSnapshot(fromDocuments, 'term2')).toEqual(searchSnapshot(fromMiniSearch, 'term2'))
  })

  test('builder avoids duplicate-id Set while numeric ids stay dense', () => {
    const builder = createFrozenIndexBuilder({ fields: ['text'], storeFields: [] }, {
      estimatedDocumentCount: 3,
    })

    builder.add({ id: 0, text: 'alpha' })
    builder.add({ id: 1, text: 'beta' })
    builder.add({ id: 2, text: 'gamma' })

    expect(builder._seenIds).toBeUndefined()
  })

  test('builder switches to duplicate-id Set when ids stop being dense', () => {
    const builder = createFrozenIndexBuilder({ fields: ['text'], storeFields: [] })

    builder.add({ id: 0, text: 'alpha' })
    builder.add({ id: 1, text: 'beta' })
    builder.add({ id: 'doc-2', text: 'gamma' })

    expect(builder._seenIds).toBeInstanceOf(Set)
    expect(builder._seenIds.size).toBe(3)
    expect(builder._seenIds.has(0)).toBe(true)
    expect(builder._seenIds.has(1)).toBe(true)
    expect(builder._seenIds.has('doc-2')).toBe(true)
  })

  test('builder catches duplicate ids before and after dense-id switch', () => {
    const duplicateDense = createFrozenIndexBuilder({ fields: ['text'], storeFields: [] })
    duplicateDense.add({ id: 0, text: 'alpha' })
    expect(() => duplicateDense.add({ id: 0, text: 'beta' }))
      .toThrow(/duplicate ID 0/)

    const duplicateString = createFrozenIndexBuilder({ fields: ['text'], storeFields: [] })
    duplicateString.add({ id: 0, text: 'alpha' })
    duplicateString.add({ id: 'doc-1', text: 'beta' })
    expect(() => duplicateString.add({ id: 'doc-1', text: 'gamma' }))
      .toThrow(/duplicate ID doc-1/)
  })

  test('non-contiguous scratch ranges compact to one hot-path segment', () => {
    const acc = new IncrementalPostingsAccumulator(1)
    acc.append(0, 0, 1, 1)
    acc.append(0, 0, 3, 2)
    acc.append(1, 0, 0, 1) // other slot between same-slot appends
    acc.append(0, 0, 5, 1)
    const layout = acc.finalize(2, 10)
    validateFrozenPostingsLayout(layout, 10, 10)
    assertSegmentsPartitionBuffers(layout)
    assertHotPathSequentialAccess(layout, 0, 0)
    const fly = createFrozenFieldTermFlyweight(layout).bind(0)
    const seg = fly.get(0)
    expect(seg.length).toBe(3)
    const docIds = []
    seg.forEachDoc(docId => docIds.push(docId))
    expect(docIds).toEqual([1, 3, 5])
  })

  test('interleaved scratch compacts to contiguous hot-path segments (sparse)', () => {
    const postings = [
      { termIndex: 0, fieldId: 1, docId: 0, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 1, freq: 2 },
      { termIndex: 0, fieldId: 1, docId: 2, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 3, freq: 1 },
    ]
    const layout = buildIncremental(3, postings)
    validateFrozenPostingsLayout(layout, 100, 100)
    assertSegmentsPartitionBuffers(layout)
    assertHotPathSequentialAccess(layout, 0, 1)
    assertHotPathSequentialAccess(layout, 5, 0)
  })

  test('sparse metadata uses adaptive index widths', () => {
    const layout = buildIncremental(20, [
      { termIndex: 0, fieldId: 1, docId: 0, freq: 1 },
      { termIndex: 1, fieldId: 3, docId: 1, freq: 1 },
      { termIndex: 2, fieldId: 5, docId: 2, freq: 1 },
    ], 10)

    expect(layout.layout).toBe('sparse')
    expect(layout.sparseTermStarts).toBeInstanceOf(Uint8Array)
    expect(layout.sparseOffsets).toBeInstanceOf(Uint8Array)
    expect(layout.sparseLengths).toBeInstanceOf(Uint8Array)
    assertSegmentsPartitionBuffers(layout)
  })

  test('uint16 doc ids when nextId fits', () => {
    const layout = buildIncremental(1, [{ termIndex: 0, fieldId: 0, docId: 65534, freq: 1 }], 65535)
    expect(layout.docIdWidth).toBe(16)
  })

  test('uint32 doc ids when nextId exceeds 65535', () => {
    const layout = buildIncremental(1, [{ termIndex: 0, fieldId: 0, docId: 70000, freq: 1 }], 70001)
    expect(layout.docIdWidth).toBe(32)
  })

  test('build scratch doc ids promote from uint16 to uint32 only past boundary', () => {
    const acc = new IncrementalPostingsAccumulator(1)
    acc.append(0, 0, 65535, 1)
    expect(acc._docIds._buf).toBeInstanceOf(Uint16Array)

    acc.append(0, 0, 65536, 1)
    expect(acc._docIds._buf).toBeInstanceOf(Uint32Array)
    expect(acc._docIds.get(0)).toBe(65535)
    expect(acc._docIds.get(1)).toBe(65536)
  })

  test('build scratch freqs promote from uint8 to uint16 only past boundary', () => {
    const acc = new IncrementalPostingsAccumulator(1)
    acc.append(0, 0, 0, 255)
    expect(acc._freqs._buf).toBeInstanceOf(Uint8Array)

    acc.append(0, 0, 1, 256)
    expect(acc._freqs._buf).toBeInstanceOf(Uint16Array)
    expect(acc._freqs.get(0)).toBe(255)
    expect(acc._freqs.get(1)).toBe(256)
  })

  test('finalize releases growable scratch buffers', () => {
    const acc = new IncrementalPostingsAccumulator(1, { estimatedTotalPostings: 64 })
    acc.append(0, 0, 1, 1)
    acc.append(0, 0, 2, 2)

    const layout = acc.finalize(1, 10)

    expect(layout.allDocIds.length).toBe(2)
    expect(acc.totalPostings).toBe(0)
    expect(acc.maxFreq).toBe(0)
    expect(acc._docIds.length).toBe(0)
    expect(acc._freqs.length).toBe(0)
    expect(acc._slotIds.length).toBe(0)
    expect(acc._docIds._buf.length).toBe(1)
    expect(acc._freqs._buf.length).toBe(1)
    expect(acc._slotIds._buf.length).toBe(1)
    expect(acc._docIds._buf).toBeInstanceOf(Uint16Array)
    expect(acc._freqs._buf).toBeInstanceOf(Uint8Array)
  })

  describe('growable capacity expansion policy', () => {
    const INITIAL_CAPACITY = 16

    test('nextGrowableCapacity doubles by default and supports ×1.5', () => {
      expect(nextGrowableCapacity(INITIAL_CAPACITY)).toBe(32)
      expect(nextGrowableCapacity(INITIAL_CAPACITY, 2)).toBe(32)
      expect(nextGrowableCapacity(INITIAL_CAPACITY, 1.5)).toBe(24)
    })

    test('production accumulator doubles column capacity on overflow', () => {
      const acc = new IncrementalPostingsAccumulator(1)
      for (let i = 0; i < INITIAL_CAPACITY + 1; i++) acc.append(0, 0, i, 1)
      expect(acc._slotIds._buf.length).toBe(INITIAL_CAPACITY * 2)
    })

    test('×1.5 vs ×2: trade-offs on representative freeze posting counts', () => {
      const elementBytes = 4 // u32 slotIds column during freeze import

      const doublingExactPowerOfTwo = simulateColumnGrowth(65_536, elementBytes, INITIAL_CAPACITY, 2)
      const gentlerExactPowerOfTwo = simulateColumnGrowth(65_536, elementBytes, INITIAL_CAPACITY, 1.5)
      // Powers of two align with ×2: zero overshoot, tighter peak than gentler steps.
      expect(doublingExactPowerOfTwo.overshoot).toBe(0)
      expect(doublingExactPowerOfTwo.peakCapacity).toBe(65_536)
      expect(gentlerExactPowerOfTwo.peakCapacity).toBeGreaterThan(doublingExactPowerOfTwo.peakCapacity)
      expect(gentlerExactPowerOfTwo.growEvents).toBeGreaterThan(doublingExactPowerOfTwo.growEvents)
      expect(gentlerExactPowerOfTwo.bytesCopied).toBeGreaterThan(doublingExactPowerOfTwo.bytesCopied)

      const denseScale = simulateColumnGrowth(300_000, elementBytes, INITIAL_CAPACITY, 2)
      const denseScaleGentler = simulateColumnGrowth(300_000, elementBytes, INITIAL_CAPACITY, 1.5)
      // Gain on dense-scale corpora: less final slack and a lower peak buffer.
      expect(denseScaleGentler.growEvents).toBeGreaterThan(denseScale.growEvents)
      expect(denseScaleGentler.bytesCopied).toBeGreaterThan(denseScale.bytesCopied)
      expect(denseScaleGentler.finalCapacity).toBeLessThan(denseScale.finalCapacity)
      expect(denseScaleGentler.overshoot).toBeLessThan(denseScale.overshoot)
      expect(denseScaleGentler.peakCapacity).toBeLessThan(denseScale.peakCapacity)

      const awkwardBand = simulateColumnGrowth(200_000, elementBytes, INITIAL_CAPACITY, 2)
      const awkwardBandGentler = simulateColumnGrowth(200_000, elementBytes, INITIAL_CAPACITY, 1.5)
      // Loss: between powers of two, gentler steps can overshoot the next ×2 plateau and waste more.
      expect(awkwardBandGentler.growEvents).toBeGreaterThan(awkwardBand.growEvents)
      expect(awkwardBandGentler.bytesCopied).toBeGreaterThan(awkwardBand.bytesCopied)
      expect(awkwardBandGentler.overshoot).toBeGreaterThan(awkwardBand.overshoot)
      expect(awkwardBandGentler.peakCapacity).toBeGreaterThan(awkwardBand.peakCapacity)
    })

    test('initial capacity sweep 16/32/64/128 closes DEFAULT_CAPACITY discussion', () => {
      const elementBytes = 4
      const sweep = [16, 32, 64, 128]

      for (const postingCount of [200_000, 300_000]) {
        const stats = sweep.map((initialCapacity) =>
          simulateColumnGrowth(postingCount, elementBytes, initialCapacity),
        )

        // Larger hints shave a few grow events but converge to the same final buffer.
        for (let i = 1; i < stats.length; i++) {
          expect(stats[i].growEvents).toBeLessThanOrEqual(stats[i - 1].growEvents)
          expect(stats[i].bytesCopied).toBeLessThanOrEqual(stats[i - 1].bytesCopied)
          expect(stats[i].finalCapacity).toBe(stats[i - 1].finalCapacity)
          expect(stats[i].overshoot).toBe(stats[i - 1].overshoot)
        }

        // Savings at scale are tiny (<0.1 % bytes copied); paired bench showed dense +4.1 % CPU at 128.
        const baseline = stats[0]
        const largest = stats[stats.length - 1]
        expect(largest.bytesCopied).toBeLessThan(baseline.bytesCopied)
        expect(baseline.bytesCopied - largest.bytesCopied).toBeLessThan(baseline.bytesCopied * 0.001)
      }

      const smallIndex = sweep.map((initialCapacity) =>
        simulateColumnGrowth(100, elementBytes, initialCapacity),
      )
      // Small snapshots pay upfront for a larger hint: same final size, more reserved from the first push.
      expect(smallIndex[0].growEvents).toBeGreaterThan(smallIndex[smallIndex.length - 1].growEvents)
      for (const row of smallIndex) {
        expect(row.finalCapacity).toBe(128)
        expect(row.overshoot).toBe(28)
      }
      expect(smallIndex[smallIndex.length - 1].bytesCopied).toBe(0)
      expect(smallIndex[0].bytesCopied).toBeGreaterThan(0)
    })
  })
})

function buildIncrementally(documents, options) {
  const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: documents.length })
  for (const doc of documents) builder.add(doc)
  return freezeFrozenIndexBuilder(builder)
}

function buildDocByDoc(documents, options) {
  const builder = createFrozenIndexBuilder(options)
  for (const doc of documents) builder.add(doc)
  return freezeFrozenIndexBuilder(builder)
}

function searchSnapshot(index, query) {
  return index.search(query).map(r => ({ id: r.id, score: r.score }))
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../testSupport/fixtures')
const DEFAULT_MEDICAMENTS_CORPUS_DIR = '/home/yoch/fr.gouv.medicaments.rest/data/corpus-export'

function parseJsonl(content) {
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

function loadJsonlFile(dir, file) {
  return parseJsonl(readFileSync(join(dir, file), 'utf8'))
}

function registerGoldenDatasetTests({ id, documents, options, query }) {
  test(`${id} doc-by-doc add matches hinted incremental build`, () => {
    const hinted = buildIncrementally(documents, options)
    const docByDoc = buildDocByDoc(documents, options)

    expect(docByDoc.termCount).toBe(hinted.termCount)
    expect(docByDoc.documentCount).toBe(hinted.documentCount)
    expect(searchSnapshot(docByDoc, query)).toEqual(searchSnapshot(hinted, query))

    const builder = createFrozenIndexBuilder(options)
    for (const doc of documents) builder.add(doc)
    const params = builder.freezeParams()
    validateFrozenPostingsLayout(params.postings, params.documentCount, params.nextId)
    assertSegmentsPartitionBuffers(params.postings)
  })

  test(`${id} incremental build round-trips through binary`, () => {
    const built = buildDocByDoc(documents, options)
    const loaded = FrozenMiniSearch.loadBinarySync(built.saveBinarySync(), options)

    expect(loaded.termCount).toBe(built.termCount)
    expect(searchSnapshot(loaded, query)).toEqual(searchSnapshot(built, query))
  })

  test(`${id} freezeParams releases builder transients after assembling params`, () => {
    const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: documents.length + 2 })
    for (const doc of documents) builder.add(doc)

    const params = builder.freezeParams()

    expect(params.documentCount).toBe(documents.length)
    expect(params.externalIds.length).toBe(documents.length)
    expect(params.fieldLengthMatrix.length).toBe(params.documentCount * params.fieldCount)
    expect(builder._externalIds).toEqual([])
    expect(builder._fieldLengthData).toEqual([])
    expect(builder._avgFieldLength).toEqual([])
    expect(builder._terms).toEqual([])
    expect(builder._seenIds).toBeUndefined()
    expect(builder._fieldTermFreqScratch.size).toBe(0)
    expect(builder._rawTokenScratch.size).toBe(0)
    expect(builder._tokenScratch).toEqual([])
  })
}

describe('IncrementalPostingsAccumulator golden (CI fixture)', () => {
  const fixtureDataset = {
    id: 'incremental-golden',
    file: 'incremental-golden.jsonl',
    options: {
      fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
      storeFields: ['id'],
    },
    query: 'doliprane',
  }
  const documents = loadJsonlFile(FIXTURES_DIR, fixtureDataset.file)
  registerGoldenDatasetTests({ ...fixtureDataset, documents })

  test('fromAsyncIterable matches doc-by-doc incremental build', async () => {
    const { default: FrozenMiniSearch } = await import('./FrozenMiniSearch')
    const options = { fields: ['txt'], storeFields: [] }
    const streamDocs = [
      { id: 'a', txt: 'alpha beta gamma' },
      { id: 'b', txt: 'beta delta' },
      { id: 'c', txt: 'gamma epsilon' },
    ]

    async function* stream() {
      for (const doc of streamDocs) yield doc
    }

    const fromStream = await FrozenMiniSearch.fromAsyncIterable(stream(), options, {
      estimatedDocumentCount: streamDocs.length,
    })
    const fromAdds = buildDocByDoc(streamDocs, options)

    expect(fromStream.termCount).toBe(fromAdds.termCount)
    expect(searchSnapshot(fromStream, 'beta')).toEqual(searchSnapshot(fromAdds, 'beta'))
  })
})

describe('IncrementalPostingsAccumulator medicaments golden (optional local)', () => {
  const corpusDir = process.env.CORPUS_EXPORT_DIR ?? DEFAULT_MEDICAMENTS_CORPUS_DIR

  const datasets = [
    {
      id: 'bdpm-generiques',
      file: 'bdpm_generiques.jsonl',
      options: { fields: ['libelle_groupe'], storeFields: ['id'] },
      query: 'cimetidine',
    },
    {
      id: 'bdpm-substances',
      file: 'bdpm_substances.jsonl',
      options: { fields: ['denomination'], storeFields: ['id'] },
      query: 'paracetamol',
    },
    {
      id: 'bdpm-specialites',
      file: 'bdpm_specialites.jsonl',
      options: {
        fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
        storeFields: ['id'],
      },
      query: 'doliprane',
    },
    {
      id: 'bdpm-presentations',
      file: 'bdpm_presentations.jsonl',
      options: {
        fields: ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
        storeFields: ['id'],
      },
      query: 'comprime',
    },
  ]

  for (const { id, file, options, query } of datasets) {
    const corpusPath = join(corpusDir, file)
    if (!existsSync(corpusPath)) {
      test.skip(`${id} doc-by-doc add matches hinted incremental build`, () => {})
      test.skip(`${id} incremental build round-trips through binary`, () => {})
      continue
    }
    const documents = loadJsonlFile(corpusDir, file)
    registerGoldenDatasetTests({ id, documents, options, query })
  }
})
