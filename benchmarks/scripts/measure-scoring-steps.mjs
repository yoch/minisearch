/**
 * Step-by-step scoring optimization measurements (L1-style timings + perf-friendly output).
 *
 * Each case includes gateProbe metadata: whether AND gating is selective on branch 1
 * (gate <= maxGate). Optimizations on allowedDocs (seek) only apply when selective=true.
 *
 *   pnpm build
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/measure-scoring-steps.mjs [--step=baseline] [--runs=5]
 */
import { performance } from 'node:perf_hooks'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  docIdUint16Boundary,
  giantVocabulary,
  highFrequencyTerms,
} from '../benchmarkScenarios.js'
import {
  DEFAULT_AND_GATE_LIMITS,
  DEFAULT_POSTING_GATE_POLICY,
  gateIsSelectiveEnough,
  passGateByPostingRatio,
  resolveGateMaxSize,
} from '../../src/queryEngineGateLimits.ts'
import {
  frozenFromMiniSearch,
  frozenPostings,
  frozenTermIndex,
} from '../harness/frozenSourceInternals.ts'
import { executeRaw } from '../harness/frozenSourceInternals.ts'

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

function p95(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

function buildFrozen(corpus, options) {
  return FrozenMiniSearch.fromDocuments(corpus, options)
}

function corpusSharedBucket(docCount, bucketMod, bucketId) {
  const docs = []
  for (let i = 0; i < docCount; i++) {
    const bucket = i % bucketMod
    docs.push({
      id: i,
      txt: bucket === bucketId
        ? `shared bucket${bucketId} token${i}`
        : `shared noise${i} token${i}`,
    })
  }
  return docs
}

function corpusMediumRareCommon(docCount) {
  const docs = []
  for (let i = 0; i < docCount; i++) {
    docs.push({
      id: i,
      txt: i === 0 ? 'rare0 common token' : `common noise${i} token${i}`,
    })
  }
  return docs
}

function corpusForSpec(spec) {
  if (spec.id === 'selectiveAndBucket') return corpusSharedBucket(10000, 100, 7)
  if (spec.id === 'mediumAndExact') return corpusMediumRareCommon(3000)
  if (spec.id.startsWith('giant')) return giantVocabulary(50000)
  if (spec.id === 'highFrequencyAnd') return highFrequencyTerms(10000)
  return null
}

function postingLengthForTermIndex(frozen, termIndex) {
  if (termIndex == null) return 0
  const layout = frozenPostings(frozen)
  if (layout.layout === 'dense') {
    return layout.denseLengths[termIndex * layout.fieldCount]
  }
  const start = layout.sparseTermStarts[termIndex]
  const end = layout.sparseTermStarts[termIndex + 1]
  for (let i = start; i < end; i++) {
    if (layout.sparseFieldIds[i] === 0) return layout.sparseLengths[i]
  }
  return 0
}

function maxPostingLengthForToken(frozen, token, prefix) {
  const index = frozenTermIndex(frozen)
  if (!prefix) {
    return postingLengthForTermIndex(frozen, index.get(token))
  }

  let maxLen = 0
  for (const { termIndex } of index.prefixRefs(token)) {
    maxLen = Math.max(maxLen, postingLengthForTermIndex(frozen, termIndex))
  }
  return maxLen
}

/** Probe branch-0 gate for string AND queries (first token only). */
function probeAndGate(corpus, query, searchOptions) {
  const baseOpts = { fields: ['txt'], storeFields: [] }
  const ms = new MiniSearch({ ...baseOpts, searchOptions: searchOptions.prefix ? { prefix: true } : {} })
  ms.addAll(corpus)
  const [firstToken, secondToken] = query.trim().split(/\s+/)
  const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, baseOpts)
  const gateSize = executeRaw(frozen, firstToken, searchOptions).size
  const maxGate = resolveGateMaxSize(corpus.length, DEFAULT_AND_GATE_LIMITS)
  const branchPostingLength = secondToken == null
    ? 0
    : maxPostingLengthForToken(frozen, secondToken, searchOptions.prefix === true)
  const absoluteGatePass = gateSize <= maxGate
  const postingRatioGatePass = passGateByPostingRatio(
    gateSize,
    branchPostingLength,
    DEFAULT_POSTING_GATE_POLICY,
  )
  const selective = gateIsSelectiveEnough(
    gateSize,
    corpus.length,
    DEFAULT_AND_GATE_LIMITS,
    branchPostingLength,
    DEFAULT_POSTING_GATE_POLICY,
  )
  return {
    firstToken,
    nextToken: secondToken,
    gateSize,
    maxGate,
    branchPostingLength,
    absoluteGatePass,
    postingRatioGatePass,
    branchGetsAllowedDocs: selective,
    selective,
  }
}

function runExecuteQuery(frozen, query, searchOptions, warmup, iterations) {
  const fn = () => executeRaw(frozen, query, searchOptions)
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    sink += fn().size
  }
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    sink += fn().size
    samples.push(performance.now() - t0)
  }
  return { sink, p50: median(samples), p95: p95(samples), samples }
}

function runSearch(frozen, query, searchOptions, warmup, iterations) {
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    sink += frozen.search(query, searchOptions).length
  }
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    sink += frozen.search(query, searchOptions).length
    samples.push(performance.now() - t0)
  }
  return { sink, p50: median(samples), p95: p95(samples), samples }
}

const CASES = [
  {
    id: 'highFrequencyAnd',
    label: 'extreme-highFrequency AND',
    build: () => buildFrozen(highFrequencyTerms(10000), { fields: ['txt'], storeFields: [] }),
    query: 'alpha beta',
    searchOptions: { combineWith: 'AND' },
    expectSeekBenefit: false,
    note: 'gate~10k; even if selective, seek ratio rule rejects (gate=list length)',
  },
  {
    id: 'giantAndExact',
    label: 'giant AND exact (selective gate=1)',
    build: () => buildFrozen(giantVocabulary(50000), { fields: ['txt'], storeFields: [] }),
    query: 'unique1 common',
    searchOptions: { combineWith: 'AND' },
    expectSeekBenefit: true,
    note: 'branch2 common 50k posting with allowedDocs size 1; primary seek target',
  },
  {
    id: 'selectiveAndBucket',
    label: 'shared bucket7 AND (gate~100)',
    build: () => buildFrozen(corpusSharedBucket(10000, 100, 7), { fields: ['txt'], storeFields: [] }),
    query: 'bucket7 shared',
    searchOptions: { combineWith: 'AND' },
    expectSeekBenefit: true,
    note: 'narrow term first; and-gate-tuning synthetic',
  },
  {
    id: 'mediumAndExact',
    label: 'medium 3k AND exact (gate=1, list~3k)',
    build: () => buildFrozen(corpusMediumRareCommon(3000), { fields: ['txt'], storeFields: [] }),
    query: 'rare0 common',
    searchOptions: { combineWith: 'AND' },
    expectSeekBenefit: true,
    note: 'activates seek at minLen=2048, not at 4096; real medium corpus',
  },
  {
    id: 'giantPrefix',
    label: 'giant AND+prefix (ratio-selective gate)',
    build: () => buildFrozen(giantVocabulary(50000), { fields: ['txt'], storeFields: [] }),
    query: 'unique1 common',
    searchOptions: { combineWith: 'AND', prefix: true },
    expectSeekBenefit: true,
    note: 'prefix on unique1 gives gate~11k > maxGate 5000, but ratio gate passes against common~50k',
  },
  {
    id: 'giantPrefixOnly',
    label: 'giant prefix only (no AND gate)',
    build: () => buildFrozen(giantVocabulary(50000), { fields: ['txt'], storeFields: [] }),
    query: 'unique1',
    searchOptions: { prefix: true },
    expectSeekBenefit: false,
    note: 'prefix term loop; not an allowedDocs optimization path',
  },
  {
    id: 'docIdExact',
    label: 'docIdUint16Boundary exact guard',
    build: () => buildFrozen(docIdUint16Boundary(65535), { fields: ['txt'], storeFields: [] }),
    query: 'alpha',
    searchOptions: {},
    expectSeekBenefit: false,
    note: 'guard rail for finalize / single-term',
  },
]

const step = argValue('step') ?? 'baseline'
const runs = intArg('runs', 5)
const warmup = intArg('warmup', 3)
const iterations = intArg('iterations', 15)

const report = {
  capturedAt: new Date().toISOString(),
  step,
  node: process.version,
  runs,
  warmup,
  iterations,
  cases: [],
}

for (const spec of CASES) {
  const frozen = spec.build()
  const corpus = corpusForSpec(spec)
  const gateProbe = corpus != null && spec.searchOptions.combineWith === 'AND'
    ? probeAndGate(corpus, spec.query, spec.searchOptions)
    : null
  const caseRow = {
    id: spec.id,
    label: spec.label,
    expectSeekBenefit: spec.expectSeekBenefit,
    note: spec.note,
    gateProbe,
    executeQuery: [],
    search: [],
  }
  for (let r = 0; r < runs; r++) {
    caseRow.executeQuery.push(runExecuteQuery(frozen, spec.query, spec.searchOptions, warmup, iterations))
    caseRow.search.push(runSearch(frozen, spec.query, spec.searchOptions, warmup, iterations))
  }
  caseRow.summary = {
    executeQueryP50: median(caseRow.executeQuery.map((x) => x.p50)),
    executeQueryP95: median(caseRow.executeQuery.map((x) => x.p95)),
    searchP50: median(caseRow.search.map((x) => x.p50)),
    searchP95: median(caseRow.search.map((x) => x.p95)),
  }
  report.cases.push(caseRow)
}

console.log(JSON.stringify(report, null, 2))
