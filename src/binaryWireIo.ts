import type { FieldIdArray } from './frozenPostings'
import {
  ID_TAG_EMPTY,
  ID_TAG_JSON,
  ID_TAG_NUMBER,
  ID_TAG_STRING,
} from './binaryConstants'
import {
  allocBytes,
  concatBytes,
  readDoubleLE,
  readFloatLE,
  readU8,
  readU32LE,
  readUtf8,
  utf8Bytes,
  writeDoubleLE,
  writeU32LE,
  type BinaryBytes,
} from './binaryBytes'
import { invalidFrozenIndex } from './frozenErrors'
import { buildStoredFieldsRowsWireSection } from './storedFieldsWire'

export function readLengthPrefixedUtf8(buf: BinaryBytes, offset: number): { value: string, next: number } {
  if (offset + 4 > buf.length) {
    throw invalidFrozenIndex('length-prefixed string header truncated')
  }
  const len = readU32LE(buf, offset)
  const start = offset + 4
  const end = start + len
  if (end > buf.length) {
    throw invalidFrozenIndex('length-prefixed string body out of bounds')
  }
  return { value: readUtf8(buf, start, end), next: end }
}

export function writeLengthPrefixedUtf8(chunks: BinaryBytes[], str: string): void {
  const body = utf8Bytes(str)
  const header = allocBytes(4)
  writeU32LE(header, 0, body.length)
  chunks.push(header, body)
}

export function writeExternalId(chunks: BinaryBytes[], id: unknown): void {
  if (id === undefined) {
    chunks.push(new Uint8Array([ID_TAG_EMPTY]))
    return
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    const header = allocBytes(9)
    header[0] = ID_TAG_NUMBER
    writeDoubleLE(header, 1, id)
    chunks.push(header)
    return
  }
  if (typeof id === 'string') {
    chunks.push(new Uint8Array([ID_TAG_STRING]))
    writeLengthPrefixedUtf8(chunks, id)
    return
  }
  chunks.push(new Uint8Array([ID_TAG_JSON]))
  writeLengthPrefixedUtf8(chunks, JSON.stringify(id))
}

export function readExternalId(buf: BinaryBytes, offset: number): { value: unknown | undefined, next: number } {
  if (offset >= buf.length) {
    throw invalidFrozenIndex('external id tag truncated')
  }
  const tag = readU8(buf, offset)
  if (tag === ID_TAG_EMPTY) {
    return { value: undefined, next: offset + 1 }
  }
  if (tag === ID_TAG_NUMBER) {
    if (offset + 9 > buf.length) {
      throw invalidFrozenIndex('external id number truncated')
    }
    return { value: readDoubleLE(buf, offset + 1), next: offset + 9 }
  }
  if (tag === ID_TAG_STRING) {
    const { value, next } = readLengthPrefixedUtf8(buf, offset + 1)
    return { value, next }
  }
  if (tag === ID_TAG_JSON) {
    const { value, next } = readLengthPrefixedUtf8(buf, offset + 1)
    return { value: JSON.parse(value), next }
  }
  throw invalidFrozenIndex(`unknown external id tag ${tag}`)
}

export function readUint32Array(buf: BinaryBytes, offset: number, byteLength: number): Uint32Array {
  if (byteLength === 0) return new Uint32Array(0)
  if (byteLength % 4 !== 0) {
    throw invalidFrozenIndex('uint32 section length not aligned')
  }
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint32 section read past buffer end')
  }
  if (offset % 4 === 0) {
    return new Uint32Array(buf.buffer, buf.byteOffset + offset, byteLength / 4)
  }
  const out = new Uint32Array(byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = readU32LE(buf, offset + i * 4)
  return out
}

export function readUint16Array(buf: BinaryBytes, offset: number, byteLength: number): Uint16Array {
  if (byteLength === 0) return new Uint16Array(0)
  if (byteLength % 2 !== 0) {
    throw invalidFrozenIndex('uint16 section length not aligned')
  }
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint16 section read past buffer end')
  }
  if (offset % 2 === 0) {
    return new Uint16Array(buf.buffer, buf.byteOffset + offset, byteLength / 2)
  }
  const out = new Uint16Array(byteLength / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = buf[offset + i * 2] | (buf[offset + i * 2 + 1] << 8)
  }
  return out
}

export function readUint8Array(buf: BinaryBytes, offset: number, byteLength: number): Uint8Array {
  if (byteLength === 0) return new Uint8Array(0)
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint8 section read past buffer end')
  }
  return buf.subarray(offset, offset + byteLength)
}

export function readFloat32Array(buf: BinaryBytes, offset: number, byteLength: number): Float32Array {
  if (byteLength === 0) return new Float32Array(0)
  if (byteLength % 4 !== 0) {
    throw invalidFrozenIndex('float32 section length not aligned')
  }
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('float32 section read past buffer end')
  }
  if (offset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset + offset, byteLength / 4)
  }
  const out = new Float32Array(byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = readFloatLE(buf, offset + i * 4)
  return out
}

export function readFieldIdArray(buf: BinaryBytes, offset: number, byteLength: number, width: 8 | 16): FieldIdArray {
  if (width === 8) return readUint8Array(buf, offset, byteLength)
  return readUint16Array(buf, offset, byteLength)
}

export function buildCoreSectionWithTermCountWire(
  documentCount: number,
  nextId: number,
  fieldCount: number,
  termCount: number,
): BinaryBytes {
  const out = allocBytes(16)
  writeU32LE(out, 0, documentCount)
  writeU32LE(out, 4, nextId)
  writeU32LE(out, 8, fieldCount)
  writeU32LE(out, 12, termCount)
  return out
}

export function buildFieldNamesSectionWire(fieldNames: string[]): BinaryBytes {
  const chunks: BinaryBytes[] = []
  for (const name of fieldNames) {
    writeLengthPrefixedUtf8(chunks, name)
  }
  return concatBytes(chunks)
}

export function buildExternalIdsSectionWire(externalIds: unknown[], nextId: number): BinaryBytes {
  const chunks: BinaryBytes[] = []
  for (let i = 0; i < nextId; i++) {
    writeExternalId(chunks, externalIds[i])
  }
  return concatBytes(chunks)
}

export function buildStoredFieldsSectionWire(
  storedFields: (Record<string, unknown> | undefined)[],
  nextId: number,
): BinaryBytes {
  return buildStoredFieldsRowsWireSection(storedFields, nextId)
}
