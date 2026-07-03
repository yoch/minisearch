#!/usr/bin/env node
/**
 * Paired migrate-like freeze benchmark: rebuild index, toJSON, stringify, gc, freeze.
 *
 *   node --expose-gc benchmarks/scripts/freeze-ab-compare.mjs --runs=15
 *   node --expose-gc benchmarks/scripts/freeze-ab-compare.mjs --mode=baseline --out=...
 *   node --expose-gc benchmarks/scripts/freeze-ab-compare.mjs --mode=paired --baseline-repo=.worktrees/d379e6f
 */
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import MiniSearch from 'minisearch'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { gc, medianOf } from '../benchmarkUtils.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 15)
const mode = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'compare'
const baselineRepo = process.argv.find((a) => a.startsWith('--baseline-repo='))?.split('=')[1]
  ?? join(root, '.worktrees/freeze-control')
const scenarioIds = [
  'extreme-giantVocabulary',
  'denseNumericIds-100k',
  'docIdUint16Boundary-65536',
]

function gitShort(repoRoot) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return '?'
  }
}

async function loadRepo(repoRoot) {
  const FrozenMiniSearch = (await import(pathToFileURL(join(repoRoot, 'dist/es/index.js')).href)).default
  let frozenFromMiniSearchSnapshot
  try {
    ;({ frozenFromMiniSearchSnapshot } = await import(pathToFileURL(join(repoRoot, 'testSupport/frozenImportHelpers.ts')).href))
  } catch {
    ;({ frozenFromMiniSearchSnapshot } = await import(pathToFileURL(join(repoRoot, 'src/internal/frozenInternals.ts')).href))
  }
  return { FrozenMiniSearch, frozenFromMiniSearchSnapshot }
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    median: Number(medianOf(sorted).toFixed(2)),
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    samples: sorted.map((x) => Number(x.toFixed(2))),
  }
}

function summarizePairedRuns(runs) {
  const deltaMs = runs.map((r) => r.treatmentMs - r.controlMs)
  const deltaPct = runs.map((r) => (
    r.controlMs > 0 ? ((r.treatmentMs - r.controlMs) / r.controlMs) * 100 : 0
  ))
  const sortedDeltaMs = [...deltaMs].sort((a, b) => a - b)
  const sortedDeltaPct = [...deltaPct].sort((a, b) => a - b)
  return {
    treatment: summarize(runs.map((r) => r.treatmentMs)),
    control: summarize(runs.map((r) => r.controlMs)),
    deltaMs: {
      median: Number(medianOf(sortedDeltaMs).toFixed(2)),
      min: Number(sortedDeltaMs[0].toFixed(2)),
      max: Number(sortedDeltaMs[sortedDeltaMs.length - 1].toFixed(2)),
      samples: sortedDeltaMs.map((x) => Number(x.toFixed(2))),
    },
    deltaPct: {
      median: Number(medianOf(sortedDeltaPct).toFixed(2)),
      min: Number(sortedDeltaPct[0].toFixed(2)),
      max: Number(sortedDeltaPct[sortedDeltaPct.length - 1].toFixed(2)),
      samples: sortedDeltaPct.map((x) => Number(x.toFixed(2))),
    },
    runs,
  }
}

async function measureRepo(repoRoot, label) {
  const { FrozenMiniSearch, frozenFromMiniSearchSnapshot } = await loadRepo(repoRoot)
  const out = {}
  for (const id of scenarioIds) {
    const sc = getScenarioById(id)
    const samples = []
    for (let i = 0; i < runs; i++) {
      const ms = new MiniSearch(sc.options)
      ms.addAll(sc.corpus)
      const snap = ms.toJSON()
      JSON.stringify(ms.toJSON())
      gc()
      const t0 = performance.now()
      frozenFromMiniSearchSnapshot(FrozenMiniSearch, snap, sc.options)
      samples.push(performance.now() - t0)
    }
    out[id] = summarize(samples)
  }
  return { label, commit: gitShort(repoRoot), repoRoot, out }
}

async function measurePaired(treatmentRepo, controlRepo) {
  const treatment = await loadRepo(treatmentRepo)
  const control = await loadRepo(controlRepo)
  const out = {}
  for (const id of scenarioIds) {
    const sc = getScenarioById(id)
    const pairedRuns = []
    for (let i = 0; i < runs; i++) {
      const ms = new MiniSearch(sc.options)
      ms.addAll(sc.corpus)
      const snap = ms.toJSON()
      JSON.stringify(ms.toJSON())
      gc()
      const treatmentFirst = i % 2 === 0
      const runOne = (loader) => {
        const t0 = performance.now()
        loader.frozenFromMiniSearchSnapshot(loader.FrozenMiniSearch, snap, sc.options)
        return performance.now() - t0
      }
      let treatmentMs
      let controlMs
      if (treatmentFirst) {
        treatmentMs = runOne(treatment)
        gc()
        controlMs = runOne(control)
      } else {
        controlMs = runOne(control)
        gc()
        treatmentMs = runOne(treatment)
      }
      pairedRuns.push({
        run: i,
        treatmentFirst,
        treatmentMs: Number(treatmentMs.toFixed(2)),
        controlMs: Number(controlMs.toFixed(2)),
        deltaMs: Number((treatmentMs - controlMs).toFixed(2)),
        deltaPct: Number((controlMs > 0 ? ((treatmentMs - controlMs) / controlMs) * 100 : 0).toFixed(2)),
      })
      gc()
    }
    out[id] = summarizePairedRuns(pairedRuns)
  }
  return {
    treatment: { commit: gitShort(treatmentRepo), repoRoot: treatmentRepo },
    control: { commit: gitShort(controlRepo), repoRoot: controlRepo },
    out,
  }
}

function printCompare(head, baseline) {
  for (const id of scenarioIds) {
    const h = head.out[id]
    const b = baseline.out[id]
    const pct = ((h.median - b.median) / b.median * 100).toFixed(1)
    console.log(`\n${id}`)
    console.log(`  baseline  median=${b.median} ms  range ${b.min}-${b.max}`)
    console.log(`  treatment median=${h.median} ms  range ${h.min}-${h.max}`)
    console.log(`  Δ         ${pct}%`)
  }
}

function printPaired(paired) {
  for (const id of scenarioIds) {
    const row = paired.out[id]
    const t = row.treatment
    const c = row.control
    const pct = row.deltaPct.median.toFixed(1)
    console.log(`\n${id}`)
    console.log(`  control   median=${c.median} ms  range ${c.min}-${c.max}`)
    console.log(`  treatment median=${t.median} ms  range ${t.min}-${t.max}`)
    console.log(`  Δ median  ${pct}%  (${row.deltaMs.median} ms)`)
    console.log(`  Δ range   ${row.deltaPct.min}% .. ${row.deltaPct.max}%`)
  }
}

let payload
if (mode === 'baseline') {
  const baseline = await measureRepo(root, 'baseline')
  payload = { capturedAt: new Date().toISOString(), runs, mode, baseline }
  console.log(`baseline @ ${baseline.commit}`)
  for (const id of scenarioIds) {
    const b = baseline.out[id]
    console.log(`  ${id}: median=${b.median} ms range ${b.min}-${b.max}`)
  }
} else if (mode === 'paired') {
  const paired = await measurePaired(root, baselineRepo)
  payload = { capturedAt: new Date().toISOString(), runs, mode, paired }
  console.log(`paired treatment=${paired.treatment.commit} control=${paired.control.commit}`)
  printPaired(paired)
} else {
  const head = await measureRepo(root, 'HEAD')
  const baseline = await measureRepo(baselineRepo, 'baseline')
  payload = { capturedAt: new Date().toISOString(), runs, mode, head, baseline }
  printCompare(head, baseline)
}

const outPath = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]
if (outPath) writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')
