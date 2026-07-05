#!/usr/bin/env node
/**
 * Paired build peak benchmark for accumulator memory experiments.
 *
 *   node --expose-gc benchmarks/scripts/build-peak-ab-compare.mjs --runs=7
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createPeakHeapSampler,
  gc,
  measureHeap,
  medianOf,
} from '../benchmarkUtils.js'
import { getScenarioById } from '../scenarioRegistry.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 7)
const treatmentRepo = process.argv.find((a) => a.startsWith('--treatment-repo='))?.split('=')[1] ?? root
const baselineRepo = process.argv.find((a) => a.startsWith('--baseline-repo='))?.split('=')[1]
  ?? join(root, '.worktrees/freeze-control')

const scenarioIds = [
  'divina-indexOnly',
  'divina-storeFields',
  'extreme-manyFields',
  'denseNumericIds-100k',
]

async function loadRepo(repoRoot) {
  const mod = await import(pathToFileURL(join(repoRoot, 'dist/es/index.js')).href)
  return {
    createFrozenIndexBuilder: mod.createFrozenIndexBuilder,
    freezeFrozenIndexBuilder: mod.freezeFrozenIndexBuilder,
  }
}

function measureBuildPeak(loader, scenario) {
  gc()
  const sampler = createPeakHeapSampler()
  const builder = loader.createFrozenIndexBuilder(scenario.options, {
    estimatedDocumentCount: scenario.corpus.length,
  })
  for (const doc of scenario.corpus) {
    builder.add(doc)
    sampler.sample()
  }
  const peakAfterAddMb = sampler.peakHeapMb()
  const peakAfterAddTotalResidentMb = sampler.peakTotalResidentMb()
  const frozen = loader.freezeFrozenIndexBuilder(builder)
  sampler.sample()
  const finished = sampler.finish(frozen)
  gc()
  const retained = measureHeap(() => frozen)
  return {
    peakHeapMb: finished.peakHeapMb,
    peakTotalResidentMb: finished.peakTotalResidentMb,
    peakAfterAddMb,
    peakAfterAddTotalResidentMb,
    freezeDeltaMb: Number((finished.peakHeapMb - peakAfterAddMb).toFixed(4)),
    freezeDeltaTotalResidentMb: Number((finished.peakTotalResidentMb - peakAfterAddTotalResidentMb).toFixed(4)),
    retainedHeapMb: retained.heapMb,
    termCount: frozen.termCount,
    documentCount: frozen.documentCount,
  }
}

function pctDelta(control, treatment) {
  return control > 0 ? ((treatment - control) / control) * 100 : 0
}

function summarizeMetric(rows, key) {
  const treatment = rows.map((r) => r.treatment[key])
  const control = rows.map((r) => r.control[key])
  const delta = rows.map((r) => r.treatment[key] - r.control[key])
  const deltaPct = rows.map((r) => pctDelta(r.control[key], r.treatment[key]))
  return {
    treatmentMedian: Number(medianOf(treatment).toFixed(4)),
    controlMedian: Number(medianOf(control).toFixed(4)),
    deltaMedian: Number(medianOf(delta).toFixed(4)),
    deltaPctMedian: Number(medianOf(deltaPct).toFixed(2)),
  }
}

function summarize(rows) {
  return {
    peakHeapMb: summarizeMetric(rows, 'peakHeapMb'),
    peakTotalResidentMb: summarizeMetric(rows, 'peakTotalResidentMb'),
    freezeDeltaMb: summarizeMetric(rows, 'freezeDeltaMb'),
    freezeDeltaTotalResidentMb: summarizeMetric(rows, 'freezeDeltaTotalResidentMb'),
    retainedHeapMb: summarizeMetric(rows, 'retainedHeapMb'),
    shapeStable: rows.every((r) => (
      r.treatment.termCount === r.control.termCount
      && r.treatment.documentCount === r.control.documentCount
    )),
    runs: rows,
  }
}

async function main() {
  const treatment = await loadRepo(treatmentRepo)
  const control = await loadRepo(baselineRepo)
  const out = {}

  for (const id of scenarioIds) {
    const scenario = getScenarioById(id)
    if (scenario == null) throw new Error(`Unknown scenario ${id}`)
    const paired = []
    for (let run = 0; run < runs; run++) {
      const treatmentFirst = run % 2 === 0
      let treatmentSample
      let controlSample
      if (treatmentFirst) {
        treatmentSample = measureBuildPeak(treatment, scenario)
        gc()
        controlSample = measureBuildPeak(control, scenario)
      } else {
        controlSample = measureBuildPeak(control, scenario)
        gc()
        treatmentSample = measureBuildPeak(treatment, scenario)
      }
      paired.push({
        run,
        treatmentFirst,
        treatment: treatmentSample,
        control: controlSample,
      })
      gc()
    }
    out[id] = summarize(paired)
    const row = out[id]
    console.log(`\n${id}`)
    console.log(`  peak total resident delta ${row.peakTotalResidentMb.deltaPctMedian}% (${row.peakTotalResidentMb.deltaMedian} MB)`)
    console.log(`  peak heap delta           ${row.peakHeapMb.deltaPctMedian}% (${row.peakHeapMb.deltaMedian} MB)`)
    console.log(`  freeze delta              ${row.freezeDeltaMb.deltaPctMedian}% (${row.freezeDeltaMb.deltaMedian} MB)`)
    console.log(`  retained heap delta       ${row.retainedHeapMb.deltaPctMedian}% (${row.retainedHeapMb.deltaMedian} MB)`)
  }

  const payload = {
    capturedAt: new Date().toISOString(),
    runs,
    treatmentRepo,
    controlRepo: baselineRepo,
    out,
  }
  const outPath = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]
  if (outPath) writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
