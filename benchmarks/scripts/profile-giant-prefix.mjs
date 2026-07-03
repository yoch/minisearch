/**
 * Detailed L1/L2 profile for extreme-giantVocabulary AND+prefix ("unique1 common").
 * Local dev only — not committed to CI.
 *
 *   pnpm build
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-giant-prefix.mjs [--runs=5] [--warmup=4] [--iterations=12]
 */
import { performance } from 'node:perf_hooks'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  DEFAULT_AND_GATE_LIMITS,
  DEFAULT_POSTING_GATE_POLICY,
  passGateByPostingRatio,
  gateIsSelectiveEnough,
  resolveGateMaxSize,
} from '../../src/queryEngineGateLimits.ts'
import { giantVocabulary } from '../benchmarkScenarios.js'
import {
  executeRaw,
  finalizeRaw,
  frozenPostings,
  frozenTermIndex,
} from '../harness/frozenSourceInternals.ts'

function argValue(name) {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === `--${name}`) return process.argv[i + 1]
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

function intArg(name, fallback) {
  const raw = argValue(name)
  const value = raw == null ? NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function timeFn(fn, warmup, iterations) {
  for (let i = 0; i < warmup; i++) fn()
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return { p50: median(samples), samples }
}

function timePrepared(preparer, fn, warmup, iterations) {
  const prepared = []
  for (let i = 0; i < warmup + iterations; i++) {
    prepared.push(preparer())
  }
  for (let i = 0; i < warmup; i++) fn(prepared[i])
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const samples = []
  for (let i = warmup; i < warmup + iterations; i++) {
    const t0 = performance.now()
    fn(prepared[i])
    samples.push(performance.now() - t0)
  }
  return { p50: median(samples), samples }
}

function countPrefixTerms(index, term) {
  let exact = 0
  let prefix = 0
  const postingLengths = new Map()
  for (const { length } of index.prefixRefs(term)) {
    const distance = length - term.length
    if (distance === 0) exact++
    else prefix++
    postingLengths.set(length, (postingLengths.get(length) ?? 0) + 1)
  }
  return { exact, prefix, postingLengths }
}

function postingLengthForTerm(frozen, term) {
  const ti = frozenTermIndex(frozen).get(term)
  if (ti == null) return null
  const layout = frozenPostings(frozen)
  if (layout.layout === 'dense') {
    const base = ti * layout.fieldCount
    return layout.denseLengths[base]
  }
  const start = layout.sparseTermStarts[ti]
  const end = layout.sparseTermStarts[ti + 1]
  for (let i = start; i < end; i++) {
    if (layout.sparseFieldIds[i] === 0) return layout.sparseLengths[i]
  }
  return null
}

function cloneRawResult(raw) {
  const copy = new Map()
  for (const [docId, { score, terms, match }] of raw) {
    const clonedMatch = {}
    for (const [term, fields] of Object.entries(match)) {
      clonedMatch[term] = [...fields]
    }
    copy.set(docId, {
      score,
      terms: [...terms],
      match: clonedMatch,
    })
  }
  return copy
}

function assignUniqueTerms(target, source) {
  for (const term of source) {
    if (!target.includes(term)) target.push(term)
  }
}

function combineAnd(a, b) {
  for (const docId of a.keys()) {
    const inB = b.get(docId)
    if (inB == null) {
      a.delete(docId)
      continue
    }
    const existing = a.get(docId)
    existing.score += inB.score
    assignUniqueTerms(existing.terms, inB.terms)
    Object.assign(existing.match, inB.match)
  }
  return a
}

const runs = intArg('runs', 5)
const warmup = intArg('warmup', 4)
const iterations = intArg('iterations', 12)
const opts = { fields: ['txt'], storeFields: [] }
const andPrefix = { combineWith: 'AND', prefix: true }
const query = 'unique1 common'

const frozen = FrozenMiniSearch.fromDocuments(giantVocabulary(50000), opts)
const docCount = 50000

const index = frozenTermIndex(frozen)
const uniqueStats = countPrefixTerms(index, 'unique1')
const commonStats = countPrefixTerms(index, 'common')
const commonPostingLen = postingLengthForTerm(frozen, 'common')

const gateAfterUnique1 = executeRaw(frozen, 'unique1', andPrefix)
const gateAfterFull = executeRaw(frozen, query, andPrefix)
const maxGate = resolveGateMaxSize(docCount, DEFAULT_AND_GATE_LIMITS)
const absoluteGatePass = gateAfterUnique1.size <= maxGate
const postingRatioGatePass = commonPostingLen != null && passGateByPostingRatio(
  gateAfterUnique1.size,
  commonPostingLen,
  DEFAULT_POSTING_GATE_POLICY,
)
const gateSelective = gateIsSelectiveEnough(
  gateAfterUnique1.size,
  docCount,
  DEFAULT_AND_GATE_LIMITS,
  commonPostingLen ?? undefined,
  DEFAULT_POSTING_GATE_POLICY,
)

const staticProfile = {
  documentCount: docCount,
  unique1: {
    exactTermMatches: uniqueStats.exact,
    prefixTermMatches: uniqueStats.prefix,
    postingLengthExact: postingLengthForTerm(frozen, 'unique1'),
  },
  common: {
    exactTermMatches: commonStats.exact,
    prefixTermMatches: commonStats.prefix,
    postingLengthExact: commonPostingLen,
    prefixPostingLengthBuckets: Object.fromEntries(commonStats.postingLengths),
  },
  gateAfterBranch0: gateAfterUnique1.size,
  gateAfterFullQuery: gateAfterFull.size,
  maxGate,
  branch2PostingLength: commonPostingLen,
  absoluteGatePass,
  postingRatioGatePass,
  gateSelectiveAfterBranch0: gateSelective,
  branch2GetsAllowedDocs: gateSelective,
}

const scenarios = {
  l1_andPrefix_full: () => executeRaw(frozen, query, andPrefix),
  l2_search_full: () => frozen.search(query, andPrefix),
  l1_branch0_unique1_prefix: () => executeRaw(frozen, 'unique1', { prefix: true }),
  l1_branch1_common_exact: () => executeRaw(frozen, 'common', {}),
  l1_branch1_common_prefix: () => executeRaw(frozen, 'common', { prefix: true }),
  l1_andExact_noPrefix: () => executeRaw(frozen, 'unique1 common', { combineWith: 'AND' }),
}

const timings = {}
for (const [name, fn] of Object.entries(scenarios)) {
  const runSamples = []
  for (let r = 0; r < runs; r++) {
    runSamples.push(timeFn(fn, warmup, iterations).p50)
  }
  timings[name] = { p50Ms: median(runSamples), runP50s: runSamples }
}

const materializedBranch0 = executeRaw(frozen, 'unique1', { prefix: true })
const materializedBranch2Full = executeRaw(frozen, 'common', {})
const materializedFullRaw = executeRaw(frozen, query, andPrefix)
const combineAndMaterializedMs = timePrepared(
  () => cloneRawResult(materializedBranch0),
  branch0Clone => combineAnd(branch0Clone, materializedBranch2Full),
  warmup,
  iterations,
).p50

const decomposition = {
  branch0_unique1_prefix_ms: timings.l1_branch0_unique1_prefix.p50Ms,
  full_with_gating_ms: timings.l1_andPrefix_full.p50Ms,
  full_without_gating_estimate_ms: (
    timings.l1_branch0_unique1_prefix.p50Ms
    + timings.l1_branch1_common_exact.p50Ms
    + combineAndMaterializedMs
  ),
  branch2_common_exact_full_ms: timings.l1_branch1_common_exact.p50Ms,
  combine_and_materialized_ms: combineAndMaterializedMs,
  raw_clone_branch0_ms: timeFn(
    () => cloneRawResult(materializedBranch0),
    warmup,
    iterations,
  ).p50,
  finalize_full_raw_ms: timeFn(
    () => finalizeRaw(frozen, materializedFullRaw, query, andPrefix),
    warmup,
    iterations,
  ).p50,
  notes: [
    'full_without_gating_estimate_ms is branch0 prefix + common exact full + materialized AND combine.',
    'combine_and_materialized_ms uses a full common raw map; AND merge cost still iterates branch0.',
    'combine_and_materialized_ms uses branch0 clones prepared before timing because AND merge mutates its first input.',
    'finalize_full_raw_ms finalizes a materialized raw result; it excludes executeQuery.',
  ],
}

const l1 = timings.l1_andPrefix_full.p50Ms
const l2 = timings.l2_search_full.p50Ms
const finalizeGap = l2 - l1

const report = {
  capturedAt: new Date().toISOString(),
  query,
  searchOptions: andPrefix,
  warmup,
  iterations,
  runs,
  staticProfile,
  timings,
  decomposition,
  summary: {
    l1_executeQuery_ms: l1,
    l2_search_ms: l2,
    l2_minus_l1_gap_ms: finalizeGap,
    finalize_gap_pct_of_l2: ((finalizeGap / l2) * 100).toFixed(1),
    scoring_pct_of_l2: ((l1 / l2) * 100).toFixed(1),
    perPrefixTermBranch0_us: (timings.l1_branch0_unique1_prefix.p50Ms * 1000 / Math.max(1, uniqueStats.prefix)).toFixed(2),
    perPostingCommonExact_us: commonPostingLen
      ? (timings.l1_branch1_common_exact.p50Ms * 1000 / commonPostingLen).toFixed(3)
      : null,
    branch1_common_exact_vs_prefix_ms: {
      exact: timings.l1_branch1_common_exact.p50Ms,
      prefix: timings.l1_branch1_common_prefix.p50Ms,
    },
  },
}

console.log(JSON.stringify(report, null, 2))
