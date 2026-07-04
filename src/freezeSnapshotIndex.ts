import { packTermsFromList } from './PackedRadixTree/packTermList'
import { IncrementalPostingsAccumulator } from './incrementalPostings'
import {
  assertFieldIdInRange,
  assertShortIdInRange,
  parseCanonicalIntegerKey,
  snapshotError,
} from './snapshotValidation'
import type PackedRadixTree from './PackedRadixTree'
import type { MiniSearchSnapshot } from './fromMiniSearch'

/** Sentinel short id used while compacting sparse MiniSearch snapshots to dense ids. */
const DISCARDED_DOC_ID = 0xffffffff

type ParsedSnapshotIndex = {
  index: PackedRadixTree
  accumulator: IncrementalPostingsAccumulator
  termCount: number
}

export type SnapshotIndexAccumulation = {
  terms: string[]
  accumulator: IncrementalPostingsAccumulator
  termCount: number
}

/** Hot-path canonical integer key parse for MiniSearch wire keys. */
function parseIndexIntegerKey(key: string, label: 'fieldId' | 'shortId'): number {
  return parseCanonicalIntegerKey(key, `index ${label}`)
}

function readPostingFrequency(value: unknown): number {
  const freq = value as number
  if (!Number.isSafeInteger(freq) || freq <= 0) {
    throw snapshotError('index posting frequency must be a positive integer')
  }
  return freq
}

function accumulateSnapshotIndexV2(
  entries: MiniSearchSnapshot['index'],
  fieldCount: number,
  nextId: number,
  shortIdRemap: Uint32Array | null,
): SnapshotIndexAccumulation {
  const termCount = entries.length
  const terms: string[] = new Array(termCount)
  const accumulator = new IncrementalPostingsAccumulator(fieldCount)

  for (let termIndex = 0; termIndex < termCount; termIndex++) {
    const entry = entries[termIndex]!
    const term = entry[0] as string
    terms[termIndex] = term
    const dataRecord = entry[1] as Record<string, Record<string, number>>
    for (const fieldId in dataRecord) {
      const parsedFieldId = parseIndexIntegerKey(fieldId, 'fieldId')
      assertFieldIdInRange(parsedFieldId, fieldCount, 'index')
      const indexEntryRecord = dataRecord[fieldId]!
      for (const docId in indexEntryRecord) {
        const shortId = parseIndexIntegerKey(docId, 'shortId')
        assertShortIdInRange(shortId, nextId, 'index')
        const resolvedDocId = shortIdRemap != null ? shortIdRemap[shortId]! : shortId
        if (resolvedDocId === DISCARDED_DOC_ID) continue
        accumulator.append(
          termIndex,
          parsedFieldId,
          resolvedDocId,
          readPostingFrequency(indexEntryRecord[docId]),
        )
      }
    }
  }

  return { terms, accumulator, termCount }
}

function accumulateSnapshotIndexV1(
  entries: MiniSearchSnapshot['index'],
  fieldCount: number,
  nextId: number,
  shortIdRemap: Uint32Array | null,
): SnapshotIndexAccumulation {
  const termCount = entries.length
  const terms: string[] = new Array(termCount)
  const accumulator = new IncrementalPostingsAccumulator(fieldCount)

  for (let termIndex = 0; termIndex < termCount; termIndex++) {
    const entry = entries[termIndex]!
    const term = entry[0] as string
    terms[termIndex] = term
    const dataRecord = entry[1] as Record<string, unknown>
    for (const fieldId in dataRecord) {
      const parsedFieldId = parseIndexIntegerKey(fieldId, 'fieldId')
      assertFieldIdInRange(parsedFieldId, fieldCount, 'index')
      const raw = dataRecord[fieldId]
      const indexEntryRecord = raw != null && typeof raw === 'object' && 'ds' in raw
        ? (raw as { ds: Record<string, number> }).ds
        : raw as Record<string, number>
      for (const docId in indexEntryRecord) {
        const shortId = parseIndexIntegerKey(docId, 'shortId')
        assertShortIdInRange(shortId, nextId, 'index')
        const resolvedDocId = shortIdRemap != null ? shortIdRemap[shortId]! : shortId
        if (resolvedDocId === DISCARDED_DOC_ID) continue
        accumulator.append(
          termIndex,
          parsedFieldId,
          resolvedDocId,
          readPostingFrequency(indexEntryRecord[docId]),
        )
      }
    }
  }

  return { terms, accumulator, termCount }
}

export function accumulateSnapshotIndex(
  snapshot: MiniSearchSnapshot,
  fieldCount: number,
  nextId: number,
  shortIdRemap: Uint32Array | null = null,
): SnapshotIndexAccumulation {
  const { index: entries, serializationVersion } = snapshot
  if (!Array.isArray(entries)) {
    throw snapshotError('index must be an array')
  }
  if (serializationVersion === 1) {
    return accumulateSnapshotIndexV1(entries, fieldCount, nextId, shortIdRemap)
  }
  return accumulateSnapshotIndexV2(entries, fieldCount, nextId, shortIdRemap)
}

export function parseSnapshotIndex(
  snapshot: MiniSearchSnapshot,
  fieldCount: number,
  nextId: number,
  shortIdRemap: Uint32Array | null = null,
): ParsedSnapshotIndex {
  const accumulated = accumulateSnapshotIndex(snapshot, fieldCount, nextId, shortIdRemap)
  return {
    index: packTermsFromList(accumulated.terms),
    accumulator: accumulated.accumulator,
    termCount: accumulated.termCount,
  }
}
