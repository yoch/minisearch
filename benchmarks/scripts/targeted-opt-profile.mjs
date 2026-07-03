#!/usr/bin/env node
/**
 * Targeted optimization profile for before/after experiments.
 *
 * Keeps the regular benchmark machinery, but restricts work to a chosen set of
 * scenarios and writes JSON outside the tracked baselines by default.
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/targeted-opt-profile.mjs \
 *     --out=/tmp/minisearch-opt-baseline/targeted-profile.json \
 *     --surfaces=search,search-levels,build,load
 */
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildBenchmarkScenarios, runScenario } from '../benchmarkSuite.js'
import { runHeapSuite, mergeHeapIntoScenarios } from '../framework/runHeapSuite.mjs'
import { collectRunMetadata } from '../benchmarkUtils.js'
import { argValue, boolArg, intArg, listArg, median } from './cpuBenchUtils.mjs'

const DEFAULT_SCENARIOS = [
  'extreme-giantVocabulary',
  'extreme-manyFields',
  'sparseFields-50kTerms-20Fields',
  'divina-indexOnly',
  'divina-storeFields',
]

function scenarioMap() {
  return new Map(buildBenchmarkScenarios().map(s => [s.id, s]))
}

function pickScenarios(ids) {
  const byId = scenarioMap()
  return ids.map(id => {
    const scenario = byId.get(id)
    if (scenario == null) throw new Error(`Unknown scenario: ${id}`)
    return scenario
  })
}

function aggregateRuns(results) {
  if (results.length === 1) return results[0]
  const first = results[0]
  const out = { ...first }

  if (first.indexing != null) {
    out.indexing = {}
    for (const key of Object.keys(first.indexing)) {
      const values = results.map(r => r.indexing?.[key]).filter(v => typeof v === 'number')
      if (values.length > 0) out.indexing[key] = Number(median(values).toFixed(2))
    }
    if (first.indexing.binaryMagic != null) out.indexing.binaryMagic = first.indexing.binaryMagic
  }

  if (first.loadMs != null) {
    out.loadMs = {}
    for (const key of Object.keys(first.loadMs)) {
      const values = results.map(r => r.loadMs?.[key]).filter(v => typeof v === 'number')
      if (values.length > 0) out.loadMs[key] = Number(median(values).toFixed(2))
    }
  }

  if (first.search != null) {
    out.search = first.search.map((row, i) => {
      const merged = { ...row }
      for (const key of ['mutableP50', 'mutableP95', 'frozenP50', 'frozenP95', 'pairedRatioP50', 'frozenP50VsMutablePct']) {
        const values = results.map(r => r.search?.[i]?.[key]).filter(v => typeof v === 'number')
        if (values.length > 0) merged[key] = Number(median(values).toFixed(4))
      }
      return merged
    })
  }

  if (first.searchLevels != null) {
    out.searchLevels = {}
    for (const label of Object.keys(first.searchLevels)) {
      out.searchLevels[label] = first.searchLevels[label]
      const l1 = results.map(r => r.searchLevels?.[label]?.L1?.frozenP50).filter(v => typeof v === 'number')
      if (l1.length > 0) {
        out.searchLevels[label] = {
          ...out.searchLevels[label],
          L1: {
            ...out.searchLevels[label].L1,
            frozenP50: Number(median(l1).toFixed(4)),
          },
        }
      }
    }
  }

  out.profileRuns = results.length
  return out
}

function emitProgress(eventFile, event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event })
  console.error(line)
  appendFileSync(eventFile, line + '\n')
}

function summarizeScenario(result) {
  const summary = {}
  if (result.search != null) {
    summary.search = result.search.map(row => ({
      label: row.label,
      frozenP50: row.frozenP50,
      frozenP95: row.frozenP95,
    }))
  }
  if (result.searchLevels != null) {
    summary.searchLevels = Object.fromEntries(
      Object.entries(result.searchLevels).map(([label, levels]) => [
        label,
        {
          L1: levels.L1?.frozenP50,
          L2: levels.L2?.frozenP50,
        },
      ]),
    )
  }
  if (result.indexing != null) summary.indexing = result.indexing
  if (result.loadMs != null) summary.loadMs = result.loadMs
  return summary
}

const out = argValue('--out') ?? '/tmp/minisearch-opt-profile.json'
const eventFile = argValue('--events') ?? `${out}.events.ndjson`
const partialOut = argValue('--partial') ?? `${out}.partial.json`
const scenarioIds = listArg('scenarios', DEFAULT_SCENARIOS)
const surfaces = listArg('surfaces', ['search', 'search-levels', 'build', 'load'])
const runs = intArg('runs', 1)
const progress = boolArg('progress', true)
const heap = process.argv.includes('--heap') || surfaces.includes('memory')
const cpuSurfaces = surfaces.filter(s => s !== 'memory' && s !== 'breakdown')
const scenarios = pickScenarios(scenarioIds)

const payload = {
  ...collectRunMetadata(),
  profileKind: 'targeted-opt-profile',
  runs,
  scenarioIds,
  surfaces,
  scenarios: [],
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(eventFile, '')
if (progress) {
  emitProgress(eventFile, {
    event: 'start',
    out,
    partialOut,
    scenarioIds,
    surfaces,
    runs,
  })
}

for (const scenario of scenarios) {
  if (progress) emitProgress(eventFile, { event: 'scenario:start', scenarioId: scenario.id })
  const scenarioRuns = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    if (progress) emitProgress(eventFile, { event: 'run:start', scenarioId: scenario.id, run: i + 1, runs })
    const result = runScenario(scenario, { surfaces: cpuSurfaces })
    scenarioRuns.push(result)
    if (progress) {
      emitProgress(eventFile, {
        event: 'run:done',
        scenarioId: scenario.id,
        run: i + 1,
        runs,
        elapsedMs: Number((performance.now() - started).toFixed(1)),
        summary: summarizeScenario(result),
      })
    }
  }
  const aggregated = aggregateRuns(scenarioRuns)
  payload.scenarios.push(aggregated)
  writeFileSync(partialOut, JSON.stringify(payload, null, 2) + '\n')
  if (progress) {
    emitProgress(eventFile, {
      event: 'scenario:done',
      scenarioId: scenario.id,
      summary: summarizeScenario(aggregated),
    })
  }
}

if (heap) {
  if (progress) emitProgress(eventFile, { event: 'heap:start', scenarioIds })
  const heapSuite = runHeapSuite({
    scenarioIds,
    paths: ['mutable-addAll', 'frozen-fromDocuments'],
  })
  payload.heapBenchProtocol = heapSuite.heapBenchProtocol
  payload.scenarios = mergeHeapIntoScenarios(payload.scenarios, heapSuite)
  writeFileSync(partialOut, JSON.stringify(payload, null, 2) + '\n')
  if (progress) emitProgress(eventFile, { event: 'heap:done', scenarioIds })
}

writeFileSync(out, JSON.stringify(payload, null, 2) + '\n')
if (progress) emitProgress(eventFile, { event: 'done', out })
console.log(`Wrote ${out}`)
