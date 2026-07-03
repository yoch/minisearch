/**
 * Calibrate fixed search batch sizes (mutable + frozen probe, max of both).
 * Writes benchmarks/searchBenchBatches.json — commit after corpus/query changes.
 *
 *   pnpm benchmark:calibrate-batches
 */
import { writeFileSync } from 'node:fs'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import { frozenFromMiniSearch } from '../harness/frozenSourceInternals.ts'
import { buildScenarioList } from '../benchmarkSuite.js'
import { median } from '../benchmarkUtils.js'
import { benchHrtimeNow, benchHrtimeElapsedMs } from '../searchBenchTiming.js'
import { BATCHES_PATH, searchBenchBatchKey } from '../loadSearchBenchBatches.js'
import {
  computeSearchBenchBatchFromProbe,
  SEARCH_BENCH_BATCH_TARGET_MS,
  SEARCH_BENCH_MAX_BATCH,
  SEARCH_BENCH_CALIBRATE_PROBE_ITERS,
} from '../searchBenchProtocol.js'

const TARGET_MS = SEARCH_BENCH_BATCH_TARGET_MS

function probeP50 (runSearch, probeIters = SEARCH_BENCH_CALIBRATE_PROBE_ITERS) {
  const samples = []
  for (let i = 0; i < probeIters; i++) {
    const t0 = benchHrtimeNow()
    runSearch()
    samples.push(benchHrtimeElapsedMs(t0))
  }
  return median(samples)
}

function calibrateQuery (mutableIndex, frozenIndex, q, opts) {
  const runMutable = () => mutableIndex.search(q, opts)
  const runFrozen = () => frozenIndex.search(q, opts)
  for (let i = 0; i < 50; i++) {
    runMutable()
    runFrozen()
  }
  const mutableP50 = probeP50(runMutable)
  const frozenP50 = probeP50(runFrozen)
  const batchMutable = computeSearchBenchBatchFromProbe(mutableP50)
  const batchFrozen = computeSearchBenchBatchFromProbe(frozenP50)
  const batchSize = Math.max(batchMutable, batchFrozen)
  return {
    batchSize,
    calibratedProbeP50Ms: {
      mutable: Number(mutableP50.toFixed(6)),
      frozen: Number(frozenP50.toFixed(6)),
    },
    batchFromProbe: { mutable: batchMutable, frozen: batchFrozen },
  }
}

const scenarios = buildScenarioList()
const entries = {}

console.log(`Calibrating fixed search batches (target ${TARGET_MS} ms wall per sample, max ${SEARCH_BENCH_MAX_BATCH})…\n`)

for (const scenario of scenarios) {
  const mutableIndex = new MiniSearch(scenario.options)
  mutableIndex.addAll(scenario.corpus)
  const frozenBuild = new MiniSearch(scenario.options)
  frozenBuild.addAll(scenario.corpus)
  const frozenIndex = frozenFromMiniSearch(FrozenMiniSearch, frozenBuild, scenario.options)

  console.log(scenario.id)
  for (const { label, q, opts } of scenario.queries) {
    const key = searchBenchBatchKey(scenario.id, label)
    const row = calibrateQuery(mutableIndex, frozenIndex, q, opts)
    entries[key] = {
      batchSize: row.batchSize,
      calibratedProbeP50Ms: row.calibratedProbeP50Ms,
    }
    console.log(
      `  ${label.padEnd(16)} batch=${String(row.batchSize).padStart(2)}  `
      + `probe mut=${row.calibratedProbeP50Ms.mutable}ms frz=${row.calibratedProbeP50Ms.frozen}ms `
      + `(from ${row.batchFromProbe.mutable}/${row.batchFromProbe.frozen})`,
    )
  }
  console.log('')
}

const payload = {
  protocolVersion: 2,
  batchTargetMs: SEARCH_BENCH_BATCH_TARGET_MS,
  maxBatch: SEARCH_BENCH_MAX_BATCH,
  calibrateProbeIterations: SEARCH_BENCH_CALIBRATE_PROBE_ITERS,
  batchMode: 'fixed-per-query',
  entries,
}

writeFileSync(BATCHES_PATH, JSON.stringify(payload, null, 2) + '\n')
console.log(`Wrote ${BATCHES_PATH} (${Object.keys(entries).length} queries)`)
