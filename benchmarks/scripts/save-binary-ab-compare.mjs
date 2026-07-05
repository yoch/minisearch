#!/usr/bin/env node
/**
 * Paired saveBinary benchmark for growable wire-writer experiments.
 *
 *   node --expose-gc benchmarks/scripts/save-binary-ab-compare.mjs --runs=15 --compression=raw
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gc, medianOf } from '../benchmarkUtils.js'
import { getScenarioById } from '../scenarioRegistry.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 15)
const compression = process.argv.find((a) => a.startsWith('--compression='))?.split('=')[1] ?? 'raw'
const treatmentRepo = process.argv.find((a) => a.startsWith('--treatment-repo='))?.split('=')[1] ?? root
const baselineRepo = process.argv.find((a) => a.startsWith('--baseline-repo='))?.split('=')[1]
  ?? join(root, '.worktrees/freeze-control')

const scenarioIds = [
  'divina-storeFields',
  'extreme-largeDocuments',
  'genericStringIds-100k',
  'saveBinaryAfterNoTerms',
  'synthetic-jsonIds-storeFields',
]

async function loadFrozenMiniSearch(repoRoot) {
  return (await import(pathToFileURL(join(repoRoot, 'dist/es/index.js')).href)).default
}

function syntheticJsonIdsStoreFields() {
  const docs = Array.from({ length: 8000 }, (_, i) => ({
    id: { source: 'synthetic', i, shard: i % 17 },
    txt: `alpha beta token${i % 1000}`,
    stored: `payload-${i}-` + 'x'.repeat(256),
    meta: { group: i % 13, active: i % 2 === 0 },
  }))
  return {
    id: 'synthetic-jsonIds-storeFields',
    name: 'Synthetic - JSON ids + stored fields',
    corpus: docs,
    options: { fields: ['txt'], idField: 'id', storeFields: ['stored', 'meta'] },
  }
}

function scenarioById(id) {
  if (id === 'synthetic-jsonIds-storeFields') return syntheticJsonIdsStoreFields()
  const scenario = getScenarioById(id)
  if (scenario == null) throw new Error(`Unknown scenario ${id}`)
  return scenario
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    median: Number(medianOf(sorted).toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    samples: sorted.map((x) => Number(x.toFixed(3))),
  }
}

function summarizePaired(rows) {
  return {
    treatment: summarize(rows.map((r) => r.treatmentMs)),
    control: summarize(rows.map((r) => r.controlMs)),
    deltaMs: summarize(rows.map((r) => r.treatmentMs - r.controlMs)),
    deltaPct: summarize(rows.map((r) => (r.controlMs > 0 ? ((r.treatmentMs - r.controlMs) / r.controlMs) * 100 : 0))),
    sizeBytes: {
      treatment: rows[0]?.treatmentBytes ?? 0,
      control: rows[0]?.controlBytes ?? 0,
      equal: rows.every((r) => r.treatmentBytes === r.controlBytes),
    },
    bytesEqual: rows.every((r) => r.bytesEqual),
    runs: rows,
  }
}

function timedSave(index) {
  const t0 = performance.now()
  const buf = index.saveBinarySync({ compression })
  return { ms: performance.now() - t0, buf: Buffer.from(buf) }
}

async function main() {
  const Treatment = await loadFrozenMiniSearch(treatmentRepo)
  const Control = await loadFrozenMiniSearch(baselineRepo)
  const out = {}

  for (const id of scenarioIds) {
    const scenario = scenarioById(id)
    const paired = []
    for (let run = 0; run < runs; run++) {
      const treatmentIndex = Treatment.fromDocuments(scenario.corpus, scenario.options)
      const controlIndex = Control.fromDocuments(scenario.corpus, scenario.options)
      const treatmentFirst = run % 2 === 0
      let treatment
      let control
      if (treatmentFirst) {
        gc()
        treatment = timedSave(treatmentIndex)
        gc()
        control = timedSave(controlIndex)
      } else {
        gc()
        control = timedSave(controlIndex)
        gc()
        treatment = timedSave(treatmentIndex)
      }
      paired.push({
        run,
        treatmentFirst,
        treatmentMs: Number(treatment.ms.toFixed(3)),
        controlMs: Number(control.ms.toFixed(3)),
        deltaPct: Number((control.ms > 0 ? ((treatment.ms - control.ms) / control.ms) * 100 : 0).toFixed(3)),
        treatmentBytes: treatment.buf.length,
        controlBytes: control.buf.length,
        bytesEqual: treatment.buf.equals(control.buf),
      })
      gc()
    }
    out[id] = summarizePaired(paired)
    const row = out[id]
    console.log(`\n${id}`)
    console.log(`  control   median=${row.control.median} ms`)
    console.log(`  treatment median=${row.treatment.median} ms`)
    console.log(`  delta     ${row.deltaPct.median}% (${row.deltaMs.median} ms)`)
    console.log(`  bytes     equal=${row.bytesEqual} size ${row.sizeBytes.control} -> ${row.sizeBytes.treatment}`)
  }

  const payload = {
    capturedAt: new Date().toISOString(),
    runs,
    compression,
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
