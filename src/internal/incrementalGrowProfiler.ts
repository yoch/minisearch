type GrowStats = {
  growEvents: number
  bytesCopied: number
}

let lastGrowStats: GrowStats = { growEvents: 0, bytesCopied: 0 }

export function resetIncrementalGrowStats(): void {
  lastGrowStats = { growEvents: 0, bytesCopied: 0 }
}

export function readIncrementalGrowStats(): GrowStats {
  return { ...lastGrowStats }
}

export function recordIncrementalGrow(bytesCopied: number): void {
  lastGrowStats.growEvents++
  lastGrowStats.bytesCopied += bytesCopied
}
