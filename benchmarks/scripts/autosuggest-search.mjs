/**
 * Isolated autoSuggest timing for FrozenMiniSearch.
 *
 * Measures:
 * - executeQuery(): raw query execution with merged autoSuggest options
 * - suggestFromRaw(): suggestion aggregation from one reusable raw result
 * - autoSuggest(): full public autoSuggest path
 *
 * This is CPU-only instrumentation. It does not sample heap or process memory.
 *
 * Run:
 *   pnpm benchmark:autosuggest RUNS=5 BENCH_WARMUP=20 SEARCH_ITERATIONS=50
 */
import FrozenMiniSearch from '../../src/FrozenMiniSearch.ts'
import {
  executeRaw,
  mergedAutoSuggestOptions,
} from '../harness/frozenSourceInternals.ts'
import { suggestFromRawResults } from '../../src/suggestions.ts'
import { giantVocabulary, highFrequencyTerms } from '../benchmarkScenarios.js'
import { intArg, median, timed } from './cpuBenchUtils.mjs'

function withStoredFields(docs) {
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
      id: 'multi-default',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: 'alpha beta',
      autoSuggestOptions: {},
    },
    {
      id: 'last-term-prefix',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: 'alpha vari',
      autoSuggestOptions: {},
    },
    {
      id: 'many-results-stored',
      docs: withStoredFields(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha beta',
      autoSuggestOptions: {},
    },
    {
      id: 'fuzzy',
      docs: giant,
      options: { fields: ['txt'], storeFields: [] },
      query: 'uniqe100',
      autoSuggestOptions: { fuzzy: 0.2 },
    },
    {
      id: 'filter',
      docs: withStoredFields(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha beta',
      autoSuggestOptions: { filter: result => result.category === 'even' },
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
  const merged = mergedAutoSuggestOptions(index, spec.autoSuggestOptions)
  const runRows = []
  let rawResults = 0

  for (let r = 0; r < runs; r++) {
    const raw = executeRaw(index, spec.query, merged)
    rawResults = raw.size
    runRows.push({
      executeQuery: timed(
        () => executeRaw(index, spec.query, merged),
        warmup,
        iterations,
      ),
      suggestFromRaw: timed(
        () => suggestFromRawResults(raw),
        warmup,
        iterations,
      ),
      autoSuggest: timed(
        () => index.autoSuggest(spec.query, spec.autoSuggestOptions),
        warmup,
        iterations,
      ),
    })
  }

  const summary = {}
  for (const key of ['executeQuery', 'suggestFromRaw', 'autoSuggest']) {
    summary[key] = {
      p50: Number(median(runRows.map(row => row[key].p50)).toFixed(4)),
      p95: Number(median(runRows.map(row => row[key].p95)).toFixed(4)),
    }
  }

  report.cases.push({
    id: spec.id,
    documents: spec.docs.length,
    rawResults,
    usesFilter: spec.autoSuggestOptions.filter != null,
    summary,
  })
}

console.log(JSON.stringify(report, null, 2))
