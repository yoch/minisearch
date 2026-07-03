/**
 * Fast AND-gate hyperparameter sweep (internal thresholds only — not public API).
 *
 *   pnpm benchmark:and-gate-tuning          # quick grid (~15s)
 *   AND_GATE_SWEEP=full pnpm benchmark:and-gate-tuning
 *
 * Each case uses terms that exist in the corpus and a known intersection size.
 * Output: benchmarks/baselines/and-gate-tuning.json + console trend summary.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../dist/es/index.js'
import { frozenFromMiniSearch, searchWithRunOptions } from './harness/frozenSourceInternals.ts'
import {
  DEFAULT_AND_GATE_LIMITS,
  gateIsSelectiveEnough,
  resolveGateMaxSize,
} from '../src/queryEngineGateLimits.ts'
import { loadDivinaLines } from './loadDivinaLines.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, 'baselines', 'and-gate-tuning.json')

const SWEEP = process.env.AND_GATE_SWEEP === 'full' ? 'full' : 'quick'
const TIMED = Number(process.env.AND_GATE_TIMED) || (SWEEP === 'full' ? 5 : 3)
const WARMUP = 1

const ABS_GRID = SWEEP === 'full'
  ? [250, 500, 1000, 2000, 5000, 10_000]
  : [500, 2000, 5000, 10_000]

const FRAC_GRID = SWEEP === 'full'
  ? [0.02, 0.05, 0.1, 0.15, 0.2, 0.25]
  : [0.05, 0.1, 0.2]

/** Shared + rare bucket: `shared` in every doc, `bucketK` in docCount/bucketMod docs. */
function corpusSharedBucket (docCount, bucketMod, bucketId) {
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
  const gateSize = Math.floor(docCount / bucketMod) + (docCount % bucketMod > bucketId ? 1 : 0)
  return { docs, gateSize }
}

function corpusAllTerms (docCount) {
  const docs = []
  for (let i = 0; i < docCount; i++) {
    docs.push({ id: i, txt: `alpha beta token${i}` })
  }
  return { docs, gateSize: docCount }
}

function buildFrozen (docs, searchOptions = { prefix: true, fuzzy: 0.2 }) {
  const options = { fields: ['txt'], storeFields: [], searchOptions }
  const ms = new MiniSearch(options)
  ms.addAll(docs)
  return frozenFromMiniSearch(FrozenMiniSearch, ms, options)
}

function median (arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function syntheticGateProbe (docCount, gateSize, gateLimits) {
  const maxGateSize = resolveGateMaxSize(docCount, gateLimits ?? DEFAULT_AND_GATE_LIMITS)
  return [{
    gateSize,
    maxGateSize,
    selective: gateIsSelectiveEnough(gateSize, docCount, gateLimits ?? DEFAULT_AND_GATE_LIMITS),
  }]
}

function timeSearch (frozen, query, opts, gateLimits, docCount, gateSize, { disableGating = false } = {}) {
  const run = disableGating ? { disableGating: true } : { gateLimits }
  for (let w = 0; w < WARMUP; w++) {
    searchWithRunOptions(frozen, query, opts, run)
  }
  const times = []
  for (let i = 0; i < TIMED; i++) {
    const t0 = performance.now()
    searchWithRunOptions(frozen, query, opts, run)
    times.push(performance.now() - t0)
  }
  return {
    p50: median(times),
    probe: disableGating ? [] : syntheticGateProbe(docCount, gateSize ?? 0, gateLimits),
  }
}

/** Synthetic cases with deterministic gate sizes (terms tokenized from indexed text). */
function buildCases () {
  const bucket2k = corpusSharedBucket(2000, 10, 5)
  const bucket3k = corpusSharedBucket(3000, 10, 3)
  const all3k = corpusAllTerms(3000)
  const divina = loadDivinaLines().slice(0, 1500)

  return [
    {
      id: 'and-selective-tiny',
      description: 'AND bucket5 then shared on 2k docs (~200 doc gate after branch 0); narrow term first',
      docCount: 2000,
      gateSizeExpected: bucket2k.gateSize,
      expectSelectiveAtDefault: true,
      build: () => buildFrozen(bucket2k.docs),
      query: 'bucket5 shared',
      opts: { combineWith: 'AND' },
    },
    {
      id: 'and-selective-medium',
      description: 'AND bucket3 then shared on 3k docs (~300 doc gate); narrow term first',
      docCount: 3000,
      gateSizeExpected: bucket3k.gateSize,
      expectSelectiveAtDefault: true,
      build: () => buildFrozen(bucket3k.docs),
      query: 'bucket3 shared',
      opts: { combineWith: 'AND' },
    },
    {
      id: 'and-non-selective-full',
      description: 'AND alpha then beta on 3k docs (gate=3000 after branch 0); exceeds default maxGate (300)',
      docCount: 3000,
      gateSizeExpected: all3k.gateSize,
      expectSelectiveAtDefault: false,
      build: () => buildFrozen(all3k.docs),
      query: 'alpha beta',
      opts: { combineWith: 'AND' },
    },
    {
      id: 'and-prefix-divina',
      description: 'Real Divina subset (1.5k lines): AND+prefix infe para (0 matches, empty gate)',
      docCount: 1500,
      gateSizeExpected: 0,
      expectSelectiveAtDefault: true,
      build: () => buildFrozen(divina, { prefix: true, fuzzy: 0.2 }),
      query: 'infe para',
      opts: { combineWith: 'AND', prefix: true },
    },
    {
      id: 'and-real-divina',
      description: 'Real Divina: AND inferno paradiso (small selective gate)',
      docCount: 1500,
      gateSizeExpected: null,
      expectSelectiveAtDefault: true,
      build: () => buildFrozen(divina),
      query: 'inferno paradiso',
      opts: { combineWith: 'AND' },
    },
    {
      id: 'and-not-selective',
      description: 'AND_NOT bucket5 minus shared (positive branch narrow); no AND gate probe on step 0',
      docCount: 2000,
      gateSizeExpected: bucket2k.gateSize,
      expectSelectiveAtDefault: null,
      build: () => buildFrozen(bucket2k.docs),
      query: 'bucket5 shared',
      opts: { combineWith: 'AND_NOT' },
    },
  ]
}

function summarizeTrends (cases, gridResults) {
  const defaultLimits = DEFAULT_AND_GATE_LIMITS
  console.log('\n--- Gate trend (probe at AND branch 1: gate = |branch0|) ---')
  console.log('case'.padEnd(22), 'gate', 'max@default', 'selective@default', 'ms@default', 'ms naive')
  for (const c of cases) {
    const def = gridResults.find(r => r.caseId === c.id && r.maxAbsolute === defaultLimits.maxAbsolute
      && r.maxFraction === defaultLimits.maxFraction)
    const naive = gridResults.find(r => r.caseId === c.id && r.disableGating)
    if (!def) continue
    const step = def.probe[0]
    const gateObs = step?.gateSize ?? (c.id.startsWith('and-not') ? 'n/a' : '?')
    console.log(
      c.id.padEnd(22),
      String(gateObs).padStart(5),
      String(step?.maxGateSize ?? '?').padStart(11),
      String(step?.selective ?? '?').padStart(17),
      def.p50.toFixed(2).padStart(10),
      naive ? naive.p50.toFixed(2).padStart(9) : 'n/a',
    )
  }

  console.log('\n--- Sweep: where selective flips (maxAbsolute × maxFraction) ---')
  for (const c of cases) {
    const rows = gridResults.filter(r => r.caseId === c.id && !r.disableGating)
    if (rows.length === 0) continue
    const baselineSelective = rows[0]?.probe[0]?.selective
    const flips = rows.filter(r => r.probe[0]?.selective !== baselineSelective)
    const selectiveCount = rows.filter(r => r.probe[0]?.selective).length
    console.log(`  ${c.id}: ${flips.length} flip(s) vs first grid point (baseline selective=${baselineSelective}), selective in ${selectiveCount}/${rows.length} grid points`)
  }

  console.log('\n--- Heuristic pick (match expectSelectiveAtDefault on synthetic cases) ---')
  let best = null
  for (const maxAbsolute of ABS_GRID) {
    for (const maxFraction of FRAC_GRID) {
      let score = 0
      let ms = 0
      for (const c of cases) {
        if (c.expectSelectiveAtDefault == null) continue
        const row = gridResults.find(r => r.caseId === c.id && r.maxAbsolute === maxAbsolute
          && r.maxFraction === maxFraction)
        if (!row) continue
        const selective = row.probe[0]?.selective ?? false
        if (selective === c.expectSelectiveAtDefault) score++
        ms += row.p50
      }
      if (!best || score > best.score || (score === best.score && ms < best.ms)) {
        best = { maxAbsolute, maxFraction, score, ms }
      }
    }
  }
  if (best) {
    console.log(`  best match: maxAbsolute=${best.maxAbsolute} maxFraction=${best.maxFraction}`
      + ` (score=${best.score}, sumP50=${best.ms.toFixed(2)}ms)`)
    console.log('  current defaults: maxAbsolute=5000 maxFraction=0.1')
  }
}

function main () {
  const cases = buildCases()

  console.log('AND gate tuning — sweep:', SWEEP, `(${ABS_GRID.length}×${FRAC_GRID.length}×${cases.length} cases, ${TIMED} timed)`)

  const gridResults = []

  for (const c of cases) {
    const frozen = c.build()
    const gateSize = c.gateSizeExpected ?? 0

    const naive = timeSearch(frozen, c.query, c.opts, undefined, c.docCount, gateSize, { disableGating: true })
    gridResults.push({
      caseId: c.id,
      maxAbsolute: null,
      maxFraction: null,
      disableGating: true,
      p50: naive.p50,
      probe: naive.probe,
      gateSizeExpected: c.gateSizeExpected,
      maxGateAtDefault: resolveGateMaxSize(c.docCount),
    })

    for (const maxAbsolute of ABS_GRID) {
      for (const maxFraction of FRAC_GRID) {
        const gateLimits = { maxAbsolute, maxFraction }
        const { p50, probe } = timeSearch(frozen, c.query, c.opts, gateLimits, c.docCount, gateSize)
        gridResults.push({
          caseId: c.id,
          maxAbsolute,
          maxFraction,
          disableGating: false,
          p50,
          probe,
          gateSizeExpected: c.gateSizeExpected,
          maxGateForLimits: resolveGateMaxSize(c.docCount, gateLimits),
        })
      }
    }
  }

  mkdirSync(dirname(OUT), { recursive: true })
  const payload = {
    capturedAt: new Date().toISOString(),
    sweep: SWEEP,
    timedIterations: TIMED,
    absGrid: ABS_GRID,
    fracGrid: FRAC_GRID,
    cases: cases.map(c => ({
      id: c.id,
      description: c.description,
      docCount: c.docCount,
      gateSizeExpected: c.gateSizeExpected,
      expectSelectiveAtDefault: c.expectSelectiveAtDefault,
      query: c.query,
      opts: c.opts,
    })),
    results: gridResults,
  }
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
  console.log('\nWrote', OUT)
  summarizeTrends(cases, gridResults)
}

main()
