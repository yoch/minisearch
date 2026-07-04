import {
  allocBytes,
  concatBytes,
  readU32LE,
  readUtf8,
  utf8Bytes,
  writeU32LE,
  type BinaryBytes,
} from './binaryBytes'
import { invalidFrozenIndex } from './frozenErrors'
import {
  storedFieldsFromRows,
  type StoredFieldsLayout,
} from './storedFieldsLayout'

function appendStoredFieldJsonEntry(
  table: BinaryBytes,
  heapChunks: BinaryBytes[],
  heapOffRef: { value: number },
  docIndex: number,
  jsonUtf8: BinaryBytes,
): void {
  writeU32LE(table, docIndex * 4, heapOffRef.value + 1)
  const entry = allocBytes(4 + jsonUtf8.length)
  writeU32LE(entry, 0, jsonUtf8.length)
  entry.set(jsonUtf8, 4)
  heapChunks.push(entry)
  heapOffRef.value += entry.length
}

export function buildStoredFieldsRowsWireSection(
  storedFields: (Record<string, unknown> | undefined)[],
  nextId: number,
): BinaryBytes {
  const table = allocBytes(nextId * 4)
  const heapChunks: BinaryBytes[] = []
  const heapOffRef = { value: 0 }
  for (let i = 0; i < nextId; i++) {
    const row = storedFields[i]
    if (row == null) {
      writeU32LE(table, i * 4, 0)
      continue
    }
    appendStoredFieldJsonEntry(table, heapChunks, heapOffRef, i, utf8Bytes(JSON.stringify(row)))
  }
  return heapChunks.length === 0 ? table : concatBytes([table, ...heapChunks])
}

/** MSv5 StoredFields section from {@link StoredFieldsLayout} (no intermediate row array). */
export function buildStoredFieldsWireSection(layout: StoredFieldsLayout, nextId: number): BinaryBytes {
  if (layout.kind === 'multi') {
    const rows = layout.rows.length >= nextId
      ? layout.rows
      : layout.rows.concat(new Array(nextId - layout.rows.length))
    return buildStoredFieldsRowsWireSection(rows, nextId)
  }

  const table = allocBytes(nextId * 4)
  if (layout.kind === 'none') return table

  const heapChunks: BinaryBytes[] = []
  const heapOffRef = { value: 0 }
  const { field, values } = layout
  for (let i = 0; i < nextId; i++) {
    const value = values[i]
    if (value === undefined) continue
    const jsonUtf8 = utf8Bytes(JSON.stringify({ [field]: value }))
    appendStoredFieldJsonEntry(table, heapChunks, heapOffRef, i, jsonUtf8)
  }
  return heapChunks.length === 0 ? table : concatBytes([table, ...heapChunks])
}

function storedFieldsTableEnd(storedOff: number, nextId: number, sectionEnd: number): number {
  const tableEnd = storedOff + nextId * 4
  if (tableEnd > sectionEnd) {
    throw invalidFrozenIndex('stored fields table out of bounds')
  }
  return tableEnd
}

function readStoredFieldJsonAt(
  buf: BinaryBytes,
  tableEnd: number,
  sectionEnd: number,
  rel: number,
): Record<string, unknown> {
  const entryOff = tableEnd + rel - 1
  if (entryOff + 4 > sectionEnd) {
    throw invalidFrozenIndex('stored fields entry offset out of bounds')
  }
  const jsonLen = readU32LE(buf, entryOff)
  const jsonStart = entryOff + 4
  const jsonEnd = jsonStart + jsonLen
  if (jsonEnd > sectionEnd) {
    throw invalidFrozenIndex('stored fields JSON out of bounds')
  }
  return JSON.parse(readUtf8(buf, jsonStart, jsonEnd)) as Record<string, unknown>
}

/** MSv5 StoredFields section → layout (skips row materialization when storeFields hint allows). */
export function readStoredFieldsWireSection(
  buf: BinaryBytes,
  storedOff: number,
  nextId: number,
  sectionEnd: number,
  storeFields: readonly string[],
): StoredFieldsLayout {
  const tableEnd = storedFieldsTableEnd(storedOff, nextId, sectionEnd)

  if (storeFields.length === 1) {
    const field = storeFields[0]
    const values: unknown[] = new Array(nextId)
    for (let i = 0; i < nextId; i++) {
      const rel = readU32LE(buf, storedOff + i * 4)
      if (rel === 0) continue
      const row = readStoredFieldJsonAt(buf, tableEnd, sectionEnd, rel)
      values[i] = row[field]
    }
    return { kind: 'single', field, values }
  }

  if (storeFields.length === 0) {
    let hasAny = false
    for (let i = 0; i < nextId; i++) {
      if (readU32LE(buf, storedOff + i * 4) !== 0) {
        hasAny = true
        break
      }
    }
    if (!hasAny) return { kind: 'none' }
  }

  const rows = readStoredFieldsRowsSection(buf, storedOff, nextId, sectionEnd)
  return storedFieldsFromRows(rows, storeFields)
}

export function readStoredFieldsRowsSection(
  buf: BinaryBytes,
  storedOff: number,
  nextId: number,
  sectionEnd: number,
): (Record<string, unknown> | undefined)[] {
  const tableEnd = storedFieldsTableEnd(storedOff, nextId, sectionEnd)
  const rows: (Record<string, unknown> | undefined)[] = new Array(nextId)
  for (let i = 0; i < nextId; i++) {
    const rel = readU32LE(buf, storedOff + i * 4)
    if (rel === 0) {
      rows[i] = undefined
      continue
    }
    rows[i] = readStoredFieldJsonAt(buf, tableEnd, sectionEnd, rel)
  }
  return rows
}
