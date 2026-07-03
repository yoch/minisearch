import {
  allocateFreqs,
  clampFreq,
  type DocIdArray,
  type FreqArray,
} from './compactPostings'
import { packedIndexArray } from './PackedRadixTree/layout'
import {
  choosePostingsLayout,
  chooseSparseFieldIdWidth,
  type FieldIdArray,
  type FrozenPostingsLayout,
} from './frozenPostings'

const DEFAULT_CAPACITY = 16
const GROWTH_FACTOR = 2

/** @internal Growable column sizing policy (production uses {@link GROWTH_FACTOR}). */
export function nextGrowableCapacity(currentLength: number, growthFactor = GROWTH_FACTOR): number {
  if (!Number.isFinite(growthFactor) || growthFactor <= 1) {
    throw new Error(`growable capacity growthFactor must be > 1, got ${growthFactor}`)
  }
  return Math.max(1, Math.ceil(currentLength * growthFactor))
}

export type SimulatedColumnGrowth = {
  growEvents: number
  bytesCopied: number
  peakCapacity: number
  finalCapacity: number
  overshoot: number
}

/**
 * @internal Simulate repeated push growth for one column (e.g. compare ×2 vs ×1.5).
 * `elementBytes` is the width of one slot (4 for u32 slotIds, 2 for u16 docIds, etc.).
 */
export function simulateColumnGrowth(
  itemCount: number,
  elementBytes: number,
  initialCapacity = DEFAULT_CAPACITY,
  growthFactor = GROWTH_FACTOR,
): SimulatedColumnGrowth {
  let capacity = Math.max(1, initialCapacity)
  let length = 0
  let growEvents = 0
  let bytesCopied = 0
  let peakCapacity = capacity

  while (length < itemCount) {
    if (length >= capacity) {
      bytesCopied += capacity * elementBytes
      growEvents++
      capacity = nextGrowableCapacity(capacity, growthFactor)
      if (capacity > peakCapacity) peakCapacity = capacity
    }
    length++
  }

  return {
    growEvents,
    bytesCopied,
    peakCapacity,
    finalCapacity: capacity,
    overshoot: capacity - itemCount,
  }
}

type GrowStats = {
  growEvents: number
  bytesCopied: number
}

let lastGrowStats: GrowStats = { growEvents: 0, bytesCopied: 0 }

/** @internal Freeze benchmark profiler. */
export function resetIncrementalGrowStats(): void {
  lastGrowStats = { growEvents: 0, bytesCopied: 0 }
}

/** @internal Freeze benchmark profiler. */
export function readIncrementalGrowStats(): GrowStats {
  return { ...lastGrowStats }
}

function recordGrow(bytesCopied: number): void {
  lastGrowStats.growEvents++
  lastGrowStats.bytesCopied += bytesCopied
}

type GrowableDocIdArray = Uint16Array | Uint32Array
type GrowableFreqArray = Uint8Array | Uint16Array

function packedColumnFromUint32(values: Uint32Array, maxValue: number): Uint8Array | Uint16Array | Uint32Array {
  const out = packedIndexArray(values.length, maxValue)
  out.set(values)
  return out
}

function packedColumnFromNumbers(values: readonly number[], maxValue: number): Uint8Array | Uint16Array | Uint32Array {
  const out = packedIndexArray(values.length, maxValue)
  out.set(values)
  return out
}

/** Growable unsigned 32-bit column (build scratch; narrowed to u16 at finalize when possible). */
class GrowableUint32Column {
  private _buf: Uint32Array
  private _len = 0

  constructor(initialCapacity = DEFAULT_CAPACITY) {
    this._buf = new Uint32Array(Math.max(1, initialCapacity))
  }

  get length(): number {
    return this._len
  }

  get(index: number): number {
    return this._buf[index]!
  }

  push(value: number): void {
    if (this._len >= this._buf.length) {
      const grown = new Uint32Array(nextGrowableCapacity(this._buf.length))
      recordGrow(this._buf.byteLength)
      grown.set(this._buf)
      this._buf = grown
    }
    this._buf[this._len++] = value
  }

  truncate(length: number): void {
    this._len = length
    if (length > 0 && length < this._buf.length) {
      this._buf = this._buf.slice(0, length)
    }
  }

  release(): void {
    this._buf = new Uint32Array(1)
    this._len = 0
  }
}

/** Growable doc-id column; starts u16 and promotes to u32 only past the boundary. */
class GrowableDocIdColumn {
  private _buf: GrowableDocIdArray
  private _len = 0

  constructor(initialCapacity = DEFAULT_CAPACITY) {
    this._buf = new Uint16Array(Math.max(1, initialCapacity))
  }

  get length(): number {
    return this._len
  }

  get(index: number): number {
    return this._buf[index]!
  }

  private grow(minCapacity: number): void {
    const grown = this._buf instanceof Uint16Array
      ? new Uint16Array(minCapacity)
      : new Uint32Array(minCapacity)
    recordGrow(this._buf.byteLength)
    grown.set(this._buf)
    this._buf = grown
  }

  private promote(): void {
    if (this._buf instanceof Uint32Array) return
    recordGrow(this._buf.byteLength)
    const promoted = new Uint32Array(this._buf.length)
    promoted.set(this._buf)
    this._buf = promoted
  }

  push(value: number): void {
    if (value > 0xffff) this.promote()
    if (this._len >= this._buf.length) {
      this.grow(nextGrowableCapacity(this._buf.length))
    }
    this._buf[this._len++] = value
  }

  truncate(length: number): void {
    this._len = length
    if (length > 0 && length < this._buf.length) {
      this._buf = this._buf.slice(0, length)
    }
  }

  release(): void {
    this._buf = new Uint16Array(1)
    this._len = 0
  }
}

/** Growable frequency column; starts u8 and promotes to u16 only when needed. */
class GrowableFreqColumn {
  private _buf: GrowableFreqArray
  private _len = 0

  constructor(initialCapacity = DEFAULT_CAPACITY) {
    this._buf = new Uint8Array(Math.max(1, initialCapacity))
  }

  get length(): number {
    return this._len
  }

  get(index: number): number {
    return this._buf[index]!
  }

  private grow(minCapacity: number): void {
    const grown = this._buf instanceof Uint8Array
      ? new Uint8Array(minCapacity)
      : new Uint16Array(minCapacity)
    recordGrow(this._buf.byteLength)
    grown.set(this._buf)
    this._buf = grown
  }

  private promote(): void {
    if (this._buf instanceof Uint16Array) return
    recordGrow(this._buf.byteLength)
    const promoted = new Uint16Array(this._buf.length)
    promoted.set(this._buf)
    this._buf = promoted
  }

  push(freq: number): number {
    const v = clampFreq(freq)
    if (v > 0xff) this.promote()
    if (this._len >= this._buf.length) {
      this.grow(nextGrowableCapacity(this._buf.length))
    }
    this._buf[this._len++] = v
    return v
  }

  truncate(length: number): void {
    this._len = length
    if (length > 0 && length < this._buf.length) {
      this._buf = this._buf.slice(0, length)
    }
  }

  release(): void {
    this._buf = new Uint8Array(1)
    this._len = 0
  }
}

export type IncrementalPostingsHints = {
  /** Initial capacity for global posting buffers. */
  estimatedTotalPostings?: number
}

/**
 * Single-pass postings accumulator for {@link FrozenIndexBuilder}.
 * One global TypedArray stream per docIds/freqs/slotIds; finalize compacts by stable counting sort.
 */
export class IncrementalPostingsAccumulator {
  private readonly _fieldCount: number
  private readonly _docIds: GrowableDocIdColumn
  private readonly _freqs: GrowableFreqColumn
  private readonly _slotIds: GrowableUint32Column
  private _totalPostings = 0
  private _maxFreq = 0

  constructor(fieldCount: number, hints?: IncrementalPostingsHints) {
    this._fieldCount = fieldCount
    const cap = Math.max(DEFAULT_CAPACITY, hints?.estimatedTotalPostings ?? 0)
    this._docIds = new GrowableDocIdColumn(cap)
    this._freqs = new GrowableFreqColumn(cap)
    this._slotIds = new GrowableUint32Column(cap)
  }

  get totalPostings(): number {
    return this._totalPostings
  }

  get maxFreq(): number {
    return this._maxFreq
  }

  append(termIndex: number, fieldId: number, docId: number, freq: number): void {
    const slot = termIndex * this._fieldCount + fieldId
    this._docIds.push(docId)
    const v = this._freqs.push(freq)
    this._slotIds.push(slot)
    if (v > this._maxFreq) this._maxFreq = v
    this._totalPostings++
  }

  clear(): void {
    this._docIds.truncate(0)
    this._freqs.truncate(0)
    this._slotIds.truncate(0)
  }

  release(): void {
    this._docIds.release()
    this._freqs.release()
    this._slotIds.release()
    this._totalPostings = 0
    this._maxFreq = 0
  }

  private scatterPostings(
    allDocIds: DocIdArray,
    allFreqs: FreqArray,
    cursors: Uint32Array,
    docIdWidth: 16 | 32,
  ): void {
    const n = this._slotIds.length
    for (let i = 0; i < n; i++) {
      const slot = this._slotIds.get(i)
      const dest = cursors[slot]!
      cursors[slot] = dest + 1
      const docId = this._docIds.get(i)
      const freq = this._freqs.get(i)
      if (docIdWidth === 16) {
        (allDocIds as Uint16Array)[dest] = docId
      } else {
        (allDocIds as Uint32Array)[dest] = docId
      }
      allFreqs[dest] = freq
    }
  }

  finalize(termCount: number, nextId: number): FrozenPostingsLayout {
    const fieldCount = this._fieldCount
    const totalPostings = this._totalPostings
    const maxFreq = this._maxFreq
    const slotCount = termCount * fieldCount

    if (slotCount > 0xffffffff) {
      throw new Error(`postings slot count ${slotCount} exceeds u32 range`)
    }

    const counts = new Uint32Array(slotCount)
    let nonEmptySlots = 0
    const slotIdsLen = this._slotIds.length
    for (let i = 0; i < slotIdsLen; i++) {
      const slot = this._slotIds.get(i)
      if (counts[slot] === 0) nonEmptySlots++
      counts[slot]++
    }

    const layout = choosePostingsLayout(fieldCount, termCount, nonEmptySlots)
    const docIdWidth: 16 | 32 = nextId <= 65535 ? 16 : 32
    const allDocIds: DocIdArray = docIdWidth === 16
      ? new Uint16Array(totalPostings)
      : new Uint32Array(totalPostings)
    const allFreqs = allocateFreqs(totalPostings, maxFreq)
    const slotOffsets = new Uint32Array(slotCount)
    let write = 0
    for (let slot = 0; slot < slotCount; slot++) {
      slotOffsets[slot] = write
      write += counts[slot]
    }
    const cursors = new Uint32Array(slotOffsets)

    if (layout === 'dense') {
      const denseOffsets = packedColumnFromUint32(slotOffsets, totalPostings)
      const denseLengths = packedColumnFromUint32(counts, nextId)

      this.scatterPostings(allDocIds, allFreqs, cursors, docIdWidth)
      this.release()

      return {
        fieldCount,
        termCount,
        nextId,
        layout: 'dense',
        docIdWidth,
        allDocIds,
        allFreqs,
        denseOffsets,
        denseLengths,
      }
    }

    const sparseFieldIdWidth = chooseSparseFieldIdWidth(fieldCount)
    const sparseFieldIdsScratch: number[] = []
    const sparseOffsetsScratch: number[] = []
    const sparseLengthsScratch: number[] = []
    const termStarts = new Uint32Array(termCount + 1)

    for (let ti = 0; ti < termCount; ti++) {
      termStarts[ti] = sparseFieldIdsScratch.length
      const base = ti * fieldCount
      for (let f = 0; f < fieldCount; f++) {
        const slot = base + f
        const len = counts[slot]
        if (len === 0) continue
        sparseFieldIdsScratch.push(f)
        sparseOffsetsScratch.push(slotOffsets[slot])
        sparseLengthsScratch.push(len)
      }
      termStarts[ti + 1] = sparseFieldIdsScratch.length
    }

    this.scatterPostings(allDocIds, allFreqs, cursors, docIdWidth)
    this.release()

    const sparseFieldIds: FieldIdArray = sparseFieldIdWidth === 16
      ? new Uint16Array(sparseFieldIdsScratch)
      : new Uint8Array(sparseFieldIdsScratch)

    return {
      fieldCount,
      termCount,
      nextId,
      layout: 'sparse',
      docIdWidth,
      sparseFieldIdWidth,
      allDocIds,
      allFreqs,
      sparseTermStarts: packedColumnFromUint32(termStarts, nonEmptySlots),
      sparseFieldIds,
      sparseOffsets: packedColumnFromNumbers(sparseOffsetsScratch, totalPostings),
      sparseLengths: packedColumnFromNumbers(sparseLengthsScratch, nextId),
    }
  }
}
