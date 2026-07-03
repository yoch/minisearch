import { randomBytes } from 'node:crypto'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../FrozenMiniSearch'
import { frozenFromMiniSearch } from '../../testSupport/frozenImportHelpers'
import { writeU32LE } from '../binaryBytes'
import {
  CODEC_RAW,
  CODEC_ZLIB,
  CODEC_ZSTD,
  MSV5_HEADER_SIZE,
  MSV5_PAYLOAD_CODEC_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET,
  MSV5_SECTION_COUNT,
  MSV5_SECTION_COUNT_OFFSET,
} from './binaryMsv5Constants'
import {
  assembleMsv5FileBrowser,
  isMsv5Bytes,
  loadMsv5SectionsBrowser,
  readMsv5GlobalFlagsBrowser,
  readMsv5SectionDirectory,
  readMsv5SnapshotCompressionMetaBrowser,
} from './binaryMsv5CompressionBrowser'
import { loadMsv5Sections } from './binaryMsv5Compression'

const options = { fields: ['title', 'text'] }
const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' },
]

function smallIndexRawSections() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, options).saveBinarySync({ compression: 'raw' })
  const directory = readMsv5SectionDirectory(buf)
  return {
    globalFlags: readMsv5GlobalFlagsBrowser(buf),
    rawSections: loadMsv5Sections(buf, directory),
  }
}

function bigCompressibleRawSections() {
  const mutable = new MiniSearch({ fields: ['text'] })
  mutable.addAll(Array.from({ length: 200 }, (_, i) => ({
    id: i,
    text: `payload ${'z'.repeat(120)} ${i}`,
  })))
  const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, {}).saveBinarySync({ compression: 'raw' })
  const directory = readMsv5SectionDirectory(buf)
  return {
    globalFlags: readMsv5GlobalFlagsBrowser(buf),
    rawSections: loadMsv5Sections(buf, directory),
  }
}

function tinyRawSections(totalBytes = 48) {
  const perSection = Math.floor(totalBytes / MSV5_SECTION_COUNT)
  return Array.from({ length: MSV5_SECTION_COUNT }, () => new Uint8Array(perSection))
}

function incompressibleRawSections(totalBytes = 200) {
  const bytes = randomBytes(totalBytes)
  const perSection = Math.floor(totalBytes / MSV5_SECTION_COUNT)
  const sections = []
  let off = 0
  for (let i = 0; i < MSV5_SECTION_COUNT; i++) {
    sections.push(bytes.subarray(off, off + perSection))
    off += perSection
  }
  return sections
}

describe('binaryMsv5CompressionBrowser', () => {
  test('isMsv5Bytes recognizes MSv5 headers', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    expect(isMsv5Bytes(assembled.buffer)).toBe(true)
    expect(isMsv5Bytes(new Uint8Array([0, 1, 2, 3]))).toBe(false)
  })

  test.each(['raw', 'zlib', 'auto'])('assemble + load round-trip (%s)', async (compression) => {
    const { globalFlags, rawSections } = bigCompressibleRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, compression)
    const meta = readMsv5SnapshotCompressionMetaBrowser(assembled.buffer)
    expect(meta.formatRev).toBeGreaterThan(0)
    if (compression === 'raw') {
      expect(meta.payloadCodec).toBe(CODEC_RAW)
    } else {
      expect(meta.payloadCodec).toBe(CODEC_ZLIB)
    }
    const directory = readMsv5SectionDirectory(assembled.buffer)
    const loaded = await loadMsv5SectionsBrowser(assembled.buffer, directory)
    expect(loaded).toHaveLength(MSV5_SECTION_COUNT)
    for (let i = 0; i < rawSections.length; i++) {
      expect(Buffer.from(loaded[i])).toEqual(Buffer.from(rawSections[i]))
    }
  })

  test('auto compresses large payloads', async () => {
    const { globalFlags, rawSections } = bigCompressibleRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'auto')
    expect(readMsv5SnapshotCompressionMetaBrowser(assembled.buffer).payloadCodec).toBe(CODEC_ZLIB)
  })

  test('assemble rejects zstd compression', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    await expect(assembleMsv5FileBrowser(globalFlags, rawSections, 'zstd'))
      .rejects.toThrow(/not supported in the browser/)
  })

  test('load rejects zstd-compressed snapshots', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    const zstdBuf = new Uint8Array(assembled.buffer)
    zstdBuf[MSV5_PAYLOAD_CODEC_OFFSET] = CODEC_ZSTD
    const directory = readMsv5SectionDirectory(zstdBuf)
    await expect(loadMsv5SectionsBrowser(zstdBuf, directory))
      .rejects.toThrow(/zstd-compressed/)
  })

  test('assemble rejects wrong section count', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    await expect(assembleMsv5FileBrowser(globalFlags, rawSections.slice(0, 1), 'raw'))
      .rejects.toThrow(new RegExp(`expects ${MSV5_SECTION_COUNT} sections`))
  })

  test('auto keeps raw for payloads smaller than MSV5_MIN_COMPRESS_BYTES', async () => {
    const assembled = await assembleMsv5FileBrowser(0, tinyRawSections(48), 'auto')
    expect(readMsv5SnapshotCompressionMetaBrowser(assembled.buffer).payloadCodec).toBe(CODEC_RAW)
  })

  test('auto keeps raw when zlib does not shrink the payload', async () => {
    const assembled = await assembleMsv5FileBrowser(0, incompressibleRawSections(200), 'auto')
    expect(readMsv5SnapshotCompressionMetaBrowser(assembled.buffer).payloadCodec).toBe(CODEC_RAW)
  })

  test('readMsv5SectionDirectory rejects a truncated header', () => {
    expect(() => readMsv5SectionDirectory(new Uint8Array(10)))
      .toThrow(/buffer too short/)
  })

  test('readMsv5SectionDirectory rejects an inconsistent section count', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    const buf = new Uint8Array(assembled.buffer)
    writeU32LE(buf, MSV5_SECTION_COUNT_OFFSET, MSV5_SECTION_COUNT + 1)
    expect(() => readMsv5SectionDirectory(buf))
      .toThrow(/section count mismatch/)
  })

  test('loadMsv5SectionsBrowser rejects a payload CRC mismatch', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    const buf = new Uint8Array(assembled.buffer)
    buf[MSV5_HEADER_SIZE] ^= 0xff
    const directory = readMsv5SectionDirectory(buf)
    await expect(loadMsv5SectionsBrowser(buf, directory))
      .rejects.toThrow(/payload CRC mismatch/)
  })

  test('loadMsv5SectionsBrowser rejects an unknown payload codec', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    const buf = new Uint8Array(assembled.buffer)
    buf[MSV5_PAYLOAD_CODEC_OFFSET] = 99
    const directory = readMsv5SectionDirectory(buf)
    await expect(loadMsv5SectionsBrowser(buf, directory))
      .rejects.toThrow(/unknown payload codec 99/)
  })

  test('loadMsv5SectionsBrowser rejects raw payload with wrong compressed length', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    const meta = readMsv5SnapshotCompressionMetaBrowser(assembled.buffer)
    const buf = new Uint8Array(assembled.buffer)
    writeU32LE(buf, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET, meta.uncompressedLength - 1)
    const directory = readMsv5SectionDirectory(buf)
    await expect(loadMsv5SectionsBrowser(buf, directory))
      .rejects.toThrow(/raw payload length/)
  })
})
