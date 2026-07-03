import { createIdToShortIdLookup } from './frozenIdLookup'
import { materializeFieldLengthMatrix } from './fieldLengthMatrix'
import { parseSnapshotIndex } from './freezeSnapshotIndex'
import { assertFieldsMatchSnapshot, resolveFrozenOptions } from './frozenOptions'
import { storedFieldsFromRows } from './storedFieldsLayout'
import type { FrozenAssembleParams } from './frozenTypes'
import type { Options } from './searchTypes'

/** MiniSearch JSON snapshot (`toJSON` wire format, `serializationVersion` 1 or 2). */
export type SerializedIndexEntry = Record<string, number>

export type MiniSearchSnapshot = {
  documentCount: number
  nextId: number
  documentIds: { [shortId: string]: unknown }
  fieldIds: { [fieldName: string]: number }
  fieldLength: { [shortId: string]: number[] }
  averageFieldLength: number[]
  storedFields: { [shortId: string]: Record<string, unknown> | undefined }
  dirtCount?: number
  index: [string, { [fieldId: string]: SerializedIndexEntry | { ds: SerializedIndexEntry } }][]
  serializationVersion: number
}

const SUPPORTED_SERIALIZATION_VERSIONS = new Set([1, 2])
/** Sentinel short id used while compacting sparse MiniSearch snapshots to dense ids. */
const DISCARDED_DOC_ID = 0xffffffff

function snapshotError(detail: string): Error {
  return new Error(`FrozenMiniSearch: invalid MiniSearch snapshot: ${detail}`)
}

function assertRecord(value: unknown, context: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw snapshotError(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertNonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw snapshotError(`${context} must be a non-negative integer`)
  }
  return value as number
}

// Import path: validate a canonical non-negative integer key with an allocation-free
// digit scan instead of a regex.
function parseIntegerKey(key: string, context: string): number {
  const len = key.length
  let valid = len > 0
  let n = 0
  if (valid) {
    const c0 = key.charCodeAt(0)
    if (c0 < 48 || c0 > 57 || (c0 === 48 && len > 1)) {
      valid = false
    } else {
      n = c0 - 48
      for (let i = 1; i < len; i++) {
        const c = key.charCodeAt(i)
        if (c < 48 || c > 57) {
          valid = false
          break
        }
        n = n * 10 + (c - 48)
      }
    }
  }
  if (!valid || !Number.isSafeInteger(n)) {
    throw snapshotError(`${context} key "${key}" must be a non-negative integer`)
  }
  return n
}

function assertShortIdInRange(shortId: number, nextId: number, context: string): void {
  if (shortId >= nextId) {
    throw snapshotError(`${context} shortId ${shortId} must be < nextId ${nextId}`)
  }
}

// Postings segments must be sorted by docId for search (binary seek, gates). We do not
// re-check order here: MiniSearch.toJSON() emits ascending shortIds, dense remap preserves
// monotonicity, and JS integer object keys are enumerated in ascending order (for…in).

function validateFieldIds(fieldIds: Record<string, unknown>, fieldCount: number): { [fieldName: string]: number } {
  const seen = new Set<number>()
  for (const [fieldName, rawFieldId] of Object.entries(fieldIds)) {
    const fieldId = assertNonNegativeInteger(rawFieldId, `fieldIds.${fieldName}`)
    if (fieldId >= fieldCount) {
      throw snapshotError(`fieldIds.${fieldName} must be < field count ${fieldCount}`)
    }
    if (seen.has(fieldId)) {
      throw snapshotError(`fieldId ${fieldId} is assigned more than once`)
    }
    seen.add(fieldId)
  }
  if (seen.size !== fieldCount) {
    throw snapshotError(`fieldIds must contain ${fieldCount} fields`)
  }
  return fieldIds as { [fieldName: string]: number }
}

function validateActiveShortIds(
  documentIds: Record<string, unknown>,
  documentCount: number,
  nextId: number,
): number[] {
  const shortIds = Object.keys(documentIds).map((shortIdStr) => {
    const shortId = parseIntegerKey(shortIdStr, 'documentIds')
    assertShortIdInRange(shortId, nextId, 'documentIds')
    return shortId
  })
  if (shortIds.length > documentCount) {
    throw snapshotError(`documentIds count ${shortIds.length} must be <= documentCount ${documentCount}`)
  }
  shortIds.sort((a, b) => a - b)
  return shortIds
}

/** Build frozen assemble params from a MiniSearch JSON snapshot. */
export function buildFrozenAssembleParamsFromMiniSearchSnapshot<T>(
  snapshot: MiniSearchSnapshot,
  options: Options<T>,
): FrozenAssembleParams<T> {
  assertRecord(snapshot, 'snapshot')
  const serializationVersion = assertNonNegativeInteger(
    snapshot.serializationVersion,
    'serializationVersion',
  )
  if (!SUPPORTED_SERIALIZATION_VERSIONS.has(serializationVersion)) {
    throw new Error(
      `FrozenMiniSearch: unsupported MiniSearch serializationVersion ${snapshot.serializationVersion}`,
    )
  }

  const documentIds = assertRecord(snapshot.documentIds, 'documentIds')
  const rawFieldIds = assertRecord(snapshot.fieldIds, 'fieldIds')
  const fieldLength = assertRecord(snapshot.fieldLength, 'fieldLength')
  const storedFieldSnapshot = assertRecord(snapshot.storedFields, 'storedFields')
  if (!Array.isArray(snapshot.index)) {
    throw snapshotError('index must be an array')
  }
  if (!Array.isArray(snapshot.averageFieldLength)) {
    throw snapshotError('averageFieldLength must be an array')
  }

  const snapshotFieldNames = Object.keys(snapshot.fieldIds)
  const fields = options.fields?.length ? options.fields : snapshotFieldNames
  if (options.fields?.length) {
    assertFieldsMatchSnapshot(fields, snapshot.fieldIds)
  }
  const opts = resolveFrozenOptions({ ...options, fields })

  const fieldCount = opts.fields.length
  const documentCount = assertNonNegativeInteger(snapshot.documentCount, 'documentCount')
  const nextId = assertNonNegativeInteger(snapshot.nextId, 'nextId')
  if (documentCount > nextId) {
    throw snapshotError(`documentCount ${documentCount} must be <= nextId ${nextId}`)
  }
  const fieldIds = validateFieldIds(rawFieldIds, fieldCount)
  const activeShortIds = validateActiveShortIds(documentIds, documentCount, nextId)
  const activeShortIdSet = new Set(activeShortIds)
  for (const shortIdStr of Object.keys(storedFieldSnapshot)) {
    const shortId = parseIntegerKey(shortIdStr, 'storedFields')
    assertShortIdInRange(shortId, nextId, 'storedFields')
    if (!activeShortIdSet.has(shortId)) {
      throw snapshotError(`storedFields shortId ${shortId} is missing from documentIds`)
    }
  }
  if (snapshot.averageFieldLength.length !== fieldCount) {
    throw snapshotError(`averageFieldLength length must equal field count ${fieldCount}`)
  }
  for (let f = 0; f < fieldCount; f++) {
    const avg = snapshot.averageFieldLength[f]
    if (!Number.isFinite(avg) || avg < 0) {
      throw snapshotError(`averageFieldLength field ${f} must be a non-negative number`)
    }
  }
  const useDense = documentCount < nextId

  let shortIdRemap: Uint32Array | null = null
  const resolvedNextId = useDense ? documentCount : nextId
  const externalIds: unknown[] = new Array(resolvedNextId)
  const storedFieldRows: (Record<string, unknown> | undefined)[] = new Array(externalIds.length)

  if (useDense) {
    shortIdRemap = new Uint32Array(nextId)
    shortIdRemap.fill(DISCARDED_DOC_ID)
    let dense = 0
    const sortedShortIds = activeShortIds
    for (const shortId of sortedShortIds) {
      const shortIdStr = String(shortId)
      shortIdRemap[shortId] = dense
      externalIds[dense] = documentIds[shortIdStr]
      storedFieldRows[dense] = storedFieldSnapshot[shortIdStr] as Record<string, unknown> | undefined
      dense++
    }
  } else {
    for (const [shortIdStr, id] of Object.entries(documentIds)) {
      const shortId = parseIntegerKey(shortIdStr, 'documentIds')
      externalIds[shortId] = id
      storedFieldRows[shortId] = storedFieldSnapshot[shortIdStr] as Record<string, unknown> | undefined
    }
  }

  const idLookup = createIdToShortIdLookup(externalIds, resolvedNextId)

  const matrixRows = useDense ? documentCount : nextId
  const matrixCells = matrixRows * fieldCount
  const fieldLengthScratch: number[] = new Array(matrixCells).fill(0)
  // Single pass over fieldLength: validate keys/rows + fill the matrix + track
  // coverage (every active document must carry a fieldLength row).
  let fieldLengthCovered = 0
  for (const [shortIdStr, lengths] of Object.entries(fieldLength)) {
    const shortId = parseIntegerKey(shortIdStr, 'fieldLength')
    assertShortIdInRange(shortId, nextId, 'fieldLength')
    if (!activeShortIdSet.has(shortId)) {
      throw snapshotError(`fieldLength shortId ${shortId} is missing from documentIds`)
    }
    if (!Array.isArray(lengths)) {
      throw snapshotError(`fieldLength shortId ${shortId} must be an array`)
    }
    const row = shortIdRemap != null ? shortIdRemap[shortId] : shortId
    const rowBase = row * fieldCount
    for (let f = 0; f < fieldCount; f++) {
      const length = (lengths as number[])[f] ?? 0
      if (!Number.isFinite(length) || length < 0) {
        throw snapshotError(`fieldLength shortId ${shortId} field ${f} must be a non-negative number`)
      }
      fieldLengthScratch[rowBase + f] = length
    }
    fieldLengthCovered++
  }
  if (fieldLengthCovered !== activeShortIds.length) {
    throw snapshotError(`fieldLength must cover all ${activeShortIds.length} active documents (got ${fieldLengthCovered})`)
  }
  const fieldLengthMatrix = materializeFieldLengthMatrix(fieldLengthScratch)

  const avgFieldLength = new Float32Array(snapshot.averageFieldLength.length)
  for (let i = 0; i < snapshot.averageFieldLength.length; i++) {
    avgFieldLength[i] = snapshot.averageFieldLength[i]
  }

  const parsedIndex = parseSnapshotIndex(snapshot, fieldCount, nextId, shortIdRemap)
  const postings = parsedIndex.accumulator.finalize(parsedIndex.termCount, resolvedNextId)

  const storedFields = storedFieldsFromRows(storedFieldRows, opts.storeFields)

  return {
    options: opts,
    documentCount,
    nextId: resolvedNextId,
    fieldIds,
    fieldCount,
    externalIds,
    idLookup,
    storedFields,
    fieldLengthMatrix,
    avgFieldLength,
    index: parsedIndex.index,
    termCount: parsedIndex.termCount,
    postings,
  }
}
