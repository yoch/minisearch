/**
 * Freeze-import profiler entry point for benchmarks and internal tests.
 *
 * Benchmark scripts must import snapshot accumulation helpers from here, not
 * from product modules directly.
 */
export {
  accumulateSnapshotIndex,
  parseSnapshotIndex,
  type SnapshotIndexAccumulation,
} from '../../src/freezeSnapshotIndex'
export {
  readIncrementalGrowStats,
  resetIncrementalGrowStats,
} from '../../src/internal/incrementalGrowProfiler'
