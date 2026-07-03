/**
 * Capture freeze variance + phase profile on pathological migrate scenarios.
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/analyze-freeze-pathological.mjs
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/analyze-freeze-pathological.mjs --runs=15
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  buildFrozenAssembleParamsFromMiniSearchSnapshot,
} from '../../src/fromMiniSearch.ts'
import {
  frozenAssembleWithCtor,
  frozenFromMiniSearchSnapshot,
  parseSnapshotIndex,
} from '../harness/frozenSourceInternals.ts'
import { packTermsFromList } from '../../src/PackedRadixTree/packTermList.ts'
import { validateFrozenTermIndexLeaves } from '../../src/frozenTermIndex.ts'
import { validateFrozenPostingsLayout } from '../../src/frozenPostings.ts'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { runScenario } from '../benchmarkSuite.js'
import { medianOf } from '../benchmarkUtils.js'
import { intArg } from './cpuBenchUtils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REF_PATH = join(__dirname, '../baselines/reference.json')

const SCENARIO_IDS = [
  'extreme-overflowFrequency',
  'extreme-highFrequency',
  'denseNumericIds-100k',
  'genericStringIds-100k',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
  'extreme-giantVocabulary',
]

const runs = intArg('runs', 15, { min: 3 })
const profileIters = intArg('profile-iters', 12, { min: 3 })
const warmup = intArg('warmup', 2, { min: 0 })
const outPath = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]
  ?? join(__dirname, '../baselines/freeze-pathological-analysis.json')

function sampleStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((sum, x) => sum + x, 0) / n
  const variance = sorted.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n
  const stdev = Math.sqrt(variance)
  return {
    min: sorted[0],
    p50: medianOf(sorted),
    p95: sorted[Math.max(0, Math.ceil(n * 0.95) - 1)],
    max: sorted[n - 1],
    mean: Number(mean.toFixed(3)),
    stdev: Number(stdev.toFixed(3)),
    cvPct: mean > 0 ? Number(((stdev / mean) * 100).toFixed(1)) : 0,
  }
}

function timedSamples(fn, { warmup: w, iterations }) {
  for (let i = 0; i < w; i++) fn()
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return sampleStats(samples)
}

function refFreezeMs(id) {
  try {
    const ref = JSON.parse(readFileSync(REF_PATH, 'utf8'))
    const row = ref.scenarios.find((s) => s.id === id)
    return row?.indexing?.freezeMs ?? null
  } catch {
    return null
  }
}

function captureFreeze(scenario) {
  const samples = []
  for (let i = 0; i < runs; i++) {
    const r = runScenario(scenario, { surfaces: ['migrate'] })
    samples.push(r.indexing.freezeMs)
  }
  return sampleStats(samples)
}

function profileScenario(scenario) {
  const { corpus, options } = scenario
  const ms = new MiniSearch(options)
  ms.addAll(corpus)
  const snapshot = ms.toJSON()
  const fieldCount = options.fields.length
  const nextId = snapshot.nextId
  const terms = snapshot.index.map(([term]) => term)
  const params = buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options)

  const phases = {
    toJSON: () => ms.toJSON(),
    parseSnapshotIndex: () => parseSnapshotIndex(snapshot, fieldCount, nextId),
    packTermsOnly: () => packTermsFromList(terms),
    finalizePostings: () => {
      const parsed = parseSnapshotIndex(snapshot, fieldCount, nextId)
      return parsed.accumulator.finalize(parsed.termCount, nextId)
    },
    buildFrozenParams: () => buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options),
    validateTermIndex: () => validateFrozenTermIndexLeaves(params.index, params.termCount),
    validatePostings: () => validateFrozenPostingsLayout(
      params.postings,
      params.documentCount,
      params.nextId,
    ),
    assembleTrusted: () => frozenAssembleWithCtor(
      params,
      true,
      'minisearch-json',
      FrozenMiniSearch,
    ),
    assembleUntrusted: () => frozenAssembleWithCtor(
      params,
      false,
      'minisearch-json',
      FrozenMiniSearch,
    ),
    freezeImport: () => frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options),
  }

  const profile = {}
  for (const [name, fn] of Object.entries(phases)) {
    profile[name] = timedSamples(fn, { warmup, iterations: profileIters })
  }

  const parseP50 = profile.parseSnapshotIndex.p50
  const finalizeP50 = profile.finalizePostings.p50
  const paramsP50 = profile.buildFrozenParams.p50
  const freezeP50 = profile.freezeImport.p50
  const validationDelta = profile.assembleUntrusted.p50 - profile.assembleTrusted.p50

  return {
    meta: {
      docs: corpus.length,
      terms: snapshot.index.length,
      nextId: snapshot.nextId,
      documentCount: snapshot.documentCount,
    },
    profile,
    derived: {
      postingsMs: Number((finalizeP50 - parseP50).toFixed(3)),
      shellMs: Number((paramsP50 - finalizeP50).toFixed(3)),
      assembleValidationMs: Number(validationDelta.toFixed(3)),
      parseSharePct: freezeP50 > 0 ? Number(((parseP50 / freezeP50) * 100).toFixed(1)) : 0,
      unaccountedMs: Number((freezeP50 - paramsP50).toFixed(3)),
    },
  }
}

const payload = {
  capturedAt: new Date().toISOString(),
  runs,
  profileIters,
  scenarios: {},
}

console.log(`Freeze pathological analysis — runs=${runs}, profile-iters=${profileIters}\n`)
console.log(
  `${'scenario'.padEnd(36)} ${'ref'.padStart(7)} ${'p50'.padStart(7)} ${'stdev'.padStart(6)} ${'cv%'.padStart(5)} ${'min-max'.padStart(14)} ${'Δ%'.padStart(7)}`,
)
console.log('─'.repeat(90))

for (const id of SCENARIO_IDS) {
  const scenario = getScenarioById(id)
  if (scenario == null) {
    console.error(`Missing scenario: ${id}`)
    continue
  }

  process.stderr.write(`Capturing ${id}…\n`)
  const freeze = captureFreeze(scenario)
  const ref = refFreezeMs(id)
  const deltaPct = ref != null && ref > 0
    ? Number((((freeze.p50 - ref) / ref) * 100).toFixed(1))
    : null

  process.stderr.write(`Profiling ${id}…\n`)
  const detail = profileScenario(scenario)

  payload.scenarios[id] = {
    refFreezeMs: ref,
    freeze,
    deltaPctVsRef: deltaPct,
    ...detail,
  }

  const minMax = `${freeze.min.toFixed(1)}-${freeze.max.toFixed(1)}`
  const deltaStr = deltaPct == null ? '—' : `${deltaPct > 0 ? '+' : ''}${deltaPct}%`
  console.log(
    `${id.padEnd(36)} ${String(ref ?? '—').padStart(7)} ${freeze.p50.toFixed(2).padStart(7)} ${freeze.stdev.toFixed(2).padStart(6)} ${String(freeze.cvPct).padStart(5)} ${minMax.padStart(14)} ${deltaStr.padStart(7)}`,
  )
}

writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')
console.log(`\nWrote ${outPath}`)

console.log('\nPhase highlights (p50 ms):')
for (const id of SCENARIO_IDS) {
  const row = payload.scenarios[id]
  if (row == null) continue
  const p = row.profile
  const d = row.derived
  console.log(`\n${id}`)
  console.log(`  parse=${p.parseSnapshotIndex.p50.toFixed(1)} packOnly=${p.packTermsOnly.p50.toFixed(1)} finalize=${p.finalizePostings.p50.toFixed(1)} params=${p.buildFrozenParams.p50.toFixed(1)} freeze=${p.freezeImport.p50.toFixed(1)}`)
  console.log(`  shell=${d.shellMs} postings=${d.postingsMs} assembleΔ(trusted→untrusted)=${d.assembleValidationMs} toJSON=${p.toJSON.p50.toFixed(1)} (excl. freeze) unaccounted=${d.unaccountedMs}`)
  console.log(`  validateTermIndex=${p.validateTermIndex.p50.toFixed(2)} validatePostings=${p.validatePostings.p50.toFixed(2)}`)
}
