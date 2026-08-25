import {
  findDocIndexInSortedSegment,
  readDocId,
  SegmentPostingList,
  shouldSeekAllowedDocs,
  type DocIdArray,
  type FreqArray,
} from './compactPostings'
import type { AggregateContext, DocIdGate, FieldBoostsForQuery, FieldTermDataLike } from './scoring'
import type { PackedIndexArray } from './PackedRadixTree/types'

export type { DocIdArray } from './compactPostings'

export type FieldIdArray = Uint8Array | Uint16Array

export function readFieldId(fieldIds: FieldIdArray, index: number): number {
  return fieldIds[index] as number
}

export type PostingsLayoutKind = 'dense' | 'sparse'

export interface FrozenPostingsLayoutBase {
  fieldCount: number
  termCount: number
  nextId: number
  docIdWidth: 16 | 32
  allDocIds: DocIdArray
  allFreqs: FreqArray
}

export interface DensePostingsLayout extends FrozenPostingsLayoutBase {
  layout: 'dense'
  denseOffsets: PackedIndexArray
  denseLengths: PackedIndexArray
}

export interface SparsePostingsLayout extends FrozenPostingsLayoutBase {
  layout: 'sparse'
  sparseFieldIdWidth: 8 | 16
  sparseTermStarts: PackedIndexArray
  sparseFieldIds: FieldIdArray
  sparseOffsets: PackedIndexArray
  sparseLengths: PackedIndexArray
}

export type FrozenPostingsLayout = DensePostingsLayout | SparsePostingsLayout

export function chooseSparseFieldIdWidth(fieldCount: number): 8 | 16 {
  return fieldCount > 255 ? 16 : 8
}

export function choosePostingsLayout(
  fieldCount: number,
  termCount: number,
  nonEmptySlots: number,
): PostingsLayoutKind {
  const denseBytes = termCount * fieldCount * 8
  const sparseFieldIdBytes = chooseSparseFieldIdWidth(fieldCount) === 16 ? 2 : 1
  const sparseBytes = (termCount + 1) * 4 + nonEmptySlots * (sparseFieldIdBytes + 8)
  return denseBytes <= sparseBytes ? 'dense' : 'sparse'
}

export function validateFrozenPostingsLayout(
  layout: FrozenPostingsLayout,
  documentCount: number,
  nextId: number,
  fail: (detail: string) => never = (detail) => { throw new Error(detail) },
): void {
  if (layout.fieldCount <= 0) fail('fieldCount must be positive')
  if (layout.nextId !== nextId) fail('nextId mismatch')
  if (layout.termCount < 0) fail('termCount out of range')
  if (layout.allDocIds.length !== layout.allFreqs.length) {
    fail('allDocIds and allFreqs length mismatch')
  }
  if (layout.layout === 'dense') {
    const slotCount = layout.termCount * layout.fieldCount
    if (layout.denseOffsets.length !== slotCount || layout.denseLengths.length !== slotCount) {
      fail('dense postings slot count mismatch')
    }
    for (let slot = 0; slot < slotCount; slot++) {
      const off = layout.denseOffsets[slot]
      const len = layout.denseLengths[slot]
      if (off + len > layout.allDocIds.length) {
        fail(`posting slot ${slot} exceeds allDocIds bounds`)
      }
      for (let i = 0; i < len; i++) {
        const docId = readDocId(layout.allDocIds, off + i)
        if (docId >= nextId) fail(`posting docId ${docId} >= nextId ${nextId}`)
      }
    }
  } else if (layout.layout === 'sparse') {
    const expectedFieldIdWidth = chooseSparseFieldIdWidth(layout.fieldCount)
    if (layout.sparseFieldIdWidth !== expectedFieldIdWidth) {
      fail('sparseFieldIdWidth mismatch with fieldCount')
    }

    const starts = layout.sparseTermStarts
    if (starts.length !== layout.termCount + 1) fail('sparseTermStarts length mismatch')
    const slotCount = layout.sparseFieldIds.length
    if (layout.sparseOffsets.length !== slotCount || layout.sparseLengths.length !== slotCount) {
      fail('sparse slot count mismatch')
    }
    for (let slot = 0; slot < slotCount; slot++) {
      const fieldId = readFieldId(layout.sparseFieldIds, slot)
      if (fieldId >= layout.fieldCount) {
        fail(`sparse fieldId ${fieldId} >= fieldCount ${layout.fieldCount}`)
      }
      const off = layout.sparseOffsets[slot]
      const len = layout.sparseLengths[slot]
      if (off + len > layout.allDocIds.length) {
        fail(`sparse slot ${slot} exceeds allDocIds bounds`)
      }
      for (let i = 0; i < len; i++) {
        const docId = readDocId(layout.allDocIds, off + i)
        if (docId >= nextId) fail(`posting docId ${docId} >= nextId ${nextId}`)
      }
    }
  } else {
    const _exhaustive: never = layout
    fail(`unknown postings layout: ${(_exhaustive as FrozenPostingsLayout).layout}`)
  }

  if (documentCount < 0 || documentCount > nextId) {
    fail('documentCount inconsistent with nextId')
  }
}

/**
 * Locate the slot for `fieldId` within a term's range.
 *
 * `sparseFieldIds[start..end)` is sorted ascending (see {@link IncrementalPostingsAccumulator}),
 * and the range is short (at most `fieldCount`, usually 1-3 fields per term). A linear
 * scan with early exit beats binary search at this size: sequential access, predictable
 * branches, no per-step division. The sorted invariant only powers the early break.
 */
function findSparseSlotByFieldId(
  fieldIds: FieldIdArray,
  start: number,
  end: number,
  fieldId: number,
): number {
  for (let i = start; i < end; i++) {
    const fid = readFieldId(fieldIds, i)
    if (fid === fieldId) return i
    if (fid > fieldId) break
  }
  return -1
}

/**
 * Module-level scratch for {@link resolvePostingSlice} (zero allocation on hot paths).
 *
 * **Threading / reentrancy:** query execution is synchronous and single-threaded today.
 * Safe while `search()` does not yield and callers do not re-enter the engine from
 * callbacks (`filter`, `boostDocument`) on the same index instance.
 * If the engine becomes async, concurrent, or shared across Workers without copying
 * the index, pass a per-query scratch (or move scratch onto the flyweight instance).
 */
const postingSliceScratch = { offset: 0, length: 0 }

/**
 * Resolve one (termIndex, fieldId) posting run in flat buffers; writes into `out` without allocating.
 * @returns false when the slot is empty or missing
 */
function resolvePostingSlice(
  layout: FrozenPostingsLayout,
  termIndex: number,
  fieldId: number,
  out: { offset: number, length: number },
): boolean {
  if (layout.layout === 'dense') {
    const base = termIndex * layout.fieldCount + fieldId
    const len = layout.denseLengths[base]
    if (len === 0) return false
    out.offset = layout.denseOffsets[base]
    out.length = len
    return true
  }

  if (layout.layout === 'sparse') {
    const start = layout.sparseTermStarts[termIndex]
    const end = layout.sparseTermStarts[termIndex + 1]
    const slot = findSparseSlotByFieldId(layout.sparseFieldIds, start, end, fieldId)
    if (slot < 0) return false
    const len = layout.sparseLengths[slot]
    if (len === 0) return false
    out.offset = layout.sparseOffsets[slot]
    out.length = len
    return true
  }

  const _exhaustive: never = layout
  return _exhaustive
}

/** Single rebindable {@link FieldTermDataLike} per frozen index (O(1) RAM). */
export type FrozenFieldTermFlyweight = FieldTermDataLike & {
  bind(termIndex: number): FrozenFieldTermFlyweight
}

/**
 * One flyweight wrapper for the lifetime of a frozen index. Call {@link bind} before each
 * `get`; the returned object is always the same instance (valid until the next `bind`).
 */
export function createFrozenFieldTermFlyweight(layout: FrozenPostingsLayout): FrozenFieldTermFlyweight {
  let termIndex = -1
  const { allDocIds, allFreqs } = layout
  const segment = new SegmentPostingList(allDocIds, allFreqs, 0, 0)

  const flyweight: FrozenFieldTermFlyweight = {
    bind(ti: number) {
      termIndex = ti
      return flyweight
    },
    get(fieldId: number) {
      if (!resolvePostingSlice(layout, termIndex, fieldId, postingSliceScratch)) return undefined
      return segment.rebind(postingSliceScratch.offset, postingSliceScratch.length)
    },
  }
  return flyweight
}

function collectDocIdsFromFrozenSegment(
  allDocIds: DocIdArray,
  offset: number,
  length: number,
  docIds: Set<number>,
  allowedDocs?: DocIdGate,
): void {
  if (allowedDocs != null && shouldSeekAllowedDocs(allowedDocs.size, length)) {
    for (const docId of allowedDocs.keys()) {
      if (findDocIndexInSortedSegment(allDocIds, offset, length, docId) >= 0) {
        docIds.add(docId)
      }
    }
    return
  }

  for (let i = 0; i < length; i++) {
    const docId = readDocId(allDocIds, offset + i)
    if (allowedDocs != null && !allowedDocs.has(docId)) continue
    docIds.add(docId)
  }
}

/** Collect docIds from flat postings without {@link FieldTermDataLike} wrappers. */
export function collectDocIdsFromFrozenLayout(
  layout: FrozenPostingsLayout,
  termIndex: number,
  fieldBoosts: FieldBoostsForQuery,
  context: AggregateContext,
  docIds: Set<number>,
  allowedDocs?: DocIdGate,
): void {
  const { fieldIds } = context

  for (const field of fieldBoosts.names) {
    if (!resolvePostingSlice(layout, termIndex, fieldIds[field], postingSliceScratch)) continue
    collectDocIdsFromFrozenSegment(
      layout.allDocIds,
      postingSliceScratch.offset,
      postingSliceScratch.length,
      docIds,
      allowedDocs,
    )
  }
}
