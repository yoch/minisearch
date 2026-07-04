import {
  allocBytes,
  type BinaryBytes,
} from '../binaryBytes'
import { crc32Bytes } from '../crc32Wire'
import type { BrowserBinaryCompression } from '../searchTypes'
import type { Msv5SectionEntry, Msv5SnapshotCompressionMeta } from './binaryMsv5Types'
import {
  CODEC_RAW,
  CODEC_ZSTD,
  CODEC_ZLIB,
  MSV5_ERR_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH,
  MSV5_ERR_PAYLOAD_CRC_MISMATCH,
  MSV5_ERR_PAYLOAD_EXCEEDS_1GIB,
  MSV5_ERR_SECTION_CRC_MISMATCH,
  MSV5_HEADER_SIZE,
  MSV5_MIN_COMPRESS_BYTES,
} from './binaryMsv5Constants'
import { browserZlibDeflateAsync, browserZlibInflateAsync } from './compressionBrowser'
import {
  computeSectionDirectory,
  concatRawSectionsWithCrc,
  writeRawSectionsIntoPayload,
} from './binaryMsv5PayloadAssembly'
import {
  assertRawSectionCount,
  buildMsv5CompressionMeta,
  isMsv5Bytes as isMsv5BytesShared,
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

export interface Msv5AssembledFileBrowser {
  buffer: Uint8Array
  globalFlags: number
  compression: Msv5SnapshotCompressionMeta
}

function zstdUnavailableWriteError(): Error {
  return new Error(
    'MSv5 snapshot requested zstd compression, which is not supported in the browser build. '
    + 'Use compression: "auto", "raw", or "zlib".',
  )
}

function zstdUnavailableReadError(): Error {
  return new Error(
    'MSv5 snapshot is zstd-compressed, which is not supported in the browser build. '
    + 'Re-save with compression: "raw" or "zlib".',
  )
}

type PayloadCodecChoice = Msv5PayloadCodecChoice<BinaryBytes>

async function zlibPayloadChoiceAsync(uncompressed: BinaryBytes): Promise<PayloadCodecChoice> {
  return { payload: await browserZlibDeflateAsync(uncompressed), codec: CODEC_ZLIB, zstdLevel: 0 }
}

async function autoPayloadChoiceAsync(uncompressed: BinaryBytes): Promise<PayloadCodecChoice> {
  if (uncompressed.length < MSV5_MIN_COMPRESS_BYTES) {
    return rawPayloadChoice(uncompressed)
  }
  return pickAutoPayloadCodec(uncompressed, await browserZlibDeflateAsync(uncompressed), CODEC_ZLIB)
}

async function choosePayloadCodecAsync(
  uncompressed: BinaryBytes,
  compression: BrowserBinaryCompression | 'zstd' = 'auto',
): Promise<PayloadCodecChoice> {
  if (compression === 'zstd') {
    throw zstdUnavailableWriteError()
  }
  switch (compression) {
    case 'raw':
      return rawPayloadChoice(uncompressed)
    case 'zlib':
      return await zlibPayloadChoiceAsync(uncompressed)
    case 'auto':
      return await autoPayloadChoiceAsync(uncompressed)
    default: {
      const _exhaustive: never = compression
      return _exhaustive
    }
  }
}

function concatAndValidateSections(rawSections: BinaryBytes[]): {
  uncompressed: BinaryBytes
  entries: Msv5SectionEntry[]
  payloadCrc32: number
} {
  assertRawSectionCount(rawSections)
  const result = concatRawSectionsWithCrc(rawSections, allocBytes)
  if (result.uncompressed.length > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(MSV5_ERR_PAYLOAD_EXCEEDS_1GIB)
  }
  return result
}

function assembleMsv5FileRawDirect(
  globalFlags: number,
  rawSections: BinaryBytes[],
): Msv5AssembledFileBrowser {
  assertRawSectionCount(rawSections)
  const { entries, uncompressedLength } = computeSectionDirectory(rawSections)
  if (uncompressedLength > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(MSV5_ERR_PAYLOAD_EXCEEDS_1GIB)
  }

  const out = allocBytes(MSV5_HEADER_SIZE + uncompressedLength)
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

function buildMsv5AssembledFile(
  globalFlags: number,
  entries: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
  payload: BinaryBytes,
  codec: number,
  zstdLevel: number,
): Msv5AssembledFileBrowser {
  const out = allocBytes(MSV5_HEADER_SIZE + payload.length)
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
  out.set(payload, MSV5_HEADER_SIZE)

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

export async function assembleMsv5FileBrowser(
  globalFlags: number,
  rawSections: BinaryBytes[],
  compression: BrowserBinaryCompression = 'auto',
): Promise<Msv5AssembledFileBrowser> {
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

export function readMsv5SectionDirectory(buf: BinaryBytes): Msv5SectionEntry[] {
  return readMsv5SectionDirectoryShared(buf)
}

export function readMsv5SnapshotCompressionMetaBrowser(buf: BinaryBytes): Msv5SnapshotCompressionMeta {
  return readMsv5SnapshotCompressionMetaShared(buf)
}

function verifySectionCrc(section: BinaryBytes, expected: number): void {
  if (crc32Bytes(section) !== expected) {
    throw new Error(MSV5_ERR_SECTION_CRC_MISMATCH)
  }
}

function sectionsFromPayload(
  payload: BinaryBytes,
  directory: Msv5SectionEntry[],
  payloadCrc32: number,
): BinaryBytes[] {
  if (crc32Bytes(payload) !== payloadCrc32) {
    throw new Error(MSV5_ERR_PAYLOAD_CRC_MISMATCH)
  }
  return directory.map((entry) => {
    const slice = payload.subarray(entry.fileOffset, entry.fileOffset + entry.uncompressedLength)
    verifySectionCrc(slice, entry.sectionCrc32)
    if ((payload.byteOffset + entry.fileOffset) % 4 === 0) return slice
    const out = allocBytes(entry.uncompressedLength)
    out.set(slice)
    return out
  })
}

async function decompressPayloadAsync(
  payloadCodec: number,
  slice: BinaryBytes,
  uncompressedLength: number,
): Promise<BinaryBytes> {
  if (payloadCodec === CODEC_ZSTD) {
    throw zstdUnavailableReadError()
  }
  if (payloadCodec === CODEC_ZLIB) {
    const decoded = await browserZlibInflateAsync(slice)
    if (decoded.length !== uncompressedLength) {
      throw new Error(MSV5_ERR_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    return decoded
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
}

export async function loadMsv5SectionsBrowser(
  fileBuf: BinaryBytes,
  directory: Msv5SectionEntry[],
): Promise<BinaryBytes[]> {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = prepareMsv5Payload(fileBuf, directory)

  if (payloadCodec === CODEC_RAW) {
    return sectionsFromPayload(slice, directory, payloadCrc32)
  }
  const decoded = await decompressPayloadAsync(payloadCodec, slice, uncompressedLength)
  return sectionsFromPayload(decoded, directory, payloadCrc32)
}

export function isMsv5Bytes(buf: BinaryBytes): boolean {
  return isMsv5BytesShared(buf)
}

export function readMsv5GlobalFlagsBrowser(buf: BinaryBytes): number {
  return readMsv5GlobalFlagsShared(buf)
}
