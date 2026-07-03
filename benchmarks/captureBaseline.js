/**
 * Run the full benchmark suite and write JSON results.
 *
 *   pnpm benchmark:record              → benchmarks/baselines/latest.json
 *   pnpm benchmark:record --reference → benchmarks/baselines/reference.json
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCleanTrackedTree,
  collectRunMetadata,
  enrichGitForBaseline,
  hasStructuralSurfaces,
  parseBenchmarkArgs,
  argValue,
} from './benchmarkUtils.js'
import { runBenchmarkSuite, buildBenchmarkScenarios } from './benchmarkSuite.js'
import { getSearchBenchProtocol } from './loadSearchBenchBatches.js'
import { cpuSurfacesWithoutHeap, needsHeapPhase } from './framework/surfaces.mjs'
import { runHeapSuite, mergeHeapIntoScenarios } from './framework/runHeapSuite.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES_DIR = join(__dirname, 'baselines')

const useReference = process.argv.includes('--reference')
const force = process.argv.includes('--force')
const outFile = join(BASELINES_DIR, useReference ? 'reference.json' : 'latest.json')
const mergeInto = argValue('--merge-into')
const { runs, searchIterations, surfaces } = parseBenchmarkArgs()

if (mergeInto) {
  console.log(`Merging heap phase into ${mergeInto}…\n`)
  if (!global.gc) {
    console.warn('Warning: run with NODE_OPTIONS=--expose-gc or node --expose-gc for accurate heap.\n')
  }
  const base = JSON.parse(readFileSync(mergeInto, 'utf8'))
  const heapSuite = runHeapSuite({ reference: useReference })
  if (heapSuite.heapBenchProtocol) {
    base.heapBenchProtocol = heapSuite.heapBenchProtocol
  }
  base.scenarios = mergeHeapIntoScenarios(base.scenarios, heapSuite)
  writeFileSync(mergeInto, JSON.stringify(base, null, 2) + '\n')
  console.log(`Merged heap results into ${mergeInto}`)
  process.exit(0)
}

if (useReference) {
  assertCleanTrackedTree({ force, context: 'MiniSearch reference.json' })
}

console.log('Running benchmark suite (requires --expose-gc for stable heap)...\n')
if (!global.gc) {
  console.warn('Warning: run with NODE_OPTIONS=--expose-gc or node --expose-gc for accurate heap.\n')
}

const meta = collectRunMetadata()
const runHeap = needsHeapPhase(surfaces)
const cpuSurfaces = runHeap ? cpuSurfacesWithoutHeap(surfaces) : surfaces
const memoryOnly = surfaces.length === 1 && surfaces[0] === 'memory'

let scenarios
let heapBenchProtocol

if (memoryOnly) {
  console.log('Benchmark profile: memory-only (isolated heap phase)\n')
  const heapSuite = runHeapSuite({ reference: useReference })
  heapBenchProtocol = heapSuite.heapBenchProtocol
  const cpuStubs = buildBenchmarkScenarios().map((s) => ({
    id: s.id,
    name: s.name,
    documentCount: s.corpus.length,
    fields: s.options.fields,
    storeFields: s.options.storeFields || [],
    benchSurfaces: ['memory'],
  }))
  scenarios = mergeHeapIntoScenarios(cpuStubs, heapSuite)
} else if (runHeap) {
  console.log(`Benchmark profile: CPU surfaces [${cpuSurfaces.join(', ')}] then isolated heap phase\n`)
  const cpuScenarios = runBenchmarkSuite(undefined, runs, { surfaces: cpuSurfaces })
  const heapSuite = runHeapSuite({ reference: useReference })
  heapBenchProtocol = heapSuite.heapBenchProtocol
  scenarios = mergeHeapIntoScenarios(cpuScenarios, heapSuite)
} else {
  scenarios = runBenchmarkSuite(undefined, runs, { surfaces })
}

const payload = {
  ...meta,
  recordKind: useReference
    ? (force ? 'forced-dirty' : 'clean-commit')
    : 'local-latest',
  runs,
  searchIterations,
  benchSurfaces: surfaces,
  searchBenchProtocol: getSearchBenchProtocol(),
  ...(heapBenchProtocol ? { heapBenchProtocol } : {}),
  scenarios,
}

if (useReference && !force) {
  payload.git = enrichGitForBaseline(meta.git)
  payload.baselineCommit = payload.git.commit
}

function printScenarioSummary(scenario, defaultSurfaces) {
  const scenarioSurfaces = scenario.benchSurfaces ?? defaultSurfaces
  if (!hasStructuralSurfaces(scenarioSurfaces)) {
    const gain = scenario.summary?.searchFrozenP50AvgGainPct
    console.log(`  - ${scenario.id}: search-only${gain == null ? '' : ` (avg frozen p50 gain ${gain}%)`}`)
    return
  }

  if (scenario.heapMb?.frozen != null) {
    console.log(`  - ${scenario.id}: frozen total ${scenario.heapMb.frozenTotalResident ?? scenario.memoryMb?.frozen?.totalResidentApprox} MB (${scenario.heapMb.frozenVsMutableSavingPct}% vs mutable)`)
    return
  }

  if (scenario.heapSkipped) {
    console.log(`  - ${scenario.id}: heap skipped (${scenario.heapSkipped})`)
    return
  }

  const notes = []
  if (scenario.loadMs?.binary != null) notes.push(`loadBinary ${scenario.loadMs.binary} ms`)
  if (scenario.diskMb?.binary != null) notes.push(`disk binary ${scenario.diskMb.binary} MB`)
  if (scenario.indexing?.toJSONMs != null) notes.push(`toJSON ${scenario.indexing.toJSONMs} ms`)
  if (scenario.indexing?.freezeMs != null) notes.push(`freeze ${scenario.indexing.freezeMs} ms`)
  if (scenario.summary?.searchFrozenP50AvgGainPct != null) notes.push(`avg frozen p50 gain ${scenario.summary.searchFrozenP50AvgGainPct}%`)
  const details = notes.length > 0 ? notes.join(', ') : `surfaces=[${scenarioSurfaces.join(',')}]`
  console.log(`  - ${scenario.id}: ${details}`)
}

mkdirSync(BASELINES_DIR, { recursive: true })
writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n')

console.log(`Wrote ${outFile}`)
console.log(`  commit: ${payload.git.commitShort}${payload.git.dirty ? ' (dirty)' : ''}`)
if (useReference) {
  console.log(`  baselineCommit: ${payload.baselineCommit ?? payload.git.commit}`)
}
if (payload.git.dirty && !useReference) {
  console.warn('  warning: working tree is dirty; latest.json may be harder to reproduce')
}
console.log(`  surfaces: ${payload.benchSurfaces.join(', ')}`)
console.log(`  runs: ${runs}, search iterations: ${searchIterations} (median per scenario)`)
if (heapBenchProtocol) {
  console.log(`  heap protocol: v${heapBenchProtocol.version}, trials=${heapBenchProtocol.trials}, scenarios=${heapBenchProtocol.scenarioAllowlist.length}`)
}
console.log(`  scenarios: ${payload.scenarios.length}`)
for (const s of payload.scenarios) {
  printScenarioSummary(s, payload.benchSurfaces)
}
