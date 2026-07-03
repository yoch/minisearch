import {
  benchPairedSearchSamples,
  benchTimedSamples,
  frozenVsMutablePct,
} from './searchBenchTiming.js'
import { executeRaw, frozenTermIndex } from './harness/frozenSourceInternals.ts'

/**
 * Decompose search cost: L0 term lookup, L1 executeQuery (frozen), L2 full search (paired).
 * Bench-only: uses internal harness helpers (not part of the public API).
 * @param {import('minisearch').default} mutableIndex
 * @param {import('../dist/es/index.js').default} frozenIndex
 * @param {string} term — processed lookup term (first query token)
 */
export function benchSearchLevels (
  mutableIndex,
  frozenIndex,
  query,
  searchOptions,
  term,
  iterations,
  batchSize,
) {
  const L0 = benchPairedSearchSamples(
    () => { mutableIndex._index.get(term) },
    () => { frozenTermIndex(frozenIndex).get(term) },
    iterations,
    batchSize,
  )

  const L1 = benchTimedSamples(
    () => executeRaw(frozenIndex, query, searchOptions),
    iterations,
    batchSize,
  )

  const L2 = benchPairedSearchSamples(
    () => mutableIndex.search(query, searchOptions),
    () => frozenIndex.search(query, searchOptions),
    iterations,
    batchSize,
  )

  return {
    term,
    L0: roundLevel(L0),
    L1: {
      frozenP50: round4(L1.p50),
      frozenP95: round4(L1.p95),
      batchSize: L1.batchSize,
    },
    L2: roundLevel(L2),
  }
}

function round4 (n) {
  return Number(n.toFixed(4))
}

function roundLevel (row) {
  return {
    mutableP50: round4(row.mutableP50),
    mutableP95: round4(row.mutableP95),
    frozenP50: round4(row.frozenP50),
    frozenP95: round4(row.frozenP95),
    pairedRatioP50: row.pairedRatioP50 == null ? null : Number(row.pairedRatioP50.toFixed(4)),
    frozenP50VsMutablePct: frozenVsMutablePct(row.mutableP50, row.frozenP50),
    batchSize: row.batchSize,
  }
}

/** First indexable term for L0 lookup (matches default tokenize/processTerm on a plain string). */
export function primaryLookupTerm (mutableIndex, query, searchOptions = {}) {
  const global = mutableIndex._options?.searchOptions ?? {}
  const opts = { ...mutableIndex._options, ...global, ...searchOptions }
  const tokens = opts.tokenize(query)
    .flatMap((t) => opts.processTerm(t))
    .filter(Boolean)
  return tokens[0] ?? query
}
