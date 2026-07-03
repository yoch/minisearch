const DEFAULT_GROWTH_FACTOR = 2

export function nextGrowableCapacity(currentLength, growthFactor = DEFAULT_GROWTH_FACTOR) {
  if (!Number.isFinite(growthFactor) || growthFactor <= 1) {
    throw new Error(`growable capacity growthFactor must be > 1, got ${growthFactor}`)
  }
  return Math.max(1, Math.ceil(currentLength * growthFactor))
}

/**
 * Simulate repeated push growth for one column (policy tests: ×2 vs ×1.5, capacity sweep).
 * `elementBytes` is the width of one slot (4 for u32 slotIds, 2 for u16 docIds, etc.).
 */
export function simulateColumnGrowth(
  itemCount,
  elementBytes,
  initialCapacity = 16,
  growthFactor = DEFAULT_GROWTH_FACTOR,
) {
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
