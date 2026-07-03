/**
 * G2 — systematic posting-ratio gate calibration (local only, not CI).
 *
 * Layers:
 *   1. Micro: scan vs seek vs gated-scan on (gateSize × postingLength) grid
 *   2. Policy: sweep minLength × ratioShift; classify synthetic + real cases
 *   3. End-to-end: timed search() on real cases per shortlisted policy
 *
 *   pnpm build
 *   node benchmarks/scripts/calibrate-gate-posting-ratio.mjs [--warmup=20] [--iterations=120]
 *   node benchmarks/scripts/calibrate-gate-posting-ratio.mjs --out=/tmp/gate-ratio-grid.json
 */
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  DEFAULT_AND_GATE_LIMITS,
  DEFAULT_POSTING_GATE_POLICY,
  gateIsSelectiveEnough,
  passGateByPostingRatio,
  postingGateMaxRatio,
  resolveGateMaxSize,
} from '../../src/queryEngineGateLimits.ts'
import {
  executeRawWithRunOptions,
  frozenFromMiniSearch,
  frozenPostings,
  frozenTermIndex,
} from '../harness/frozenSourceInternals.ts'
import { executeRaw } from '../harness/frozenSourceInternals.ts'
import {
  docIdUint16Boundary,
  giantVocabulary,
  highFrequencyTerms,
} from '../benchmarkScenarios.js'
import { argValue, intArg, median } from './cpuBenchUtils.mjs'

function readDocId(docIds, index) {
  return docIds[index]
}

function findDocIndex(docIds, offset, length, docId) {
  let lo = 0
  let hi = length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const v = readDocId(docIds, offset + mid)
    if (v < docId) lo = mid + 1
    else if (v > docId) hi = mid - 1
    else return offset + mid
  }
  return -1
}

function runScan(docIds, freqs, offset, length, allowed) {
  let hits = 0
  let score = 0
  for (let i = 0; i < length; i++) {
    const docId = readDocId(docIds, offset + i)
    if (allowed.has(docId)) {
      hits++
      score += freqs[offset + i]
    }
  }
  return { hits, score }
}

function runSeek(docIds, freqs, offset, length, allowed) {
  let hits = 0
  let score = 0
  for (const docId of allowed) {
    const index = findDocIndex(docIds, offset, length, docId)
    if (index >= 0) {
      hits++
      score += freqs[index]
    }
  }
  return { hits, score }
}

function runFullScan(docIds, freqs, offset, length) {
  let score = 0
  for (let i = 0; i < length; i++) {
    score += freqs[offset + i]
  }
  return score
}

function benchMicro(fn, warmup, iterations) {
  for (let i = 0; i < warmup; i++) fn()
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

function buildGate(gateSize, listLength) {
  const gate = new Set()
  if (gateSize === listLength) {
    for (let i = 0; i < listLength; i++) gate.add(i)
  } else if (gateSize === 1) {
    gate.add(Math.floor(listLength / 2))
  } else {
    const step = Math.max(1, Math.floor(listLength / gateSize))
    for (let i = 0, added = 0; added < gateSize && i < listLength; i += step, added++) {
      gate.add(i)
    }
  }
  return gate
}

function collectSyntheticMicro(warmup, iterations) {
  const gateSizes = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000, 2000, 5000, 8000, 11_111, 12_500, 15_000, 20_000, 50_000]
  const listLengths = [256, 512, 1024, 2048, 4096, 8192, 10_000, 20_000, 50_000]
  const rows = []

  for (const listLength of listLengths) {
    const docIds = new Uint32Array(listLength)
    const freqs = new Uint8Array(listLength)
    for (let i = 0; i < listLength; i++) {
      docIds[i] = i
      freqs[i] = 1
    }
    const offset = 0

    for (const gateSize of gateSizes) {
      if (gateSize > listLength) continue
      const gate = buildGate(gateSize, listLength)
      const ratio = gateSize / listLength
      const fullUs = benchMicro(() => runFullScan(docIds, freqs, offset, listLength), Math.min(warmup, 20), Math.min(iterations, 80))
      const scanUs = benchMicro(() => runScan(docIds, freqs, offset, listLength, gate), Math.min(warmup, 20), Math.min(iterations, 80))
      const seekUs = benchMicro(() => runSeek(docIds, freqs, offset, listLength, gate), Math.min(warmup, 20), Math.min(iterations, 80))
      const gatedPathUs = seekUs
      const speedupVsFullPct = fullUs > 0 ? ((fullUs - gatedPathUs) / fullUs) * 100 : 0
      const seekVsScanPct = scanUs > 0 ? ((scanUs - seekUs) / scanUs) * 100 : 0
      rows.push({
        gateSize,
        listLength,
        ratio,
        fullUs,
        scanUs,
        seekUs,
        gatedWinsVsFull: speedupVsFullPct > 5,
        seekWinsVsScan: seekVsScanPct > 5,
        speedupVsFullPct,
        seekVsScanPct,
      })
    }
  }
  return rows
}

function corpusSharedBucket(docCount, bucketMod, bucketId) {
  const docs = []
  for (let i = 0; i < docCount; i++) {
    const bucket = i % bucketMod
    docs.push({
      id: i,
      txt: bucket === bucketId
        ? `shared bucket${bucketId} token${i}`
        : `shared noise${i} token${i}`,
    })
  }
  return docs
}

function postingLengthForTerm(frozen, term) {
  const ti = frozenTermIndex(frozen).get(term)
  if (ti == null) return 0
  const layout = frozenPostings(frozen)
  if (layout.layout === 'dense') {
    return layout.denseLengths[ti * layout.fieldCount]
  }
  const start = layout.sparseTermStarts[ti]
  const end = layout.sparseTermStarts[ti + 1]
  for (let i = start; i < end; i++) {
    if (layout.sparseFieldIds[i] === 0) return layout.sparseLengths[i]
  }
  return 0
}

function buildFrozen(docs, searchOptions = {}) {
  const options = { fields: ['txt'], storeFields: [], searchOptions }
  const ms = new MiniSearch(options)
  ms.addAll(docs)
  return frozenFromMiniSearch(FrozenMiniSearch, ms, options)
}

function collectRealCases() {
  const cases = []

  {
    const frozen = buildFrozen(giantVocabulary(50000), { prefix: true })
    const andPrefix = { combineWith: 'AND', prefix: true }
    const gate = executeRaw(frozen, 'unique1', andPrefix).size
    cases.push({
      id: 'giantPrefix',
      label: 'giant AND+prefix unique1 common',
      docCount: 50000,
      gateSize: gate,
      branch2Term: 'common',
      postingLength: postingLengthForTerm(frozen, 'common'),
      query: 'unique1 common',
      searchOptions: andPrefix,
      frozen,
      expectPassGood: true,
      role: 'target',
    })
  }

  {
    const frozen = buildFrozen(giantVocabulary(50000), {})
    cases.push({
      id: 'giantAndExact',
      label: 'giant AND exact',
      docCount: 50000,
      gateSize: 1,
      branch2Term: 'common',
      postingLength: postingLengthForTerm(frozen, 'common'),
      query: 'unique1 common',
      searchOptions: { combineWith: 'AND' },
      frozen,
      expectPassGood: true,
      role: 'target',
    })
  }

  {
    const docs = highFrequencyTerms(10000)
    const frozen = buildFrozen(docs, {})
    cases.push({
      id: 'highFrequencyAnd',
      label: 'highFrequency AND alpha beta',
      docCount: 10000,
      gateSize: 10000,
      branch2Term: 'beta',
      postingLength: postingLengthForTerm(frozen, 'beta'),
      query: 'alpha beta',
      searchOptions: { combineWith: 'AND' },
      frozen,
      expectPassGood: false,
      role: 'guard',
    })
  }

  {
    const docs = corpusSharedBucket(10000, 100, 7)
    const frozen = buildFrozen(docs, {})
    const gate = executeRaw(frozen, 'bucket7', { combineWith: 'AND' }).size
    cases.push({
      id: 'selectiveAndBucket',
      label: 'bucket7 shared AND',
      docCount: 10000,
      gateSize: gate,
      branch2Term: 'shared',
      postingLength: postingLengthForTerm(frozen, 'shared'),
      query: 'bucket7 shared',
      searchOptions: { combineWith: 'AND' },
      frozen,
      expectPassGood: true,
      role: 'target',
    })
  }

  {
    const docs = []
    for (let i = 0; i < 6000; i++) docs.push({ id: i, txt: `alpha beta token${i}` })
    const frozen = buildFrozen(docs, { prefix: false })
    cases.push({
      id: 'largeIntersection6000',
      label: 'alpha beta on 6k uniform (parity guard)',
      docCount: 6000,
      gateSize: 6000,
      branch2Term: 'beta',
      postingLength: postingLengthForTerm(frozen, 'beta'),
      query: 'alpha beta',
      searchOptions: { combineWith: 'AND' },
      frozen,
      expectPassGood: false,
      role: 'guard',
    })
  }

  {
    const frozen = buildFrozen(docIdUint16Boundary(65535), {})
    cases.push({
      id: 'docIdExact',
      label: 'docId65535 exact alpha',
      docCount: 65535,
      gateSize: 65535,
      branch2Term: 'alpha',
      postingLength: postingLengthForTerm(frozen, 'alpha'),
      query: 'alpha',
      searchOptions: {},
      frozen,
      expectPassGood: false,
      role: 'guard',
    })
  }

  return cases
}

const MIN_LENGTH_GRID = [512, 1024, 2048, 4096, 8192]
const RATIO_SHIFT_GRID = [1, 2, 3, 4] // max ratio 50%, 25%, 12.5%, 6.25%

function evaluatePolicyGrid(syntheticMicro, realCases) {
  const policies = []
  for (const minLength of MIN_LENGTH_GRID) {
    for (const ratioShift of RATIO_SHIFT_GRID) {
      const policy = { minLength, ratioShift }
      const maxRatio = postingGateMaxRatio(policy)

      let synthPass = 0
      let synthWin = 0
      let synthLose = 0
      for (const row of syntheticMicro) {
        if (!passGateByPostingRatio(row.gateSize, row.listLength, policy)) continue
        synthPass++
        if (row.gatedWinsVsFull) synthWin++
        else if (row.speedupVsFullPct < -5) synthLose++
      }

      const realEval = realCases.map(c => {
        const absOnly = gateIsSelectiveEnough(c.gateSize, c.docCount, DEFAULT_AND_GATE_LIMITS)
        const withRatio = gateIsSelectiveEnough(
          c.gateSize,
          c.docCount,
          DEFAULT_AND_GATE_LIMITS,
          c.postingLength,
          policy,
        )
        return {
          id: c.id,
          role: c.role,
          gateSize: c.gateSize,
          postingLength: c.postingLength,
          ratio: c.gateSize / c.postingLength,
          absOnly,
          withRatio,
          expectPassGood: c.expectPassGood,
        }
      })

      const guardBadPass = realEval.filter(r => r.role === 'guard' && r.withRatio && !r.expectPassGood)
      const targetMiss = realEval.filter(r => r.role === 'target' && r.expectPassGood && !r.withRatio)

      policies.push({
        policy,
        maxRatio,
        synthPass,
        synthWin,
        synthLose,
        realEval,
        guardBadPass: guardBadPass.map(r => r.id),
        targetMiss: targetMiss.map(r => r.id),
        valid: guardBadPass.length === 0 && targetMiss.length === 0,
        score: synthWin - synthLose * 2 - guardBadPass.length * 50 - targetMiss.length * 20,
      })
    }
  }
  policies.sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    if (b.policy.minLength !== a.policy.minLength) return b.policy.minLength - a.policy.minLength
    return a.policy.ratioShift - b.policy.ratioShift
  })
  return policies
}

function timeExecuteQuery(frozen, query, searchOptions, run, warmup, iterations) {
  for (let i = 0; i < warmup; i++) {
    executeRawWithRunOptions(frozen, query, searchOptions, run)
  }
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    executeRawWithRunOptions(frozen, query, searchOptions, run)
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

function endToEndPolicies(realCases, policies, warmup, iterations) {
  const baseline = { postingGatePolicy: { minLength: Number.MAX_SAFE_INTEGER, ratioShift: 2 } }
  const top = policies.slice(0, 5)
  const rows = []
  for (const c of realCases.filter(x => x.searchOptions.combineWith === 'AND' || x.id === 'giantPrefix')) {
    if (c.id === 'docIdExact') continue
    const baseMs = timeExecuteQuery(c.frozen, c.query, c.searchOptions, baseline, warmup, iterations)
    rows.push({ caseId: c.id, policy: 'absOnly', minLength: null, ratioShift: null, p50Ms: baseMs })
    for (const p of top) {
      const ms = timeExecuteQuery(c.frozen, c.query, c.searchOptions, { postingGatePolicy: p.policy }, warmup, iterations)
      rows.push({
        caseId: c.id,
        policy: `min${p.policy.minLength}_shift${p.policy.ratioShift}`,
        minLength: p.policy.minLength,
        ratioShift: p.policy.ratioShift,
        maxRatio: p.maxRatio,
        p50Ms: ms,
        vsAbsOnlyPct: ((ms - baseMs) / baseMs) * 100,
      })
    }
    const defMs = timeExecuteQuery(c.frozen, c.query, c.searchOptions, {}, warmup, iterations)
    rows.push({
      caseId: c.id,
      policy: 'defaultCurrent',
      minLength: DEFAULT_POSTING_GATE_POLICY.minLength,
      ratioShift: DEFAULT_POSTING_GATE_POLICY.ratioShift,
      p50Ms: defMs,
      vsAbsOnlyPct: ((defMs - baseMs) / baseMs) * 100,
    })
  }
  return rows
}

const warmup = intArg('warmup', 25)
const iterations = intArg('iterations', 100)
const microIterations = intArg('microIterations', Math.min(iterations, 120))
const outPath = argValue('--out') ?? '/tmp/calibrate-gate-posting-ratio.json'

console.error('Layer 1: synthetic micro grid...')
const syntheticMicro = collectSyntheticMicro(warmup, microIterations)

console.error('Layer 2: real case metadata...')
const realCases = collectRealCases()

console.error('Layer 3: policy sweep...')
const policyGrid = evaluatePolicyGrid(syntheticMicro, realCases)

console.error('Layer 4: end-to-end top policies...')
const e2e = endToEndPolicies(realCases, policyGrid, warmup, Math.min(iterations, 25))

const recommendation = {
  defaultCurrent: DEFAULT_POSTING_GATE_POLICY,
  validPolicies: policyGrid.filter(p => p.valid).slice(0, 10).map(p => ({
    policy: p.policy,
    maxRatio: p.maxRatio,
    score: p.score,
    synthPass: p.synthPass,
    synthWin: p.synthWin,
    synthLose: p.synthLose,
    realEval: p.realEval,
  })),
  topPolicies: policyGrid.slice(0, 8).map(p => ({
    policy: p.policy,
    maxRatio: p.maxRatio,
    score: p.score,
    synthPass: p.synthPass,
    synthWin: p.synthWin,
    synthLose: p.synthLose,
    guardBadPass: p.guardBadPass,
    targetMiss: p.targetMiss,
    realEval: p.realEval,
  })),
  rationale: [
    'validPolicies: targetMiss=[] AND guardBadPass=[] (required for production).',
    'ratioShift=2 → max gate 25% of posting; giantPrefix gate 11111/50000 passes, highFreq 100% fails.',
    'ratioShift=3 → max 12.5%; misses giantPrefix (11111 > 6250).',
    'Among valid policies, prefer higher minLength (less surface) if e2e within noise.',
  ],
}

const report = {
  capturedAt: new Date().toISOString(),
  warmup,
  iterations,
  microIterations,
  grids: { minLength: MIN_LENGTH_GRID, ratioShift: RATIO_SHIFT_GRID },
  syntheticMicro,
  realCases: realCases.map(c => ({
    id: c.id,
    label: c.label,
    role: c.role,
    docCount: c.docCount,
    gateSize: c.gateSize,
    postingLength: c.postingLength,
    ratio: c.gateSize / c.postingLength,
    maxGateAbs: resolveGateMaxSize(c.docCount),
  })),
  policyGrid,
  endToEnd: e2e,
  recommendation,
}

writeFileSync(outPath, JSON.stringify(report, null, 2))
console.error(`Wrote ${outPath}`)

console.error('\n=== Real cases ===')
for (const c of report.realCases) {
  console.error(
    `  ${c.id}: gate=${c.gateSize} posting=${c.postingLength} ratio=${(c.ratio * 100).toFixed(1)}% maxGateAbs=${c.maxGateAbs}`,
  )
}

console.error('\n=== Valid policies (targets + guards OK) ===')
for (const p of recommendation.validPolicies.slice(0, 6)) {
  console.error(
    `  minLen=${p.policy.minLength} shift=${p.policy.ratioShift} (maxRatio=${(p.maxRatio * 100).toFixed(1)}%)`
    + ` synthWin=${p.synthWin} synthLose=${p.synthLose}`,
  )
}

console.error('\n=== Top policies by score (may miss targets) ===')
for (const p of recommendation.topPolicies.slice(0, 5)) {
  console.error(
    `  minLen=${p.policy.minLength} shift=${p.policy.ratioShift} (maxRatio=${(p.maxRatio * 100).toFixed(1)}%)`
    + ` score=${p.score} synthWin=${p.synthWin} synthLose=${p.synthLose}`
    + ` guardBad=${JSON.stringify(p.guardBadPass)} targetMiss=${JSON.stringify(p.targetMiss)}`,
  )
}

console.error('\n=== End-to-end giantPrefix (absOnly vs default vs top) ===')
for (const row of e2e.filter(r => r.caseId === 'giantPrefix')) {
  console.error(`  ${row.policy.padEnd(22)} ${row.p50Ms.toFixed(2)} ms${row.vsAbsOnlyPct != null ? ` (${row.vsAbsOnlyPct.toFixed(1)}% vs absOnly)` : ''}`)
}
