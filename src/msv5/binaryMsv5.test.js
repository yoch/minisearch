import zlib from 'node:zlib'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../FrozenMiniSearch'
import { frozenMemoryBreakdown } from '../../testSupport/frozenMemoryBreakdown.js'
import { frozenFromMiniSearch } from '../internal/frozenInternals'
import {
  decodeFrozenSnapshot,
  BINARY_MAGIC_V5,
  readMsv5SnapshotCompressionMeta,
} from '../binaryFormat'
import {
  CODEC_RAW,
  CODEC_ZLIB,
  CODEC_ZSTD,
  FLAG_FREQ_U16,
  MSV5_FORMAT_REV_PAYLOAD,
  MSV5_ERR_BUFFER_TOO_SHORT_FOR_HEADER,
  MSV5_HEADER_SIZE,
  MSV5_PAYLOAD_CRC_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_OFFSET,
  MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET,
  MSV5_SECTION_DIR_OFFSET,
  Msv5SectionId,
} from './binaryMsv5Constants'
import { overflowFrequencies } from '../../benchmarks/benchmarkScenarios.js'
import { crc32Buffer, crc32Update } from '../binaryIo'
import { encodeFrozenSnapshotMsv5 } from './binaryMsv5Encode'
import {
  assembleMsv5File,
  loadMsv5Sections,
  loadMsv5SectionsAsync,
  readMsv5GlobalFlags,
  readMsv5SectionDirectory,
} from './binaryMsv5Compression'
import { computeSectionDirectory } from './binaryMsv5PayloadAssembly'
import { buildMsv5EncodePrepared } from './binaryMsv5EncodeSections'
import PackedRadixTree from '../PackedRadixTree'

const options = { fields: ['title', 'text'] }
const hasZstd = typeof zlib.zstdCompressSync === 'function'
const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' },
]

function msv5SectionDirOffset(sectionId) {
  return MSV5_SECTION_DIR_OFFSET + sectionId * 20
}

/** Header fields that must match between saveBinarySync and saveBinaryAsync (not compressed bytes). */
function msv5ComparableHeaderMeta(buf) {
  const meta = readMsv5SnapshotCompressionMeta(buf)
  return {
    globalFlags: buf.readUInt16LE(6),
    formatRev: meta.formatRev,
    payloadCodec: meta.payloadCodec,
    zstdLevel: meta.zstdLevel,
    uncompressedLength: meta.uncompressedLength,
    payloadCrc32: meta.payloadCrc32,
    payloadOffset: buf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_OFFSET),
    sections: meta.sections,
  }
}

const loadOpts = { fields: ['text'] }

/** Simulate a runtime without node:zlib zstd (Node < 22.15.0); returns a restore callback.
 *  Stubs only `zstdCompressSync`, the single member `zstdAvailable()` probes (all zstd APIs
 *  land together in 22.15.0). Some `zlib` exports are read-only, but this one is assignable. */
function stubMissingZstd() {
  const saved = zlib.zstdCompressSync
  zlib.zstdCompressSync = undefined
  return () => {
    zlib.zstdCompressSync = saved
  }
}

function stubIneffectiveZlib() {
  const savedSync = zlib.deflateSync
  const savedAsync = zlib.deflate
  zlib.deflateSync = input => Buffer.from(input)
  zlib.deflate = (input, options, callback) => {
    if (typeof options === 'function') {
      options(null, Buffer.from(input))
      return
    }
    callback(null, Buffer.from(input))
  }
  return () => {
    zlib.deflateSync = savedSync
    zlib.deflate = savedAsync
  }
}

function bigCompressibleIndex() {
  const mutable = new MiniSearch({ fields: ['text'] })
  mutable.addAll(Array.from({ length: 200 }, (_, i) => ({
    id: i,
    text: `payload ${'z'.repeat(120)} ${i}`,
  })))
  return frozenFromMiniSearch(FrozenMiniSearch, mutable, {})
}

function compressedSnapshotBuffer(compression) {
  return Buffer.from(bigCompressibleIndex().saveBinarySync({ compression }))
}

function corruptPayloadCrc(buf) {
  const stored = buf.readUInt32LE(MSV5_PAYLOAD_CRC_OFFSET)
  buf.writeUInt32LE((stored ^ 1) >>> 0, MSV5_PAYLOAD_CRC_OFFSET)
  return buf
}

function corruptCoreSectionCrc(buf) {
  const coreDir = msv5SectionDirOffset(Msv5SectionId.Core)
  buf.writeUInt32LE(0, coreDir + 8)
  return buf
}

function corruptDecompressedLength(buf) {
  const meta = readMsv5SnapshotCompressionMeta(buf)
  const freqsDir = msv5SectionDirOffset(Msv5SectionId.AllFreqs)
  const freqsLen = buf.readUInt32LE(freqsDir + 4)
  buf.writeUInt32LE(freqsLen + 1, freqsDir + 4)
  buf.writeUInt32LE(meta.uncompressedLength + 1, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
  return buf
}

function corruptStreamingLength(buf) {
  const meta = readMsv5SnapshotCompressionMeta(buf)
  const freqsDir = msv5SectionDirOffset(Msv5SectionId.AllFreqs)
  const freqsLen = buf.readUInt32LE(freqsDir + 4)
  expect(freqsLen).toBeGreaterThan(0)
  buf.writeUInt32LE(freqsLen - 1, freqsDir + 4)
  buf.writeUInt32LE(meta.uncompressedLength - 1, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
  return buf
}

/** Physically truncate the file while header still claims the full compressed length. */
function truncatePhysicalBuffer(buf, keepPayloadFraction = 0.5) {
  const meta = readMsv5SnapshotCompressionMeta(buf)
  expect(meta.compressedLength).toBeGreaterThan(0)
  const payloadBytes = Math.max(1, Math.floor(meta.compressedLength * keepPayloadFraction))
  return Buffer.from(buf.subarray(0, MSV5_HEADER_SIZE + payloadBytes))
}

const alwaysCodecCases = [
  ['zlib', 'zlib', CODEC_ZLIB],
]
const zstdCodecCases = [
  ['zstd', 'zstd', CODEC_ZSTD],
]

function defineCorruptionCodecTests(codecCases) {
  test.each(codecCases)(
    'rejects %s payload CRC mismatch on sync load',
    (_label, compression, codec) => {
      const buf = corruptPayloadCrc(compressedSnapshotBuffer(compression))
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(codec)
      expect(() => FrozenMiniSearch.loadBinarySync(buf, loadOpts))
        .toThrow(/payload CRC mismatch/)
    },
  )

  test.each(codecCases)(
    'rejects %s section CRC mismatch on sync load',
    (_label, compression, codec) => {
      const buf = corruptCoreSectionCrc(compressedSnapshotBuffer(compression))
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(codec)
      expect(() => FrozenMiniSearch.loadBinarySync(buf, loadOpts))
        .toThrow(/section CRC mismatch/)
    },
  )

  test.each(codecCases)(
    'rejects %s decompressed length mismatch on sync load',
    (_label, compression, codec) => {
      const buf = corruptDecompressedLength(compressedSnapshotBuffer(compression))
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(codec)
      expect(() => FrozenMiniSearch.loadBinarySync(buf, loadOpts))
        .toThrow(/decompressed payload length mismatch/)
    },
  )

  test.each(codecCases)(
    'streaming load rejects %s output past declared uncompressed length',
    async (_label, compression, codec) => {
      const buf = corruptStreamingLength(compressedSnapshotBuffer(compression))
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(codec)
      await expect(loadMsv5SectionsAsync(buf, readMsv5SectionDirectory(buf)))
        .rejects.toThrow(/compressed payload exceeds declared length/)
    },
  )

  test.each(codecCases)(
    'rejects physically truncated %s snapshot on sync load',
    (_label, compression, codec) => {
      const buf = truncatePhysicalBuffer(compressedSnapshotBuffer(compression))
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(codec)
      expect(buf.length).toBeLessThan(MSV5_HEADER_SIZE + readMsv5SnapshotCompressionMeta(buf).compressedLength)
      expect(() => FrozenMiniSearch.loadBinarySync(buf, loadOpts))
        .toThrow(/payload out of bounds/)
    },
  )

  test.each(codecCases)(
    'rejects physically truncated %s snapshot on async load',
    async (_label, compression, codec) => {
      const buf = truncatePhysicalBuffer(compressedSnapshotBuffer(compression))
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(codec)
      await expect(FrozenMiniSearch.loadBinaryAsync(buf, loadOpts))
        .rejects.toThrow(/payload out of bounds/)
    },
  )
}

describe('binaryMsv5', () => {
  test('encodeFrozenSnapshot uses MSv5 by default', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, {}).saveBinarySync()
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V5)
    expect(buf.length).toBeGreaterThan(MSV5_HEADER_SIZE)
  })

  test('MSv5 round-trip preserves search', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, {})
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('MSv5 sets FLAG_FREQ_U16 when term frequencies exceed 255', () => {
    const frozen = FrozenMiniSearch.fromDocuments(
      overflowFrequencies(4, 400),
      { fields: ['txt'] },
    )
    const buf = frozen.saveBinarySync()
    expect(buf.readUInt16LE(6) & FLAG_FREQ_U16).toBe(FLAG_FREQ_U16)
    const loaded = FrozenMiniSearch.loadBinarySync(buf, { fields: ['txt'] })
    expect(frozenMemoryBreakdown(loaded).postings.allFreqsBytes)
      .toBe(frozenMemoryBreakdown(frozen).postings.allFreqsBytes)
  })

  test('MSv5 u8 freqs load without FLAG_FREQ_U16', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, {}).saveBinarySync()
    expect(buf.readUInt16LE(6) & FLAG_FREQ_U16).toBe(0)
  })

  test('MSv5 preserves compact postings metadata bytes after binary round-trip', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, {})
    const before = frozenMemoryBreakdown(frozen).postings
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options)
    const after = frozenMemoryBreakdown(loaded).postings
    expect(after.offsetsBytes).toBe(before.offsetsBytes)
    expect(after.lengthsBytes).toBe(before.lengthsBytes)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('MSv5 async stream load preserves search', async () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, {})
    const loaded = await FrozenMiniSearch.loadBinaryAsync(frozen.saveBinarySync(), options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('MSv5 async save uses same format and preserves search', async () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, {})
    const buf = await frozen.saveBinaryAsync()
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V5)
    const loaded = await FrozenMiniSearch.loadBinaryAsync(buf, options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('saveBinarySync and saveBinaryAsync agree on payload CRC and header metadata', async () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, {})
    const syncBuf = frozen.saveBinarySync()
    const asyncBuf = await frozen.saveBinaryAsync()
    const syncMeta = msv5ComparableHeaderMeta(syncBuf)
    const asyncMeta = msv5ComparableHeaderMeta(asyncBuf)
    expect(asyncMeta).toEqual(syncMeta)
  })

  test.skipIf(!hasZstd)('saveBinarySync vs async: same CRC/metadata on zstd-sized index', async () => {
    const frozen = bigCompressibleIndex()
    const syncBuf = frozen.saveBinarySync({ compression: 'zstd' })
    const asyncBuf = await frozen.saveBinaryAsync({ compression: 'zstd' })
    expect(readMsv5SnapshotCompressionMeta(syncBuf).payloadCodec).toBe(CODEC_ZSTD)
    const syncMeta = msv5ComparableHeaderMeta(syncBuf)
    const asyncMeta = msv5ComparableHeaderMeta(asyncBuf)
    expect(asyncMeta).toEqual(syncMeta)
  })

  test('single payload stream with per-section catalogue offsets', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, {}).saveBinarySync()
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.formatRev).toBe(MSV5_FORMAT_REV_PAYLOAD)
    expect(meta.sections.length).toBe(12)
  })

  test('large index uses zlib in auto mode when payload shrinks', () => {
    const buf = bigCompressibleIndex().saveBinarySync()
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.formatRev).toBe(MSV5_FORMAT_REV_PAYLOAD)
    expect(meta.payloadCodec === CODEC_ZLIB || meta.payloadCodec === CODEC_RAW).toBe(true)
    if (meta.payloadCodec === CODEC_ZLIB) {
      expect(meta.zstdLevel).toBe(0)
      expect(meta.compressedLength).toBeLessThan(meta.uncompressedLength)
    }
    const payloadOff = buf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_OFFSET)
    expect(payloadOff).toBe(MSV5_HEADER_SIZE)
    expect(FrozenMiniSearch.loadBinarySync(buf, loadOpts).search('payload').length)
      .toBeGreaterThan(0)
  })

  test('explicit raw compression always writes a raw payload', () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'raw' })
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.payloadCodec).toBe(CODEC_RAW)
    expect(FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }).search('payload').length)
      .toBeGreaterThan(0)
  })

  test('raw payload CRC includes 4-byte alignment padding between sections', () => {
    const seed = bigCompressibleIndex().saveBinarySync({ compression: 'raw' })
    const directory = readMsv5SectionDirectory(seed)
    const globalFlags = readMsv5GlobalFlags(seed)
    const rawSections = loadMsv5Sections(seed, directory).map((section, i) => {
      if (i >= 3) return section
      return Buffer.from(section.subarray(0, i + 1))
    })

    const { entries, uncompressedLength } = computeSectionDirectory(rawSections)
    expect(entries[1].fileOffset).toBeGreaterThan(entries[0].fileOffset + entries[0].uncompressedLength)

    const assembled = assembleMsv5File(globalFlags, rawSections, 'raw')
    const meta = readMsv5SnapshotCompressionMeta(assembled.buffer)
    const payload = assembled.buffer.subarray(MSV5_HEADER_SIZE, MSV5_HEADER_SIZE + uncompressedLength)

    let sectionsOnlyCrc = 0
    for (const section of rawSections) {
      sectionsOnlyCrc = crc32Update(sectionsOnlyCrc, section)
    }
    expect(sectionsOnlyCrc).not.toBe(meta.payloadCrc32)
    expect(crc32Buffer(payload)).toBe(meta.payloadCrc32)

    const loaded = loadMsv5Sections(assembled.buffer, readMsv5SectionDirectory(assembled.buffer))
    for (let i = 0; i < rawSections.length; i++) {
      expect(Buffer.from(loaded[i])).toEqual(Buffer.from(rawSections[i]))
    }
  })

  test('loaded raw snapshot copies caller wire buffer', () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'raw' })
    const loaded = FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] })
    const before = loaded.search('payload').length
    buf.fill(0)
    expect(loaded.search('payload').length).toBe(before)
  })

  test('explicit zlib compression writes a zlib payload', () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'zlib' })
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.payloadCodec).toBe(CODEC_ZLIB)
    expect(meta.zstdLevel).toBe(0)
    expect(FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }).search('payload').length)
      .toBeGreaterThan(0)
  })

  test('loaded zlib snapshot owns decoded payload after caller buffer mutation', () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'zlib' })
    const loaded = FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] })
    const before = loaded.search('payload').length
    buf.fill(0)
    expect(loaded.search('payload').length).toBe(before)
  })

  test('explicit zlib compression round-trips in async save/load', async () => {
    const buf = await bigCompressibleIndex().saveBinaryAsync({ compression: 'zlib' })
    expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(CODEC_ZLIB)
    const loaded = await FrozenMiniSearch.loadBinaryAsync(buf, { fields: ['text'] })
    expect(loaded.search('payload').length).toBeGreaterThan(0)
  })

  defineCorruptionCodecTests(alwaysCodecCases)

  describe.skipIf(!hasZstd)('MSv5 zstd corruption (requires node:zlib zstd)', () => {
    defineCorruptionCodecTests(zstdCodecCases)
  })

  test('rejects payload sizes above 1 GiB', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(docs)
    const buf = Buffer.from(frozenFromMiniSearch(FrozenMiniSearch, mutable, {}).saveBinarySync())
    buf.writeUInt32LE(1024 * 1024 * 1024 + 1, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
    expect(() => FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }))
      .toThrow(/1 GiB/)
  })

  test('encodeFrozenSnapshotMsv5 round-trips programmatic snapshot', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(Array.from({ length: 50 }, (_, i) => ({ id: i, text: `doc ${i}` })))
    const snap = decodeFrozenSnapshot(frozenFromMiniSearch(FrozenMiniSearch, mutable, {}).saveBinarySync())
    const buf = encodeFrozenSnapshotMsv5(snap)
    const dir = readMsv5SectionDirectory(buf)
    expect(dir[Msv5SectionId.Core].uncompressedLength).toBe(16)
    expect(FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }).search('doc').length)
      .toBeGreaterThan(0)
  })

  test('rejects buffer shorter than MSv5 header', () => {
    const buf = compressedSnapshotBuffer('zlib')
    expect(() => readMsv5SectionDirectory(buf.subarray(0, MSV5_HEADER_SIZE - 1)))
      .toThrow(MSV5_ERR_BUFFER_TOO_SHORT_FOR_HEADER)
    expect(() => FrozenMiniSearch.loadBinarySync(buf.subarray(0, MSV5_HEADER_SIZE - 1), loadOpts))
      .toThrow(MSV5_ERR_BUFFER_TOO_SHORT_FOR_HEADER)
  })
})

describe('binaryMsv5 zstd unavailable (Node without zstd)', () => {
  test('saveBinarySync auto uses a zlib payload', () => {
    const frozen = bigCompressibleIndex()
    const restore = stubMissingZstd()
    try {
      const buf = frozen.saveBinarySync()
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(CODEC_ZLIB)
      expect(FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }).search('payload').length)
        .toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test('saveBinaryAsync auto uses a zlib payload', async () => {
    const frozen = bigCompressibleIndex()
    const restore = stubMissingZstd()
    try {
      const buf = await frozen.saveBinaryAsync()
      expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(CODEC_ZLIB)
      expect(FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }).search('payload').length)
        .toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test('auto falls back to raw when zlib does not shrink', async () => {
    const restoreZlib = stubIneffectiveZlib()
    try {
      const frozen = bigCompressibleIndex()
      expect(readMsv5SnapshotCompressionMeta(frozen.saveBinarySync()).payloadCodec).toBe(CODEC_RAW)
      expect(readMsv5SnapshotCompressionMeta(await frozen.saveBinaryAsync()).payloadCodec).toBe(CODEC_RAW)
    } finally {
      restoreZlib()
    }
  })

  test('saveBinarySync with explicit zstd throws a clear error', () => {
    const restore = stubMissingZstd()
    try {
      expect(() => bigCompressibleIndex().saveBinarySync({ compression: 'zstd' }))
        .toThrow(/requested zstd compression/)
    } finally {
      restore()
    }
  })

  test('saveBinaryAsync with explicit zstd throws a clear error', async () => {
    const restore = stubMissingZstd()
    try {
      await expect(bigCompressibleIndex().saveBinaryAsync({ compression: 'zstd' }))
        .rejects.toThrow(/requested zstd compression/)
    } finally {
      restore()
    }
  })

  test('loadBinarySync still loads a zlib snapshot', () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'zlib' })
    const restore = stubMissingZstd()
    try {
      expect(FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }).search('payload').length)
        .toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test('loadBinaryAsync still loads a zlib snapshot', async () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'zlib' })
    const restore = stubMissingZstd()
    try {
      await expect(FrozenMiniSearch.loadBinaryAsync(buf, { fields: ['text'] }))
        .resolves.toBeInstanceOf(FrozenMiniSearch)
    } finally {
      restore()
    }
  })

  test.skipIf(!hasZstd)('loadBinarySync throws a clear error on a zstd snapshot', () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'zstd' })
    expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(CODEC_ZSTD)
    const restore = stubMissingZstd()
    try {
      expect(() => FrozenMiniSearch.loadBinarySync(buf, { fields: ['text'] }))
        .toThrow(/lacks node:zlib zstd support/)
    } finally {
      restore()
    }
  })

  test.skipIf(!hasZstd)('loadBinaryAsync throws a clear error on a zstd snapshot', async () => {
    const buf = bigCompressibleIndex().saveBinarySync({ compression: 'zstd' })
    expect(readMsv5SnapshotCompressionMeta(buf).payloadCodec).toBe(CODEC_ZSTD)
    const restore = stubMissingZstd()
    try {
      await expect(FrozenMiniSearch.loadBinaryAsync(buf, { fields: ['text'] }))
        .rejects.toThrow(/lacks node:zlib zstd support/)
    } finally {
      restore()
    }
  })
})

describe('buildMsv5EncodePrepared', () => {
  function loadedSnapshot() {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    return decodeFrozenSnapshot(frozen.saveBinarySync())
  }

  test('builds wire sections for a valid snapshot', () => {
    const snap = loadedSnapshot()
    const prepared = buildMsv5EncodePrepared(snap, snap.packedTermIndex)
    expect(prepared.rawSections.length).toBeGreaterThanOrEqual(11)
    expect(prepared.globalFlags).toBeGreaterThanOrEqual(0)
  })

  test('rejects invalid snapshot state before encode', () => {
    const snap = loadedSnapshot()
    snap.fieldCount = 0
    expect(() => buildMsv5EncodePrepared(snap, snap.packedTermIndex))
      .toThrow(/fieldCount must be positive/)

    const badNames = loadedSnapshot()
    badNames.fieldNames = ['only-one']
    badNames.fieldCount = 2
    expect(() => buildMsv5EncodePrepared(badNames, badNames.packedTermIndex))
      .toThrow(/fieldNames length mismatch/)

    const badTree = loadedSnapshot()
    const tree = badTree.packedTermIndex
    badTree.packedTermIndex = PackedRadixTree.fromData({
      size: tree.size + 1,
      nodeCount: tree.nodeCount,
      edgeCount: tree.edgeCount,
      labelHeap: tree.labelHeap,
      nodeEdgeOffset: tree.nodeEdgeOffset,
      nodeValue: tree.nodeValue,
      nodeLeafOrder: tree.nodeLeafOrder,
      edgeLabelStart: tree.edgeLabelStart,
      edgeLabelLength: tree.edgeLabelLength,
      edgeChild: tree.edgeChild,
    })
    expect(() => buildMsv5EncodePrepared(badTree, badTree.packedTermIndex))
      .toThrow(/size .* !== termCount/)
  })
})

describe('binaryMsv5 load memory', () => {
  test('heap after loadBinaryAsync stays bounded vs file size', async () => {
    if (typeof global.gc !== 'function') {
      return
    }
    const mutable = new MiniSearch({ fields: ['text'] })
    const big = Array.from({ length: 8000 }, (_, i) => ({
      id: i,
      text: `term${i % 200} repeated content ${i}`,
    }))
    mutable.addAll(big)
    const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, {}).saveBinarySync()
    const fileBytes = buf.length

    global.gc()
    const heapBefore = process.memoryUsage().heapUsed
    await FrozenMiniSearch.loadBinaryAsync(buf, { fields: ['text'] })
    global.gc()
    const heapAfter = process.memoryUsage().heapUsed
    const delta = heapAfter - heapBefore

    expect(delta).toBeLessThan(fileBytes * 1.35 + 8 * 1024 * 1024)
  })
})
