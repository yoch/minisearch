/**
 * Memory pressure of the freeze import intermediate (parseSnapshotIndex accumulator).
 *
 * The freeze path streams postings into an IncrementalPostingsAccumulator during
 * JSON parse before finalize emits typed arrays. This probe sizes that intermediate
 * and guards it against a reference Map<fieldId, Map<shortId,freq>> representation in the same
 * process.
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-freeze-memory.mjs
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-freeze-memory.mjs --runs=5
 */
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import { parseSnapshotIndex } from '../../src/fromMiniSearch.ts'
import { frozenFromMiniSearchSnapshot } from '../harness/frozenSourceInternals.ts'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { measureHeap, gc, medianOf } from '../benchmarkUtils.js'
import {
  emitGcAuditMarker,
  gcAuditChildEnabled,
  gcAuditRequested,
  gcAuditRuns,
  runGcAuditScript,
} from '../gcAudit.js'
import { intArg } from './cpuBenchUtils.mjs'
import { fileURLToPath } from 'node:url'

const SCENARIOS = {
  dense: 'denseNumericIds-100k',
  highFrequency: 'extreme-highFrequency',
  overflow: 'extreme-overflowFrequency',
  giant: 'extreme-giantVocabulary',
  docId: 'docIdUint16Boundary-65536',
}

const runs = intArg('runs', 3, { min: 1 })
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const GC_AUDIT_CHILD = gcAuditChildEnabled()

/** Reference representation the parsed intermediate must not regress beyond. */
function buildMapIntermediate(snapshot) {
  const { index: entries, serializationVersion } = snapshot
  const out = new Array(entries.length)
  for (let ti = 0; ti < entries.length; ti++) {
    const data = entries[ti][1]
    const dataMap = new Map()
    for (const fieldId of Object.keys(data)) {
      const raw = data[fieldId]
      const rec = serializationVersion === 1 && raw != null && typeof raw === 'object' && 'ds' in raw
        ? raw.ds
        : raw
      const freqs = new Map()
      for (const [docId, freq] of Object.entries(rec)) {
        freqs.set(Number(docId), freq)
      }
      dataMap.set(Number(fieldId), freqs)
    }
    out[ti] = dataMap
  }
  return out
}

function medianMb(samples) {
  return Number(medianOf(samples).toFixed(3))
}

function run(scenarioKey) {
  const scenario = getScenarioById(SCENARIOS[scenarioKey])
  const { corpus, options } = scenario
  const ms = new MiniSearch(options)
  ms.addAll(corpus)
  const snapshot = ms.toJSON()
  const fieldCount = options.fields.length
  const nextId = snapshot.nextId

  const arrayIntermediate = []
  const mapIntermediate = []
  const finalIndex = []
  const transientPeak = []

  for (let i = 0; i < runs; i++) {
    const auditMeta = GC_AUDIT_CHILD ? { scenarioId: scenario.id, run: i } : null
    gc()
    if (auditMeta != null) emitGcAuditMarker('parse-start', { ...auditMeta, measureWindow: true })
    // Isolate the postings intermediate: keep only the accumulator alive so the
    // PackedRadixTree built alongside is collected and not counted here.
    arrayIntermediate.push(
      measureHeap(() => parseSnapshotIndex(snapshot, fieldCount, nextId).accumulator).heapBytes,
    )
    if (auditMeta != null) emitGcAuditMarker('parse-end', { ...auditMeta, measureWindow: true })
    gc()
    if (auditMeta != null) emitGcAuditMarker('map-start', { ...auditMeta, measureWindow: true })
    mapIntermediate.push(measureHeap(() => buildMapIntermediate(snapshot)).heapBytes)
    if (auditMeta != null) emitGcAuditMarker('map-end', { ...auditMeta, measureWindow: true })
    gc()
    if (auditMeta != null) emitGcAuditMarker('final-start', { ...auditMeta, measureWindow: true })
    finalIndex.push(measureHeap(() => frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options)).heapBytes)
    if (auditMeta != null) emitGcAuditMarker('final-end', { ...auditMeta, measureWindow: true })

    // Transient peak estimate: heapUsed just after the synchronous import,
    // before GC reclaims the dead intermediate, above a freshly-gc'd baseline.
    gc()
    if (auditMeta != null) emitGcAuditMarker('transient-start', { ...auditMeta, measureWindow: true })
    const baseline = process.memoryUsage().heapUsed
    const frozen = frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options)
    const afterCall = process.memoryUsage().heapUsed
    void frozen.documentCount
    transientPeak.push(afterCall - baseline)
    if (auditMeta != null) emitGcAuditMarker('transient-end', { ...auditMeta, measureWindow: true })
  }

  const toMb = (b) => b / 1024 / 1024
  return {
    id: scenario.id,
    docs: corpus.length,
    terms: snapshot.index.length,
    arrayIntermediateMb: medianMb(arrayIntermediate.map(toMb)),
    mapIntermediateMb: medianMb(mapIntermediate.map(toMb)),
    finalIndexMb: medianMb(finalIndex.map(toMb)),
    transientPeakMb: medianMb(transientPeak.map(toMb)),
  }
}

const keys = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1]?.split(',')
  ?? Object.keys(SCENARIOS)

if (typeof global.gc !== 'function') {
  console.warn('Warning: run with --expose-gc for stable heap measurements\n')
}

console.log(`Freeze import memory — runs=${runs} (retained heap of intermediate vs final)\n`)
console.log(
  `${'scenario'.padEnd(30)} ${'terms'.padStart(8)} ${'current'.padStart(9)} ${'mapRef'.padStart(9)} ${'Δ vs ref'.padStart(12)} ${'final'.padStart(9)} ${'transient'.padStart(10)}`,
)
console.log('─'.repeat(92))

for (const key of keys) {
  const r = run(key)
  const delta = r.arrayIntermediateMb - r.mapIntermediateMb
  const deltaPct = r.mapIntermediateMb > 0 ? (delta / r.mapIntermediateMb) * 100 : 0
  console.log(
    `${r.id.padEnd(30)} ${String(r.terms).padStart(8)} ${`${r.arrayIntermediateMb}`.padStart(9)} ${`${r.mapIntermediateMb}`.padStart(9)} ${`${delta >= 0 ? '+' : ''}${delta.toFixed(2)} (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}%)`.padStart(12)} ${`${r.finalIndexMb}`.padStart(9)} ${`${r.transientPeakMb}`.padStart(10)}`,
  )
}
console.log('\nAll values MB. current=parseSnapshotIndex intermediate, mapRef=reference Map representation.')
console.log('transient = heapUsed delta right after import before GC (dead intermediate still resident).')

if (!GC_AUDIT_CHILD && gcAuditRequested()) {
  const scriptArgs = process.argv.slice(2).filter(arg => arg !== '--gc-audit')
  if (!scriptArgs.some(arg => arg === '--runs' || arg.startsWith('--runs='))) {
    scriptArgs.push(`--runs=${gcAuditRuns(runs)}`)
  }
  const audit = runGcAuditScript({
    scriptPath: SCRIPT_PATH,
    scriptArgs,
    env: process.env,
    extraNodeArgs: ['--import', 'tsx'],
  })
  console.log(`GC audit: ${audit.clean ? 'clean' : 'major GC observed'} (${audit.unexpectedMajorGcCount} unexpected major GC in measured windows)`)
}
