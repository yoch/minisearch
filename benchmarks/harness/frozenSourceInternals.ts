/**
 * Source-build benchmark helpers.
 *
 * Benchmark scripts may inspect/decompose FrozenMiniSearch internals, but this
 * file is the only tracked benchmark entry point allowed to import
 * src/internal/frozenInternals.
 */
export {
  executeRaw,
  executeRawWithRunOptions,
  finalizeRaw,
  frozenAssembleWithCtor,
  frozenFromMiniSearch,
  frozenFromMiniSearchSnapshot,
  frozenPostings,
  frozenTermIndex,
  mergedAutoSuggestOptions,
  searchWithRunOptions,
} from '../../src/internal/frozenInternals'
export { frozenMemoryBreakdown } from '../../testSupport/frozenMemoryBreakdown.js'
