/**
 * Compare benchmark results against benchmarks/baselines/reference.json.
 *
 *   pnpm benchmark:diff              → latest.json vs reference (no re-run)
 *   pnpm benchmark:diff --current=a.json --reference=b.json
 *
 * Exit code 1 if regressions exceed thresholds (for CI).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseBenchmarkArgs,
  loadBenchmarkPayload,
  argValue,
  hasStructuralSurfaces,
  isCpuOnlySurfaces,
  DEFAULT_BENCHMARK_RUNS,
  DEFAULT_SEARCH_ITERATIONS,
} from './benchmarkUtils.js'
import {
  STRUCTURAL_TIMING_THRESHOLDS,
  compareHeapFrozenMb,
  compareHeapFrozenTotalResidentMb,
  compareHeapSavingPct,
  compareSearchMetric,
  compareTimingMetric,
  SEARCH_MS_FLOOR,
  SEARCH_PCT_FAIL,
} from './regressionPolicy.js'
import { HEAP_BENCH_PROTOCOL_VERSION } from './benchStats.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES_DIR = join(__dirname, 'baselines')
const REFERENCE_PATH = join(BASELINES_DIR, 'reference.json')
const LATEST_PATH = join(BASELINES_DIR, 'latest.json')

const argv = process.argv.slice(2)
const strictSearch = argv.includes('--strict')
const forceRun = argv.includes('--run')

const { runs, searchIterations, surfaces } = parseBenchmarkArgs()

/** Lower is better unless noted. */
const THRESHOLDS = {
  heapFrozenMb: { warnPct: 5, failPct: 10 },
  ...STRUCTURAL_TIMING_THRESHOLDS,
  heapFrozenSavingPct: { warnDrop: 5, failDrop: 10, higherIsBetter: true },
}

function loadJson (path) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Run: pnpm benchmark:record`)
    process.exit(1)
  }
  return loadBenchmarkPayload(path)
}

function payloadHasStructuralData(payload) {
  const surfaces = payload.benchSurfaces ?? payload.scenarios?.[0]?.benchSurfaces
  if (Array.isArray(surfaces) && surfaces.length > 0) {
    return hasStructuralSurfaces(surfaces)
  }
  return (payload.scenarios ?? []).some(scenario =>
    scenario.heapMb != null
    || scenario.indexing != null
    || scenario.loadMs != null
    || scenario.diskMb != null
    || scenario.memoryBreakdown != null,
  )
}

function payloadProfile(payload) {
  const surfaces = payload.benchSurfaces ?? payload.scenarios?.[0]?.benchSurfaces
  if (Array.isArray(surfaces) && surfaces.length > 0) {
    if (isCpuOnlySurfaces(surfaces)) return 'search'
    if (surfaces.length === 1 && surfaces[0] === 'memory') return 'memory'
    return 'full'
  }
  return payload.benchProfile ?? payload.scenarios?.[0]?.benchProfile ?? 'full'
}

function classifyRegression (metricKey, deltaPct, deltaPoints) {
  const t = THRESHOLDS[metricKey]
  if (!t) return 'ok'

  if (t.higherIsBetter) {
    if (deltaPoints <= -t.failDrop) return 'fail'
    if (deltaPoints <= -t.warnDrop) return 'warn'
    return 'ok'
  }

  if (deltaPct >= t.failPct) return 'fail'
  if (deltaPct >= t.warnPct) return 'warn'
  return 'ok'
}

function formatDelta (deltaPct, suffix = '%') {
  if (deltaPct == null) return '—'
  const sign = deltaPct > 0 ? '+' : ''
  return `${sign}${deltaPct.toFixed(1)}${suffix}`
}

function compareMetric (label, refVal, curVal, metricKey, higherIsBetter = false) {
  let deltaPct = null
  let deltaPoints = null
  if (refVal != null && curVal != null && refVal !== 0) {
    deltaPct = ((curVal - refVal) / refVal) * 100
  }
  if (higherIsBetter && refVal != null && curVal != null) {
    deltaPoints = curVal - refVal
  }
  const status = higherIsBetter
    ? classifyRegression(metricKey, null, deltaPoints)
    : classifyRegression(metricKey, deltaPct, null)

  const deltaStr = higherIsBetter ? formatDelta(deltaPoints, ' pts') : formatDelta(deltaPct)
  const icon = status === 'fail' ? 'FAIL' : status === 'warn' ? 'warn' : 'ok  '
  console.log(
    `  ${icon} ${label.padEnd(32)} ref=${String(refVal).padEnd(10)} cur=${String(curVal).padEnd(10)} Δ ${deltaStr}`,
  )
  return status
}

function frozenTotalResidentMb (scenario) {
  return scenario.heapMb?.frozenTotalResident ?? scenario.memoryMb?.frozen?.totalResidentApprox
}

function compareScenario (ref, cur, { structural = true } = {}) {
  console.log(`\n${'─'.repeat(72)}`)
  console.log(`${cur.name} (${cur.id})`)
  console.log('─'.repeat(72))

  let worst = 'ok'

  const bump = (s) => {
    if (s === 'fail') worst = 'fail'
    else if (s === 'warn' && worst !== 'fail') worst = 'warn'
  }

  if (structural) {
    const refTotal = frozenTotalResidentMb(ref)
    const curTotal = frozenTotalResidentMb(cur)
    if (refTotal != null && curTotal != null) {
      const skipHeapSaving = compareHeapFrozenTotalResidentMb(refTotal, curTotal, compareMetric, bump)
      compareHeapSavingPct(ref, cur, skipHeapSaving, compareMetric, bump)
    } else {
      console.log('  (heap metrics unavailable for one side; skipped)')
    }
    if (ref.heapMb?.frozen != null && cur.heapMb?.frozen != null) {
      compareHeapFrozenMb(ref.heapMb.frozen, cur.heapMb.frozen, compareMetric, bump, { informative: true })
    }
    if (ref.loadMs?.binary != null && cur.loadMs?.binary != null) {
      compareTimingMetric('loadBinary (ms)', ref.loadMs.binary, cur.loadMs.binary, 'loadBinaryMs', bump)
    }
    if (ref.indexing?.saveBinaryMs != null && cur.indexing?.saveBinaryMs != null) {
      compareTimingMetric('saveBinary (ms)', ref.indexing.saveBinaryMs, cur.indexing.saveBinaryMs, 'saveBinaryMs', bump)
    }
    if (ref.indexing?.toJSONMs != null && cur.indexing?.toJSONMs != null) {
      compareTimingMetric('toJSON (ms)', ref.indexing.toJSONMs, cur.indexing.toJSONMs, 'freezeMs', bump, { informative: true })
    }
    if (ref.indexing?.freezeMs != null && cur.indexing?.freezeMs != null) {
      compareTimingMetric('freeze import (ms)', ref.indexing.freezeMs, cur.indexing.freezeMs, 'freezeMs', bump)
    }
    if (ref.diskMb?.binary != null && cur.diskMb?.binary != null) {
      bump(compareMetric('disk binary (MB)', ref.diskMb.binary, cur.diskMb.binary, 'heapFrozenMb'))
    }
    if (ref.memoryBreakdown?.postings && cur.memoryBreakdown?.postings) {
      bump(compareMetric('postings typed (MB)', mb(ref.memoryBreakdown.postings.totalTypedBytes), mb(cur.memoryBreakdown.postings.totalTypedBytes), 'heapFrozenMb'))
      bump(compareMetric('term index est. (MB)', mb(ref.memoryBreakdown.termIndex.estimatedBytes), mb(cur.memoryBreakdown.termIndex.estimatedBytes), 'heapFrozenMb'))
    }
  } else {
    console.log('  (indexing / heap / disk / load — skipped, search-only profile)')
  }

  const refSearch = Object.fromEntries(ref.search.map((r) => [r.label, r]))
  for (const row of cur.search) {
    const prev = refSearch[row.label]
    if (!prev) continue
    if (
      prev.batchSize != null
      && row.batchSize != null
      && prev.batchSize !== row.batchSize
    ) {
      console.log(
        `  warn batchSize ${row.label.padEnd(16)} ref=${prev.batchSize} cur=${row.batchSize} (timing not comparable)`,
      )
    }
    const s = compareSearchMetric(`search p50 ${row.label}`, prev.frozenP50, row.frozenP50)
    if (strictSearch || !structural) {
      bump(s)
    } else if (s !== 'ok') {
      console.log('       (search timing informational only; use --strict to fail on search)')
    }
  }

  return worst
}

function mb (bytes) {
  return Number((bytes / 1024 / 1024).toFixed(3))
}

function main () {
  if (forceRun) {
    console.error('diffBaseline.js compares existing JSON files. Use `make benchmark-diff-run` or `node benchmarks/framework/cli.mjs diff --run` to capture first.')
    process.exit(1)
  }

  const referencePath = argValue('--reference', argv) ?? REFERENCE_PATH
  const currentPath = argValue('--current', argv) ?? LATEST_PATH
  const reference = loadJson(referencePath)

  console.log(`Comparing ${currentPath} → ${referencePath} (no re-run; use make benchmark-diff-run to measure again)\n`)
  if (runs !== DEFAULT_BENCHMARK_RUNS || searchIterations !== DEFAULT_SEARCH_ITERATIONS) {
    console.log('Note: --runs / --iterations apply only when capturing a new latest.json.\n')
  }
  const current = loadJson(currentPath)

  console.log(`Reference: ${reference.capturedAt} @ ${reference.git?.commitShort}`)
  console.log(`Current:   ${current.capturedAt} @ ${current.git?.commitShort}${current.git?.dirty ? ' (dirty)' : ''}`)
  if (reference.node && current.node && reference.node !== current.node) {
    console.warn(`⚠ Node ${current.node} vs reference ${reference.node} — timing comparison is indicative only.\n`)
  }
  if (reference.minisearchVersion && current.minisearchVersion
    && reference.minisearchVersion !== current.minisearchVersion) {
    console.warn(
      `⚠ minisearch ${current.minisearchVersion} vs reference ${reference.minisearchVersion} — mutable baseline may differ.\n`,
    )
  }
  const curRuns = current.runs ?? 1
  const curIters = current.searchIterations ?? '(legacy)'
  const curProfile = payloadProfile(current)
  const refProfile = payloadProfile(reference)
  const diffSearchOnly = !payloadHasStructuralData(current)
    || !payloadHasStructuralData(reference)
    || isCpuOnlySurfaces(surfaces)
  const refHeapProto = reference.heapBenchProtocol?.version
  const curHeapProto = current.heapBenchProtocol?.version
  if (refHeapProto != null && curHeapProto != null && refHeapProto !== curHeapProto) {
    console.warn(
      `⚠ heapBenchProtocol v${curHeapProto} vs reference v${refHeapProto} — heap deltas are indicative only.\n`,
    )
  } else if (curHeapProto == null && refHeapProto == null && !diffSearchOnly) {
    console.warn(
      `⚠ No heapBenchProtocol metadata (pre-v${HEAP_BENCH_PROTOCOL_VERSION} captures) — heap comparison uses legacy method.\n`,
    )
  }
  if (forceRun) {
    console.log(`Measured:  ${runs} run(s)/scenario, ${searchIterations} search iterations, profile=${curProfile}`)
  } else {
    console.log(`Captured:  ${curRuns} run(s)/scenario, ${curIters} search iterations, profile=${curProfile}`)
  }
  if (diffSearchOnly) {
    console.log('Diff mode: search p50 only (indexing / save / load / heap omitted)\n')
  } else if (refProfile === 'search' && curProfile === 'full') {
    console.warn('Warning: reference is search-only but current is full — structural lines compare mixed profiles.\n')
  }

  const curById = Object.fromEntries(current.scenarios.map((s) => [s.id, s]))
  let overall = 'ok'

  for (const refScenario of reference.scenarios) {
    const curScenario = curById[refScenario.id]
    if (!curScenario) {
      console.log(`\nMissing scenario in current capture: ${refScenario.id}`)
      overall = 'fail'
      continue
    }
    const status = compareScenario(refScenario, curScenario, { structural: !diffSearchOnly })
    if (status === 'fail') overall = 'fail'
    else if (status === 'warn' && overall === 'ok') overall = 'warn'
  }

  console.log(`\n${'='.repeat(72)}`)
  if (overall === 'ok') {
    console.log('No significant regressions vs reference.')
  } else if (overall === 'warn') {
    console.log('Warnings: some metrics regressed within warn thresholds.')
  } else {
    console.log('FAIL: regressions exceed thresholds. Review before merging.')
  }
  console.log('='.repeat(72))
  if (!diffSearchOnly) {
    console.log('\nThresholds (fail): frozen totalResident +10%; loadBinary +20%; total resident saving −10 pts.')
    console.log(`Search p50: abs floor below ${SEARCH_MS_FLOOR} ms; informational unless --strict.`)
  } else {
    console.log(`\nSearch-only thresholds (fail): +${SEARCH_PCT_FAIL}% or floor rules below ${SEARCH_MS_FLOOR} ms baseline.`)
  }
  console.log('Workflow: benchmark:record once → benchmark:diff (or diff other JSON via --current).\n')

  if (overall === 'fail') process.exit(1)
}

main()
