/**
 * Source-build benchmark helpers.
 *
 * Benchmark scripts may inspect/decompose FrozenMiniSearch internals, but this
 * file is the only benchmark entry point allowed to import src/internal.
 */
export {
  executeRaw,
  executeRawWithRunOptions,
  finalizeRaw,
  frozenAssembleWithCtor,
  frozenFromMiniSearch,
  frozenFromMiniSearchSnapshot,
  frozenMemoryBreakdown,
  frozenPostings,
  frozenTermIndex,
  mergedAutoSuggestOptions,
  searchWithRunOptions,
} from '../../src/internal/frozenInternals'
export { parseSnapshotIndex } from '../../src/fromMiniSearch'
