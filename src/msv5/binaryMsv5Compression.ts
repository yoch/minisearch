import zlib from 'node:zlib'
import type { Transform } from 'node:stream'
import { crc32Buffer, crc32Update } from '../binaryIo'
import type { BinaryCompression } from '../searchTypes'
import type { Msv5SectionEntry, Msv5SnapshotCompressionMeta } from './binaryMsv5Types'
import {
  CODEC_RAW,
  CODEC_ZLIB,
  CODEC_ZSTD,
  MSV5_ERR_COMPRESSED_PAYLOAD_EXCEEDS_LENGTH,
  MSV5_ERR_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH,
  MSV5_ERR_PAYLOAD_CRC_MISMATCH,
  MSV5_ERR_PAYLOAD_EXCEEDS_1GIB,
  MSV5_ERR_SECTION_CRC_MISMATCH,
  MSV5_HEADER_SIZE,
  MSV5_MIN_COMPRESS_BYTES,
  MSV5_ZSTD_LEVEL,
} from './binaryMsv5Constants'
import {
  computeSectionDirectory,
  concatRawSectionsWithCrc,
  writeRawSectionsIntoPayload,
} from './binaryMsv5PayloadAssembly'
import {
  assertRawSectionCount,
  buildMsv5CompressionMeta,
  isMsv5Bytes,
  MSV5_MAX_UNCOMPRESSED_BYTES,
  preparePayload as prepareMsv5Payload,
  readMsv5GlobalFlags as readMsv5GlobalFlagsShared,
  readMsv5SectionDirectory as readMsv5SectionDirectoryShared,
  readMsv5SnapshotCompressionMeta as readMsv5SnapshotCompressionMetaShared,
  writeMsv5FileHeader,
} from './binaryMsv5ContainerShared'
import {
  pickAutoPayloadCodec,
  rawPayloadChoice,
  type Msv5PayloadCodecChoice,
} from './binaryMsv5CompressionShared'
export type { Msv5SectionEntry, Msv5SnapshotCompressionMeta } from './binaryMsv5Types'

export interface Msv5AssembledFile {
  buffer: Buffer
  globalFlags: number
  compression: Msv5SnapshotCompressionMeta
}

/** Hard cap on the uncompressed payload, rejected before allocation (compressed-bomb guard).
 *  This is the single trust boundary for untrusted snapshots: {@link preparePayload} rejects
 *  headers above this size; sync decompress uses the same cap via `maxOutputLength`.
 *  A malicious header can still declare up to 1 GiB — no tighter native limit helps without
 *  trusting `uncompressedLength` from that same header. Semantic integrity (length match,
 *  payload CRC, per-section CRC) is enforced after decode. */

// zstd landed in node:zlib at Node 22.15.0 (22.x line) / 23.8.0, where the whole family
// (zstdCompress[Sync], zstdDecompressSync, createZstdDecompress) ships together — so probing one
// member is enough to know if the runtime supports zstd. Checked at call time (not captured at
// module load) so it stays mockable in tests. `compression: "auto"` always tries zlib once (or
// raw if it does not help). Explicit `zstd` requires Node 22.15+. Reads of a zstd payload throw
// a clear, actionable error on runtimes without zstd.
function zstdAvailable(): boolean {
  return typeof zlib.zstdCompressSync === 'function'
}

function zstdUnavailableWriteError(): Error {
  return new Error(
    'MSv5 snapshot requested zstd compression, but this Node.js runtime lacks node:zlib zstd '
    + 'support (added in Node 22.15.0). Upgrade Node.js, or use compression: "auto", "raw", '
    + 'or "zlib".',
  )
}

function zstdUnavailableReadError(): Error {
  return new Error(
    'MSv5 snapshot is zstd-compressed, but this Node.js runtime lacks node:zlib zstd support '
    + '(added in Node 22.15.0). Upgrade Node.js to read this snapshot, or re-save it from a '
    + 'newer runtime with compression: "raw" or "zlib".',
  )
}

function concatAndValidateSections(rawSections: Array<Buffer | Uint8Array>): {
  uncompressed: Buffer
  entries: Msv5SectionEntry[]
  payloadCrc32: number
} {
  assertRawSectionCount(rawSections)
  const { uncompressed, entries, payloadCrc32 } = concatRawSectionsWithCrc(
    rawSections,
    size => Buffer.alloc(size),
  )
  if (uncompressed.length > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(MSV5_ERR_PAYLOAD_EXCEEDS_1GIB)
  }
  return { uncompressed: uncompressed as Buffer, entries, payloadCrc32 }
}

/** Raw save: one allocation (header + payload), no intermediate uncompressed buffer. */
function assembleMsv5FileRawDirect(
  globalFlags: number,
  rawSections: Array<Buffer | Uint8Array>,
): Msv5AssembledFile {
  assertRawSectionCount(rawSections)
  const { entries, uncompressedLength } = computeSectionDirectory(rawSections)
  if (uncompressedLength > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(MSV5_ERR_PAYLOAD_EXCEEDS_1GIB)
  }

  const out = Buffer.alloc(MSV5_HEADER_SIZE + uncompressedLength)
  const payloadCrc32 = writeRawSectionsIntoPayload(out, MSV5_HEADER_SIZE, rawSections, entries)
  writeMsv5FileHeader(
    out,
    globalFlags,
    entries,
    uncompressedLength,
    payloadCrc32,
    uncompressedLength,
    CODEC_RAW,
    0,
  )

  return {
    buffer: out,
    globalFlags,
    compression: buildMsv5CompressionMeta(
      entries,
      uncompressedLength,
      uncompressedLength,
      payloadCrc32,
      CODEC_RAW,
      0,
    ),
  }
}

/** Writes MSv5 header + section catalogue and appends the payload blob. */
function buildMsv5AssembledFile(
  globalFlags: number,
  entries: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
  payload: Buffer,
  codec: number,
  zstdLevel: number,
): Msv5AssembledFile {
  const out = Buffer.alloc(MSV5_HEADER_SIZE + payload.length)
  writeMsv5FileHeader(
    out,
    globalFlags,
    entries,
    uncompressedLength,
    payloadCrc32,
    payload.length,
    codec,
    zstdLevel,
  )
  payload.copy(out, MSV5_HEADER_SIZE)

  return {
    buffer: out,
    globalFlags,
    compression: buildMsv5CompressionMeta(
      entries,
      uncompressedLength,
      payload.length,
      payloadCrc32,
      codec,
      zstdLevel,
    ),
  }
}

/** Shared zstd encoder options for sync and async save paths.
 *  - `pledgedSrcSize`: exact input size is known; lets libzstd size its window and buffers.
 *  - `ZSTD_c_checksumFlag: 0`: MSv5 already stores payload + per-section CRC-32; frame checksum is redundant CPU.
 *  Cast: `pledgedSrcSize` is supported at runtime by Node zlib but may lag in typings. */
function msv5ZstdCompressOptions(
  uncompressed: Buffer,
): NonNullable<Parameters<typeof zlib.zstdCompressSync>[1]> {
  return {
    pledgedSrcSize: uncompressed.length,
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: MSV5_ZSTD_LEVEL,
      [zlib.constants.ZSTD_c_checksumFlag]: 0,
    },
  } as NonNullable<Parameters<typeof zlib.zstdCompressSync>[1]>
}

type PayloadCodecChoice = Msv5PayloadCodecChoice<Buffer>

function zstdPayloadChoiceSync(uncompressed: Buffer): PayloadCodecChoice {
  if (!zstdAvailable()) {
    throw zstdUnavailableWriteError()
  }
  const compressed = zlib.zstdCompressSync(uncompressed, msv5ZstdCompressOptions(uncompressed))
  return { payload: compressed, codec: CODEC_ZSTD, zstdLevel: MSV5_ZSTD_LEVEL }
}

/**
 * Async zstd via {@link zstdCompress} (not {@link zstdCompressSync}).
 * Same level and input yield the same *decompressed* payload (catalogue CRC matches sync),
 * but the compressed blob is not guaranteed bit-identical — libzstd may pick a different
 * frame layout; only `payload.length` in the header differs.
 */
function zstdCompressAsync(uncompressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(
      uncompressed,
      msv5ZstdCompressOptions(uncompressed),
      (err, compressed) => {
        if (err != null) {
          reject(err)
          return
        }
        resolve(compressed)
      },
    )
  })
}

async function zstdPayloadChoiceAsync(uncompressed: Buffer): Promise<PayloadCodecChoice> {
  if (!zstdAvailable()) {
    throw zstdUnavailableWriteError()
  }
  const compressed = await zstdCompressAsync(uncompressed)
  return { payload: compressed, codec: CODEC_ZSTD, zstdLevel: MSV5_ZSTD_LEVEL }
}

function zlibPayloadChoiceSync(uncompressed: Buffer): PayloadCodecChoice {
  const compressed = zlib.deflateSync(uncompressed)
  return { payload: compressed, codec: CODEC_ZLIB, zstdLevel: 0 }
}

function zlibCompressAsync(uncompressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.deflate(uncompressed, (err, compressed) => {
      if (err != null) {
        reject(err)
        return
      }
      resolve(compressed)
    })
  })
}

async function zlibPayloadChoiceAsync(uncompressed: Buffer): Promise<PayloadCodecChoice> {
  const compressed = await zlibCompressAsync(uncompressed)
  return { payload: compressed, codec: CODEC_ZLIB, zstdLevel: 0 }
}

interface AutoPayloadCompressors {
  zlib: (uncompressed: Buffer) => Buffer
}

interface AutoPayloadCompressorsAsync {
  zlib: (uncompressed: Buffer) => Promise<Buffer>
}

const autoSyncCompressors: AutoPayloadCompressors = {
  zlib: uncompressed => zlib.deflateSync(uncompressed),
}

const autoAsyncCompressors: AutoPayloadCompressorsAsync = {
  zlib: zlibCompressAsync,
}

function autoPayloadChoice(
  uncompressed: Buffer,
  compressors: AutoPayloadCompressors,
): PayloadCodecChoice {
  if (uncompressed.length < MSV5_MIN_COMPRESS_BYTES) {
    return rawPayloadChoice(uncompressed)
  }
  return pickAutoPayloadCodec(uncompressed, compressors.zlib(uncompressed), CODEC_ZLIB)
}

async function autoPayloadChoiceAsync(
  uncompressed: Buffer,
  compressors: AutoPayloadCompressorsAsync,
): Promise<PayloadCodecChoice> {
  if (uncompressed.length < MSV5_MIN_COMPRESS_BYTES) {
    return rawPayloadChoice(uncompressed)
  }
  return pickAutoPayloadCodec(uncompressed, await compressors.zlib(uncompressed), CODEC_ZLIB)
}

function choosePayloadCodecSync(
  uncompressed: Buffer,
  compression: BinaryCompression = 'auto',
): PayloadCodecChoice {
  switch (compression) {
    case 'raw':
      return rawPayloadChoice(uncompressed)
    case 'zstd':
      return zstdPayloadChoiceSync(uncompressed)
    case 'zlib':
      return zlibPayloadChoiceSync(uncompressed)
    case 'auto':
      return autoPayloadChoice(uncompressed, autoSyncCompressors)
    default: {
      const _exhaustive: never = compression
      return _exhaustive
    }
  }
}

async function choosePayloadCodecAsync(
  uncompressed: Buffer,
  compression: BinaryCompression = 'auto',
): Promise<PayloadCodecChoice> {
  switch (compression) {
    case 'raw':
      return rawPayloadChoice(uncompressed)
    case 'zstd':
      return await zstdPayloadChoiceAsync(uncompressed)
    case 'zlib':
      return await zlibPayloadChoiceAsync(uncompressed)
    case 'auto':
      return await autoPayloadChoiceAsync(uncompressed, autoAsyncCompressors)
    default: {
      const _exhaustive: never = compression
      return _exhaustive
    }
  }
}

/**
 * MSv5 on disk: header + catalogue (uncompressed offsets) + **one** payload blob
 * (raw concatenation or a single compressed stream over it).
 */
export function assembleMsv5File(
  globalFlags: number,
  rawSections: Array<Buffer | Uint8Array>,
  compression: BinaryCompression = 'auto',
): Msv5AssembledFile {
  if (compression === 'raw') {
    return assembleMsv5FileRawDirect(globalFlags, rawSections)
  }
  const { uncompressed, entries, payloadCrc32 } = concatAndValidateSections(rawSections)
  const { payload, codec, zstdLevel } = choosePayloadCodecSync(uncompressed, compression)
  return buildMsv5AssembledFile(
    globalFlags,
    entries,
    uncompressed.length,
    payloadCrc32,
    payload,
    codec,
    zstdLevel,
  )
}

export async function assembleMsv5FileAsync(
  globalFlags: number,
  rawSections: Array<Buffer | Uint8Array>,
  compression: BinaryCompression = 'auto',
): Promise<Msv5AssembledFile> {
  if (compression === 'raw') {
    return assembleMsv5FileRawDirect(globalFlags, rawSections)
  }
  const { uncompressed, entries, payloadCrc32 } = concatAndValidateSections(rawSections)
  const { payload, codec, zstdLevel } = await choosePayloadCodecAsync(uncompressed, compression)
  return buildMsv5AssembledFile(
    globalFlags,
    entries,
    uncompressed.length,
    payloadCrc32,
    payload,
    codec,
    zstdLevel,
  )
}

export function readMsv5SectionDirectory(buf: Buffer | Uint8Array): Msv5SectionEntry[] {
  return readMsv5SectionDirectoryShared(buf)
}

export function readMsv5SnapshotCompressionMeta(buf: Buffer | Uint8Array): Msv5SnapshotCompressionMeta {
  return readMsv5SnapshotCompressionMetaShared(buf)
}

function verifySectionCrc(section: Buffer, expected: number): void {
  if (crc32Buffer(section) !== expected) {
    throw new Error(MSV5_ERR_SECTION_CRC_MISMATCH)
  }
}

/** Slice each section out of a fully materialized payload (zero-copy when 4-byte aligned). */
function sectionsFromPayload(
  payload: Buffer,
  directory: Msv5SectionEntry[],
  payloadCrc32: number,
): Buffer[] {
  if (crc32Buffer(payload) !== payloadCrc32) {
    throw new Error(MSV5_ERR_PAYLOAD_CRC_MISMATCH)
  }
  return directory.map((entry) => {
    const slice = payload.subarray(entry.fileOffset, entry.fileOffset + entry.uncompressedLength)
    verifySectionCrc(slice, entry.sectionCrc32)
    if ((payload.byteOffset + entry.fileOffset) % 4 === 0) return slice
    const out = Buffer.alloc(entry.uncompressedLength)
    slice.copy(out, 0)
    return out
  })
}

/** Streaming compressed reader: keeps only one section in memory at a time.
 *  No `maxOutputLength` on Transform streams: output is bounded by accumulating `streamOffset`
 *  against the header's `uncompressedLength` (same 1 GiB cap checked upfront). Sync load uses
 *  `maxOutputLength` because it materializes the whole payload at once. */
function collectCompressedPayloadSections(
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
): {
  sections: Buffer[]
  consume: (chunk: Buffer) => void
  finish: () => void
} {
  if (uncompressedLength > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(MSV5_ERR_PAYLOAD_EXCEEDS_1GIB)
  }
  const sections: Buffer[] = new Array(directory.length)
  let sectionId = 0
  let streamOffset = 0
  let current: Buffer | null = null
  let payloadCrc = 0

  function emitEmptySections(): void {
    while (
      sectionId < directory.length
      && directory[sectionId].uncompressedLength === 0
      && directory[sectionId].fileOffset === streamOffset
    ) {
      verifySectionCrc(Buffer.alloc(0), directory[sectionId].sectionCrc32)
      sections[sectionId] = Buffer.alloc(0)
      sectionId++
    }
  }

  function consume(chunk: Buffer): void {
    if (streamOffset + chunk.length > uncompressedLength) {
      throw new Error(MSV5_ERR_COMPRESSED_PAYLOAD_EXCEEDS_LENGTH)
    }

    payloadCrc = crc32Update(payloadCrc, chunk)
    let off = 0

    while (off < chunk.length) {
      emitEmptySections()

      if (sectionId >= directory.length) {
        streamOffset += chunk.length - off
        return
      }

      const entry = directory[sectionId]
      if (streamOffset < entry.fileOffset) {
        const skip = Math.min(entry.fileOffset - streamOffset, chunk.length - off)
        streamOffset += skip
        off += skip
        continue
      }

      if (current == null) {
        current = Buffer.allocUnsafe(entry.uncompressedLength)
      }

      const written = streamOffset - entry.fileOffset
      const take = Math.min(entry.uncompressedLength - written, chunk.length - off)
      chunk.copy(current, written, off, off + take)
      streamOffset += take
      off += take

      if (written + take === entry.uncompressedLength) {
        verifySectionCrc(current, entry.sectionCrc32)
        sections[sectionId] = current
        current = null
        sectionId++
      }
    }
  }

  function finish(): void {
    emitEmptySections()
    if (streamOffset !== uncompressedLength || sectionId !== directory.length) {
      throw new Error(MSV5_ERR_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    if (payloadCrc !== payloadCrc32) {
      throw new Error(MSV5_ERR_PAYLOAD_CRC_MISMATCH)
    }
  }

  return { sections, consume, finish }
}

function loadMsv5SectionsFromZstdStream(
  compressed: Buffer,
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
): Promise<Buffer[]> {
  return loadMsv5SectionsFromCompressedStream(
    compressed,
    directory,
    uncompressedLength,
    payloadCrc32,
    () => zlib.createZstdDecompress(),
  )
}

function loadMsv5SectionsFromZlibStream(
  compressed: Buffer,
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
): Promise<Buffer[]> {
  return loadMsv5SectionsFromCompressedStream(
    compressed,
    directory,
    uncompressedLength,
    payloadCrc32,
    () => zlib.createInflate(),
  )
}

function loadMsv5SectionsFromCompressedStream(
  compressed: Buffer,
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
  createStream: () => Transform,
): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const collector = collectCompressedPayloadSections(directory, uncompressedLength, payloadCrc32)
    const stream = createStream()
    stream.on('data', (chunk: Buffer) => {
      try {
        collector.consume(chunk)
      } catch (err) {
        stream.destroy(err as Error)
      }
    })
    stream.on('error', reject)
    stream.on('end', () => {
      try {
        collector.finish()
        resolve(collector.sections)
      } catch (err) {
        reject(err)
      }
    })
    stream.end(compressed)
  })
}

interface PreparedPayload {
  payloadCodec: number
  slice: Buffer
  uncompressedLength: number
  payloadCrc32: number
}

/** Shared validation + bounds for both the sync and async load paths. */
function preparePayload(fileBuf: Buffer, directory: Msv5SectionEntry[]): PreparedPayload {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = prepareMsv5Payload(fileBuf, directory)
  return {
    payloadCodec,
    slice: slice as Buffer,
    uncompressedLength,
    payloadCrc32,
  }
}

function decompressPayloadSync(
  payloadCodec: number,
  slice: Buffer,
  uncompressedLength: number,
): Buffer {
  if (payloadCodec === CODEC_ZSTD) {
    if (!zstdAvailable()) {
      throw zstdUnavailableReadError()
    }
    const decoded = zlib.zstdDecompressSync(slice, {
      maxOutputLength: MSV5_MAX_UNCOMPRESSED_BYTES,
    })
    if (decoded.length !== uncompressedLength) {
      throw new Error(MSV5_ERR_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    return decoded
  }
  if (payloadCodec === CODEC_ZLIB) {
    const decoded = zlib.inflateSync(slice, {
      maxOutputLength: MSV5_MAX_UNCOMPRESSED_BYTES,
    })
    if (decoded.length !== uncompressedLength) {
      throw new Error(MSV5_ERR_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    return decoded
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
}

/** Synchronous load; peak RAM ≈ full uncompressed payload (use the async path to bound it). */
export function loadMsv5Sections(
  fileBuf: Buffer,
  directory: Msv5SectionEntry[],
): Buffer[] {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = preparePayload(fileBuf, directory)

  if (payloadCodec === CODEC_RAW) {
    return sectionsFromPayload(slice, directory, payloadCrc32)
  }
  const decoded = decompressPayloadSync(payloadCodec, slice, uncompressedLength)
  return sectionsFromPayload(decoded, directory, payloadCrc32)
}

/** Streaming load; peak main-thread RAM ≈ largest single section (+ file buffer). */
export async function loadMsv5SectionsAsync(
  fileBuf: Buffer,
  directory: Msv5SectionEntry[],
): Promise<Buffer[]> {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = preparePayload(fileBuf, directory)

  if (payloadCodec === CODEC_RAW) {
    return sectionsFromPayload(slice, directory, payloadCrc32)
  }
  if (payloadCodec === CODEC_ZSTD) {
    if (!zstdAvailable()) {
      throw zstdUnavailableReadError()
    }
    return loadMsv5SectionsFromZstdStream(slice, directory, uncompressedLength, payloadCrc32)
  }
  if (payloadCodec === CODEC_ZLIB) {
    return loadMsv5SectionsFromZlibStream(slice, directory, uncompressedLength, payloadCrc32)
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
}

export function isMsv5Buffer(buf: Buffer | Uint8Array): boolean {
  return isMsv5Bytes(buf)
}

export function readMsv5GlobalFlags(buf: Buffer | Uint8Array): number {
  return readMsv5GlobalFlagsShared(buf)
}
