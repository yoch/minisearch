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
  frozenPostings,
  frozenTermIndex,
  mergedAutoSuggestOptions,
  searchWithRunOptions,
} from '../../src/internal/frozenInternals'
export {
  frozenAssembleWithCtor,
  frozenFromMiniSearch,
  frozenFromMiniSearchSnapshot,
} from '../../testSupport/frozenImportHelpers.ts'
export { frozenMemoryBreakdown } from '../../testSupport/frozenMemoryBreakdown.js'
