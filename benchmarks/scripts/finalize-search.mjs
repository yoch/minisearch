/**
 * Isolated finalize/search timing for FrozenMiniSearch.
 *
 * Measures:
 * - executeQuery(): raw query execution
 * - finalize(): public result materialization from one reusable raw result
 * - search(): full public search path
 *
 * This is CPU-only instrumentation. It does not sample heap or process memory.
 *
 * Run:
 *   pnpm benchmark:finalize RUNS=5 BENCH_WARMUP=20 SEARCH_ITERATIONS=50
 */
import FrozenMiniSearch from '../../src/FrozenMiniSearch.ts'
import { executeRaw, finalizeRaw } from '../harness/frozenSourceInternals.ts'
import { giantVocabulary, highFrequencyTerms } from '../benchmarkScenarios.js'
import { intArg, median, timed } from './cpuBenchUtils.mjs'

function withSingleStored(docs) {
  return docs.map((doc, i) => ({
    ...doc,
    category: i % 2 === 0 ? 'even' : undefined,
  }))
}

function withMultiStored(docs) {
  return docs.map((doc, i) => ({
    ...doc,
    title: `Doc ${i}`,
    category: i % 2 === 0 ? 'even' : 'odd',
  }))
}

function caseSpecs() {
  const highFreq = highFrequencyTerms(10000)
  const giant = giantVocabulary(50000)
  return [
    {
      id: 'many-results-no-stored',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: 'alpha',
      searchOptions: {},
    },
    {
      id: 'many-results-single-stored',
      docs: withSingleStored(highFreq),
      options: { fields: ['txt'], storeFields: ['category'] },
      query: 'alpha',
      searchOptions: {},
    },
    {
      id: 'many-results-multi-stored',
      docs: withMultiStored(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha',
      searchOptions: {},
    },
    {
      id: 'many-results-filter',
      docs: withMultiStored(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha',
      searchOptions: { filter: result => result.category === 'even' },
    },
    {
      id: 'wildcard-no-stored',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: FrozenMiniSearch.wildcard,
      searchOptions: {},
    },
    {
      id: 'prefix-large',
      docs: giant,
      options: { fields: ['txt'], storeFields: [] },
      query: 'unique1',
      searchOptions: { prefix: true },
    },
  ]
}

const runs = intArg('runs', 5)
const warmup = intArg('warmup', 20, { min: 0 })
const iterations = intArg('iterations', 50)
const report = {
  capturedAt: new Date().toISOString(),
  runs,
  warmup,
  iterations,
  cases: [],
}

for (const spec of caseSpecs()) {
  const index = FrozenMiniSearch.fromDocuments(spec.docs, spec.options)
  const runRows = []
  let rawResults = 0

  for (let r = 0; r < runs; r++) {
    // Reuse one raw result per run to isolate finalize() without folding
    // executeQuery() cost into the timed section.
    const raw = executeRaw(index, spec.query, spec.searchOptions)
    rawResults = raw.size
    runRows.push({
      executeQuery: timed(
        () => executeRaw(index, spec.query, spec.searchOptions),
        warmup,
        iterations,
      ),
      finalize: timed(
        () => finalizeRaw(index, raw, spec.query, spec.searchOptions),
        warmup,
        iterations,
      ),
      search: timed(
        () => index.search(spec.query, spec.searchOptions),
        warmup,
        iterations,
      ),
    })
  }

  const summary = {}
  for (const key of ['executeQuery', 'finalize', 'search']) {
    summary[key] = {
      p50: Number(median(runRows.map(row => row[key].p50)).toFixed(4)),
      p95: Number(median(runRows.map(row => row[key].p95)).toFixed(4)),
    }
  }
  report.cases.push({
    id: spec.id,
    documents: spec.docs.length,
    rawResults,
    summary,
  })
}

console.log(JSON.stringify(report, null, 2))
