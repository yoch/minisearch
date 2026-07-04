export function snapshotError(detail: string): Error {
  return new Error(`FrozenMiniSearch: invalid MiniSearch snapshot: ${detail}`)
}

export function assertRecord(value: unknown, context: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw snapshotError(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

export function assertNonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw snapshotError(`${context} must be a non-negative integer`)
  }
  return value as number
}

// Validate canonical non-negative integer object keys without regex allocation.
export function parseCanonicalIntegerKey(key: string, context: string): number {
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

export function assertShortIdInRange(shortId: number, nextId: number, context: string): void {
  if (shortId >= nextId) {
    throw snapshotError(`${context} shortId ${shortId} must be < nextId ${nextId}`)
  }
}

export function assertFieldIdInRange(fieldId: number, fieldCount: number, context: string): void {
  if (fieldId >= fieldCount) {
    throw snapshotError(`${context} fieldId ${fieldId} must be < field count ${fieldCount}`)
  }
}
