/**
 * Runtime stored fields. Single store field → one column (no per-doc Record at rest).
 * Wire format stays row JSON; encode/decode can skip intermediate row arrays when layout is known.
 */

export type StoredFieldsLayout
  = | { kind: 'none' }
    | { kind: 'single', field: string, values: unknown[] }
    | { kind: 'multi', rows: (Record<string, unknown> | undefined)[] }

export { storedFieldsJsonBytes, storedFieldsSlotCount } from './storedFieldsLayoutMetrics.js'

export function createStoredFieldsLayout(
  storeFields: readonly string[],
  capacity = 0,
): StoredFieldsLayout {
  if (storeFields.length === 0) return { kind: 'none' }
  if (storeFields.length === 1) {
    return { kind: 'single', field: storeFields[0], values: new Array(capacity) }
  }
  return { kind: 'multi', rows: new Array(capacity) }
}

export function writeStoredField<T>(
  layout: StoredFieldsLayout,
  shortId: number,
  storeFields: readonly string[],
  extractField: (document: T, fieldName: string) => unknown,
  document: T,
): void {
  if (layout.kind === 'none') return
  if (layout.kind === 'single') {
    layout.values[shortId] = extractField(document, layout.field)
    return
  }
  const row: Record<string, unknown> = {}
  for (const name of storeFields) {
    const value = extractField(document, name)
    if (value !== undefined) row[name] = value
  }
  layout.rows[shortId] = row
}

/** Materialize API/wire row for one document. */
export function readStoredFields(
  layout: StoredFieldsLayout,
  shortId: number,
): Record<string, unknown> | undefined {
  if (layout.kind === 'none') return undefined
  if (layout.kind === 'multi') return layout.rows[shortId]
  const value = layout.values[shortId]
  if (value === undefined) return {}
  return { [layout.field]: value }
}

/** Copy stored fields onto a public search result without materializing a row object. */
export function assignStoredFields(
  layout: StoredFieldsLayout,
  shortId: number,
  target: Record<string, unknown>,
): void {
  if (layout.kind === 'none') return
  if (layout.kind === 'single') {
    const value = layout.values[shortId]
    if (value !== undefined) target[layout.field] = value
    return
  }
  const row = layout.rows[shortId]
  if (row != null) Object.assign(target, row)
}

export function resizeStoredFields(layout: StoredFieldsLayout, length: number): StoredFieldsLayout {
  if (layout.kind === 'none') return layout
  if (layout.kind === 'single') {
    return layout.values.length <= length
      ? layout
      : { kind: 'single', field: layout.field, values: layout.values.slice(0, length) }
  }
  return layout.rows.length <= length
    ? layout
    : { kind: 'multi', rows: layout.rows.slice(0, length) }
}

export function cloneStoredFields(layout: StoredFieldsLayout): StoredFieldsLayout {
  if (layout.kind === 'none') return layout
  if (layout.kind === 'single') {
    return { kind: 'single', field: layout.field, values: layout.values.slice() }
  }
  return { kind: 'multi', rows: layout.rows.slice() }
}

/** Import from wire rows or MiniSearch snapshot. Empty storeFields + non-empty rows → multi (binary load without options). */
export function storedFieldsFromRows(
  rows: (Record<string, unknown> | undefined)[],
  storeFields: readonly string[],
): StoredFieldsLayout {
  if (storeFields.length === 0) {
    const hasAny = rows.some(row => row != null && Object.keys(row).length > 0)
    return hasAny ? { kind: 'multi', rows } : { kind: 'none' }
  }
  if (storeFields.length === 1) {
    const field = storeFields[0]
    const values = rows.map(row => row?.[field])
    return { kind: 'single', field, values }
  }
  return { kind: 'multi', rows }
}

export function storedFieldsToWireRows(
  layout: StoredFieldsLayout,
  nextId: number,
): (Record<string, unknown> | undefined)[] {
  if (layout.kind === 'multi') {
    return layout.rows.length >= nextId
      ? layout.rows
      : layout.rows.concat(new Array(nextId - layout.rows.length))
  }
  const rows: (Record<string, unknown> | undefined)[] = new Array(nextId)
  if (layout.kind === 'none') return rows
  for (let i = 0; i < nextId; i++) rows[i] = readStoredFields(layout, i)
  return rows
}
