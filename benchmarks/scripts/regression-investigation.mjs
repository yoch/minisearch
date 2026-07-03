/**
 * Investigate benchmark diff regressions (8.2 packed radix vs 8.1 reference).
 *
 *   node --expose-gc benchmarks/scripts/regression-investigation.mjs [caseId]
 *
 * Defaults match routine benchmarks (3×50). Pass --runs / --iterations to override.
 *
 * caseId: highFrequency | overflowHeap | genericStringIds | largeDocumentsAnd | docIdBoundary
 */
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  frozenFromMiniSearch,
  frozenMemoryBreakdown,
} from '../harness/frozenSourceInternals.ts'
import {
  highFrequencyTerms,
  overflowFrequencies,
  genericStringIds,
  largeDocuments,
  docIdUint16Boundary,
} from '../benchmarkScenarios.js'
import {
  benchSearch,
  measureHeap,
  gc,
  medianOf,
  defaultBenchmarkRuns,
  defaultSearchIterations,
} from '../benchmarkUtils.js'

const DEFAULT_MICRO_ITERATIONS = 500

function parseIntArg (name, fallback) {
  for (const arg of process.argv) {
    if (arg === `--${name}`) {
      const next = Number(process.argv[process.argv.indexOf(arg) + 1])
      if (Number.isFinite(next) && next > 0) return Math.floor(next)
    }
    if (arg.startsWith(`--${name}=`)) {
      const next = Number(arg.split('=')[1])
      if (Number.isFinite(next) && next > 0) return Math.floor(next)
    }
  }
  return fallback
}

const benchRuns = parseIntArg('runs', defaultBenchmarkRuns())
const benchIterations = parseIntArg('iterations', defaultSearchIterations())
const microIterations = parseIntArg('micro', DEFAULT_MICRO_ITERATIONS)

const CASES = {
  highFrequency: {
    label: 'extreme-highFrequency — AND alpha beta',
    corpus: highFrequencyTerms(10000),
    options: { fields: ['txt'], storeFields: [] },
    queries: [
      { label: 'exact-alpha', q: 'alpha', opts: {} },
      { label: 'AND', q: 'alpha beta', opts: { combineWith: 'AND' } },
    ],
  },
  overflowHeap: {
    label: 'extreme-overflowFrequency — heap floor',
    corpus: overflowFrequencies(2000, 800),
    options: { fields: ['txt'], storeFields: [] },
    queries: [{ label: 'exact', q: 'alpha', opts: {} }],
  },
  genericStringIds: {
    label: 'genericStringIds-100k — exact token42',
    corpus: genericStringIds(100000),
    options: { fields: ['txt'], storeFields: [] },
    queries: [{ label: 'exact', q: 'token42', opts: {} }],
  },
  largeDocumentsAnd: {
    label: 'extreme-largeDocuments — AND lorem ipsum',
    corpus: largeDocuments(5000, 5000),
    options: { fields: ['txt'], storeFields: ['txt'] },
    queries: [
      { label: 'exact', q: 'lorem', opts: {} },
      { label: 'AND', q: 'lorem ipsum', opts: { combineWith: 'AND' } },
    ],
  },
  docIdBoundary: {
    label: 'docIdUint16Boundary-65535 — exact alpha',
    corpus: docIdUint16Boundary(65535),
    options: { fields: ['txt'], storeFields: [] },
    queries: [{ label: 'exact', q: 'alpha', opts: {} }],
  },
}

function buildPair (corpus, options) {
  const ms = new MiniSearch(options)
  ms.addAll(corpus)
  const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, options)
  return { ms, frozen }
}

function resultSummary (results) {
  return {
    count: results.length,
    topId: results[0]?.id,
    topScore: results[0]?.score,
  }
}

function scoreDrift (ms, frozen, query, topK = 20) {
  const a = ms.search(query).slice(0, topK)
  const b = frozen.search(query).slice(0, topK)
  const bMap = new Map(b.map((r) => [r.id, r.score]))
  let maxAbs = 0
  let maxRel = 0
  let missing = 0
  for (const row of a) {
    const score = bMap.get(row.id)
    if (score == null) {
      missing++
      continue
    }
    const abs = Math.abs(score - row.score)
    const rel = row.score ? abs / row.score : 0
    if (abs > maxAbs) maxAbs = abs
    if (rel > maxRel) maxRel = rel
  }
  return {
    maxAbs: Number(maxAbs.toFixed(8)),
    maxRelPct: Number((maxRel * 100).toFixed(3)),
    missing,
    orderChanged: a.map((r) => r.id).join('|') !== b.map((r) => r.id).join('|'),
  }
}

function parityCheck (ms, frozen, q, opts) {
  const a = ms.search(q, opts)
  const b = frozen.search(q, opts)
  const sameCount = a.length === b.length
  const sameTop = sameCount && a.length > 0 && a[0].id === b[0].id && Math.abs(a[0].score - b[0].score) < 1e-9
  return { mutable: resultSummary(a), frozen: resultSummary(b), sameCount, sameTop }
}

function benchMany (index, q, opts, runs = benchRuns, iterations = benchIterations) {
  const samples = []
  for (let r = 0; r < runs; r++) {
    gc()
    samples.push(benchSearch(index, q, opts, iterations, { batchSize: 1 }).p50)
  }
  return { p50: medianOf(samples), samples }
}

function runCase (id) {
  const spec = CASES[id]
  if (!spec) {
    console.error(`Unknown case: ${id}. Choose: ${Object.keys(CASES).join(', ')}`)
    process.exit(1)
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log(spec.label)
  console.log(`docs=${spec.corpus.length}`)
  console.log('='.repeat(72))

  const { ms, frozen } = buildPair(spec.corpus, spec.options)
  console.log(`terms: mutable=${ms.termCount} frozen=${frozen.termCount}`)

  gc()
  const heapFrozen = measureHeap(() => {
    const m = new MiniSearch(spec.options)
    m.addAll(spec.corpus)
    return frozenFromMiniSearch(FrozenMiniSearch, m, spec.options)
  })
  const heapMutable = measureHeap(() => {
    const m = new MiniSearch(spec.options)
    m.addAll(spec.corpus)
    return m
  })
  console.log(`heap delta: mutable=${heapMutable.heapMb} MB frozen=${heapFrozen.heapMb} MB external=${heapFrozen.externalMb} MB`)

  const breakdown = frozenMemoryBreakdown(frozen)
  const termIndex = breakdown.termIndex
  console.log(`term index: nodes=${termIndex.nodeCount} edges=${termIndex.edgeCount} est=${(termIndex.estimatedBytes / 1024).toFixed(1)} KB structured=${(breakdown.estimatedStructuredBytes / 1024).toFixed(1)} KB`)

  if (id === 'overflowHeap') {
    const drift = scoreDrift(ms, frozen, 'alpha')
    console.log(`\nscoreDrift mutable→frozen (top 20, expected with tf>255):`, drift)
    const rt = frozen.saveBinarySync()
    const loaded = FrozenMiniSearch.loadBinarySync(rt, spec.options)
    const driftRt = scoreDrift(frozen, loaded, 'alpha')
    console.log('scoreDrift frozen→loadBinary:', driftRt)
  }

  for (const { label, q, opts } of spec.queries) {
    console.log(`\n--- query: ${label} "${q}" ${JSON.stringify(opts)} ---`)
    const parity = parityCheck(ms, frozen, q, opts)
    console.log('parity:', parity)

    const mutableBench = benchMany(ms, q, opts)
    const frozenBench = benchMany(frozen, q, opts)
    console.log(`search p50 (${benchRuns}×${benchIterations} iter): mutable=${mutableBench.p50.toFixed(4)} ms frozen=${frozenBench.p50.toFixed(4)} ms ratio=${(frozenBench.p50 / mutableBench.p50).toFixed(2)}×`)
  }

  if (id === 'genericStringIds' || id === 'highFrequency') {
    const term = id === 'genericStringIds' ? 'token42' : 'alpha'
    const warm = () => { ms.search(term); frozen.search(term) }
    warm()
    const n = microIterations
    const tMut = performance.now()
    for (let i = 0; i < n; i++) ms.search(term)
    const mutMs = performance.now() - tMut
    const tFr = performance.now()
    for (let i = 0; i < n; i++) frozen.search(term)
    const frMs = performance.now() - tFr
    console.log(`\nfull exact search ×${n}: mutable=${mutMs.toFixed(1)} ms frozen=${frMs.toFixed(1)} ms`)
  }
}

const caseArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const only = caseArgs[0]
if (only) {
  runCase(only)
} else {
  console.log(`bench: ${benchRuns} runs × ${benchIterations} search iterations (override with --runs / --iterations)`)
  for (const id of Object.keys(CASES)) runCase(id)
}
