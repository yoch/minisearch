import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenFromMiniSearch } from '../testSupport/frozenImportHelpers'
import FrozenMiniSearchBrowser, {
  buildFrozenFromDocuments,
  freezeFrozenIndexBuilder,
} from './FrozenMiniSearchBrowser'
import { createFrozenIndexBuilder } from './frozenBuild'
import { CODEC_ZSTD, MSV5_PAYLOAD_CODEC_OFFSET } from './msv5/binaryMsv5Constants'
import { decodeFrozenSnapshotMsv5Browser } from './msv5/binaryMsv5DecodeBrowser'
import { encodeFrozenSnapshotMsv5Browser } from './msv5/binaryMsv5EncodeBrowser'

const options = { fields: ['title', 'text'], storeFields: ['title'] }
const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' },
]

describe('FrozenMiniSearchBrowser', () => {
  test('fromDocuments search and stored fields', () => {
    const index = FrozenMiniSearchBrowser.fromDocuments(docs, options)
    expect(index.search('hello').map(hit => hit.id)).toEqual([1])
    expect(index.getStoredFields(1)).toEqual({ title: 'hello' })
  })

  test('buildFrozenFromDocuments matches fromDocuments', () => {
    const built = buildFrozenFromDocuments(docs, options)
    const direct = FrozenMiniSearchBrowser.fromDocuments(docs, options)
    expect(built.search('hello').map(hit => hit.id)).toEqual(direct.search('hello').map(hit => hit.id))
    expect(built.getStoredFields(1)).toEqual({ title: 'hello' })
  })

  test('freezeFrozenIndexBuilder matches fromDocuments', () => {
    const builder = createFrozenIndexBuilder(options)
    for (const doc of docs) builder.add(doc)
    const built = freezeFrozenIndexBuilder(builder)
    const direct = FrozenMiniSearchBrowser.fromDocuments(docs, options)
    expect(built.search('zen', { prefix: true }).map(hit => hit.id))
      .toEqual(direct.search('zen', { prefix: true }).map(hit => hit.id))
    expect(built.getStoredFields(2)).toEqual({ title: 'zen' })
  })

  test.each(['raw', 'zlib', 'auto'])('saveBinaryAsync + loadBinaryAsync (%s)', async (compression) => {
    const index = FrozenMiniSearchBrowser.fromDocuments(docs, options)
    const buf = await index.saveBinaryAsync({ compression })
    expect(buf).toBeInstanceOf(Uint8Array)
    const loaded = await FrozenMiniSearchBrowser.loadBinaryAsync(buf, options)
    expect(loaded.search('zen', { prefix: true }).map(hit => hit.id)).toEqual([2])
  })

  test('Node zlib snapshot loads in browser decode path', async () => {
    const nodeIndex = FrozenMiniSearch.fromDocuments(docs, options)
    const buf = new Uint8Array(nodeIndex.saveBinarySync({ compression: 'zlib' }))
    const loaded = await FrozenMiniSearchBrowser.loadBinaryAsync(buf, options)
    expect(loaded.search('world', { prefix: true }).map(hit => hit.id)).toEqual([1])
  })

  test('browser zlib snapshot loads in Node', async () => {
    const browserIndex = FrozenMiniSearchBrowser.fromDocuments(docs, options)
    const buf = Buffer.from(await browserIndex.saveBinaryAsync({ compression: 'zlib' }))
    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
    expect(loaded.search('archery', { prefix: true }).map(hit => hit.id)).toEqual([2])
  })

  test('saveBinaryAsync rejects zstd', async () => {
    const index = FrozenMiniSearchBrowser.fromDocuments(docs, options)
    await expect(index.saveBinaryAsync({ compression: 'zstd' }))
      .rejects.toThrow(/not supported in the browser/)
  })

  test('loadBinaryAsync rejects zstd-compressed snapshots', async () => {
    const index = FrozenMiniSearchBrowser.fromDocuments(docs, options)
    const buf = await index.saveBinaryAsync({ compression: 'raw' })
    buf[MSV5_PAYLOAD_CODEC_OFFSET] = CODEC_ZSTD
    await expect(FrozenMiniSearchBrowser.loadBinaryAsync(buf, options))
      .rejects.toThrow(/zstd-compressed/)
  })

  test('encodeFrozenSnapshotMsv5Browser + decodeFrozenSnapshotMsv5Browser round-trip', async () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const snap = await decodeFrozenSnapshotMsv5Browser(
      new Uint8Array(frozenFromMiniSearch(FrozenMiniSearch, mutable, options).saveBinarySync({ compression: 'raw' })),
    )
    const encoded = await encodeFrozenSnapshotMsv5Browser(snap, 'zlib')
    const roundTripped = await decodeFrozenSnapshotMsv5Browser(encoded)
    expect(roundTripped.documentCount).toBe(snap.documentCount)
    expect(roundTripped.fieldNames).toEqual(snap.fieldNames)
  })
})
