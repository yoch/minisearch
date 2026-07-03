import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_SURFACES, surfacesFromEnv, hasStructuralSurfaces, isCpuOnlySurfaces } from './framework/surfaces.mjs'
import {
  DEFAULT_HEAP_GC_PASSES,
  DEFAULT_HEAP_TRIALS,
  DEFAULT_HEAP_TRIALS_FAST,
  DEFAULT_HEAP_WARMUP,
  HEAP_WARMUP_CAP,
  madMbRound,
  median,
  medianRound,
} from './benchStats.js'

export { hasStructuralSurfaces, isCpuOnlySurfaces }

function findRepoRoot () {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))]
  for (const start of starts) {
    let dir = start
    for (;;) {
      if (existsSync(join(dir, 'package.json'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

const REPO_ROOT = findRepoRoot()

export const gc = () => { if (global.gc) global.gc() }

/** Run `passes` explicit GC cycles (requires `node --expose-gc`). */
export function forceGc (passes = 1, { strict = false } = {}) {
  if (typeof global.gc !== 'function') {
    if (strict) {
      throw new Error('forceGc: run Node with --expose-gc')
    }
    return
  }
  for (let i = 0; i < passes; i++) global.gc()
}

export function memorySnapshot () {
  const u = process.memoryUsage()
  return {
    heapUsed: u.heapUsed,
    external: u.external,
    arrayBuffers: u.arrayBuffers,
    rss: u.rss
  }
}

export function mb (bytes) {
  return bytes / 1024 / 1024
}

export function mbRound (bytes, digits = 3) {
  return Number(mb(bytes).toFixed(digits))
}

/** Percent change from base to value (negative = improvement when lower is better). */
function pctDelta (base, value) {
  if (base === 0) return null
  return ((value - base) / base) * 100
}

export function pctDeltaRound (base, value, digits = 1) {
  const d = pctDelta(base, value)
  return d == null ? null : Number(d.toFixed(digits))
}

/**
 * Tracks max `heapUsed` and `heapUsed + external` above a post-gc baseline while a build runs.
 * Use for transient peak during `add` / `freezeParams` (not retained heap after gc).
 */
export function createPeakHeapSampler () {
  gc()
  const baseline = process.memoryUsage()
  const baselineHeap = baseline.heapUsed
  const baselineExternal = baseline.external
  const baselineTotalResident = baselineHeap + baselineExternal
  const baselineRss = baseline.rss
  let peakHeap = baselineHeap
  let peakExternal = baselineExternal
  let peakTotalResident = baselineTotalResident
  let peakRss = baselineRss

  return {
    sample () {
      const u = process.memoryUsage()
      if (u.heapUsed > peakHeap) peakHeap = u.heapUsed
      if (u.external > peakExternal) peakExternal = u.external
      const totalResident = u.heapUsed + u.external
      if (totalResident > peakTotalResident) peakTotalResident = totalResident
      if (u.rss > peakRss) peakRss = u.rss
    },
    peakHeapMb () {
      return mbRound(peakHeap - baselineHeap)
    },
    peakTotalResidentMb () {
      return mbRound(peakTotalResident - baselineTotalResident)
    },
    finish (value) {
      return {
        value,
        baselineHeapMb: mbRound(baselineHeap),
        peakHeapMb: mbRound(peakHeap - baselineHeap),
        peakHeapBytes: peakHeap - baselineHeap,
        peakExternalMb: mbRound(peakExternal - baselineExternal),
        peakExternalBytes: peakExternal - baselineExternal,
        peakTotalResidentMb: mbRound(peakTotalResident - baselineTotalResident),
        peakTotalResidentBytes: peakTotalResident - baselineTotalResident,
        peakRssMb: mbRound(peakRss),
        peakRssDeltaMb: mbRound(peakRss - baselineRss),
      }
    },
  }
}

export function measureHeap (fn, { gcPasses = 1 } = {}) {
  return measureRetainedHeap(fn, { gcPasses })
}

function heapDeltaFromSnapshots (before, after) {
  const delta = (key) => Math.max(0, after[key] - before[key])
  const heapBytesDelta = delta('heapUsed')
  const externalBytes = delta('external')
  const arrayBuffersBytes = delta('arrayBuffers')
  const rssBytes = delta('rss')
  return {
    heapMb: mbRound(heapBytesDelta),
    heapBytes: heapBytesDelta,
    externalMb: mbRound(externalBytes),
    externalBytes,
    arrayBuffersMb: mbRound(arrayBuffersBytes),
    arrayBuffersBytes,
    rssMb: mbRound(rssBytes),
    rssBytes,
    totalResidentApproxMb: mbRound(heapBytesDelta + externalBytes),
    totalResidentApproxBytes: heapBytesDelta + externalBytes,
  }
}

export function measureRetainedHeap (fn, { gcPasses = 1 } = {}) {
  forceGc(gcPasses)
  const before = memorySnapshot()
  const value = fn()
  forceGc(gcPasses)
  const after = memorySnapshot()
  return {
    value,
    ...heapDeltaFromSnapshots(before, after),
  }
}

export function medianOf (values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export {
  DEFAULT_HEAP_GC_PASSES,
  DEFAULT_HEAP_TRIALS,
  DEFAULT_HEAP_TRIALS_FAST,
  DEFAULT_HEAP_WARMUP,
  HEAP_WARMUP_CAP,
  madMbRound,
  median,
  medianRound,
}

export function medianTimed (fn, iters) {
  const samples = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

export function medianMeasureHeap (fn, runs = 1, { gcPasses = 1 } = {}) {
  if (runs <= 1) return measureRetainedHeap(fn, { gcPasses })
  const samples = []
  let lastValue
  for (let i = 0; i < runs; i++) {
    const sample = measureRetainedHeap(fn, { gcPasses })
    lastValue = sample.value
    samples.push(sample)
  }
  const pick = (key) => medianOf(samples.map((s) => s[key]))
  return {
    value: lastValue,
    heapMb: mbRound(pick('heapBytes')),
    heapBytes: pick('heapBytes'),
    externalMb: mbRound(pick('externalBytes')),
    externalBytes: pick('externalBytes'),
    arrayBuffersMb: mbRound(pick('arrayBuffersBytes')),
    arrayBuffersBytes: pick('arrayBuffersBytes'),
    rssMb: mbRound(pick('rssBytes')),
    rssBytes: pick('rssBytes'),
    totalResidentApproxMb: mbRound(pick('totalResidentApproxBytes')),
    totalResidentApproxBytes: pick('totalResidentApproxBytes'),
  }
}

export function aggregateHeapSamples (samples) {
  const pickMedian = (key) => medianOf(samples.map((s) => s[key]))
  const heapBytes = pickMedian('heapBytes')
  const externalBytes = pickMedian('externalBytes')
  const arrayBuffersBytes = pickMedian('arrayBuffersBytes')
  const rssBytes = pickMedian('rssBytes')
  const totalResidentApproxBytes = pickMedian('totalResidentApproxBytes')
  return {
    heapMb: mbRound(heapBytes),
    heapBytes,
    externalMb: mbRound(externalBytes),
    externalBytes,
    arrayBuffersMb: mbRound(arrayBuffersBytes),
    arrayBuffersBytes,
    rssMb: mbRound(rssBytes),
    rssBytes,
    totalResidentApproxMb: mbRound(totalResidentApproxBytes),
    totalResidentApproxBytes,
    heapMadMb: madMbRound(samples.map((s) => s.heapBytes)),
    externalMadMb: madMbRound(samples.map((s) => s.externalBytes)),
    totalResidentMadMb: madMbRound(samples.map((s) => s.totalResidentApproxBytes)),
    samples: samples.map((s) => ({
      heapMb: s.heapMb,
      externalMb: s.externalMb,
      totalResidentApproxMb: s.totalResidentApproxMb,
    })),
  }
}

export function defaultHeapTrials ({ reference = false } = {}) {
  const fromEnv = Number(process.env.BENCH_HEAP_TRIALS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return reference ? DEFAULT_HEAP_TRIALS : DEFAULT_HEAP_TRIALS_FAST
}

export function defaultHeapGcPasses () {
  const fromEnv = Number(process.env.BENCH_HEAP_GC_PASSES)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return DEFAULT_HEAP_GC_PASSES
}

export function defaultHeapWarmup () {
  const fromEnv = Number(process.env.BENCH_HEAP_WARMUP)
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.floor(fromEnv)
  return DEFAULT_HEAP_WARMUP
}

/** Routine defaults: median of 3 scenario runs; per-query iterations from calibration (20 / 50 if probe &lt; 0.1 ms). */
export const DEFAULT_BENCHMARK_RUNS = 3
export const DEFAULT_SEARCH_ITERATIONS = 20

export function defaultBenchmarkRuns () {
  const fromEnv = Number(process.env.RUNS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return DEFAULT_BENCHMARK_RUNS
}

export function defaultSearchIterations () {
  const fromEnv = Number(process.env.SEARCH_ITERATIONS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return DEFAULT_SEARCH_ITERATIONS
}

export function parseRunsArg (args = process.argv) {
  let runs = defaultBenchmarkRuns()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--runs') {
      const next = Number(args[i + 1])
      if (Number.isFinite(next) && next > 0) runs = Math.floor(next)
    } else if (arg.startsWith('--runs=')) {
      const next = Number(arg.split('=')[1])
      if (Number.isFinite(next) && next > 0) runs = Math.floor(next)
    }
  }
  return runs
}

export function parseSearchIterationsArg (args = process.argv) {
  let iterations = defaultSearchIterations()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--iterations') {
      const next = Number(args[i + 1])
      if (Number.isFinite(next) && next > 0) iterations = Math.floor(next)
    } else if (arg.startsWith('--iterations=')) {
      const next = Number(arg.split('=')[1])
      if (Number.isFinite(next) && next > 0) iterations = Math.floor(next)
    }
  }
  return iterations
}

export function parseBenchSurfaces (args = process.argv) {
  const fromEnv = surfacesFromEnv(process.env.BENCH_SURFACES)
  if (fromEnv) return fromEnv
  if (args.includes('--search-only')) return ['search']
  const env = process.env.BENCH_SEARCH_ONLY
  if (env === '1' || env === 'true' || env === 'yes') return ['search']
  return [...ALL_SURFACES]
}

export function parseBenchmarkArgs (args = process.argv) {
  const surfaces = parseBenchSurfaces(args)
  return {
    runs: parseRunsArg(args),
    searchIterations: parseSearchIterationsArg(args),
    surfaces,
  }
}

export function loadBenchmarkPayload (path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function argValue (flag, args = process.argv) {
  const eq = args.find((a) => a.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const i = args.indexOf(flag)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return null
}

export {
  benchSearch,
  benchSearchPaired,
  benchTimedSamples,
  benchPairedSearchSamples,
  formatFrozenVsMutableDelta,
  frozenVsMutablePct,
  searchIterationsForBatchEntry,
} from './searchBenchTiming.js'

export function timedMs (fn) {
  const t0 = performance.now()
  const result = fn()
  return { result, ms: performance.now() - t0 }
}

function gitCommand (args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', cwd: REPO_ROOT }).trim()
  } catch {
    return null
  }
}

/** Modified tracked files only (untracked files ignored). */
function trackedTreePorcelain () {
  return gitCommand('status --porcelain --untracked-files=no') ?? ''
}

/**
 * Refuse baseline capture when tracked files differ from HEAD.
 * @param {{ force?: boolean, context?: string }} [options]
 */
export function assertCleanTrackedTree (options = {}) {
  const { force = false, context = 'baseline' } = options
  if (force) return
  const dirty = trackedTreePorcelain()
  if (!dirty) return
  console.error(`Rejected: tracked tree is not clean (${context}).`)
  console.error('Modifications on tracked files:')
  for (const line of dirty.split('\n')) {
    if (line) console.error(`  ${line}`)
  }
  console.error('\nCommit or restore these files, then retry.')
  console.error('To force anyway: add --force (baseline not reproducible at HEAD commit).')
  process.exit(1)
}

/** Git fields stored with a golden baseline (commit = measured code state). */
export function enrichGitForBaseline (git) {
  const commit = git?.commit ?? gitCommand('rev-parse HEAD')
  return {
    ...git,
    commit,
    commitShort: git?.commitShort ?? gitCommand('rev-parse --short HEAD'),
    branch: git?.branch ?? gitCommand('rev-parse --abbrev-ref HEAD'),
    dirty: false,
    commitDate: gitCommand('log -1 --format=%cI'),
    subject: gitCommand('log -1 --format=%s'),
    parentCommit: gitCommand('rev-parse HEAD^'),
  }
}

const PACKED_RADIX_HISTORY_PATH = join(REPO_ROOT, 'benchmarks/packed-radix-history.jsonl')

/** Compact row for packed-radix-history.jsonl. */
export function packedRadixHistoryEntry (payload) {
  const corpora = {}
  for (const [id, row] of Object.entries(payload.corpora ?? {})) {
    const summary = {
      structuredBytes: row.bytes?.totalStructuredBytes,
      packedByteLength: row.bytes?.packedByteLength,
      edgeCount: row.edgeCount,
      runtimeApproxBytes: row.runtime?.totalResidentApproxBytes,
    }
    if (row.timings?.['get(hit)']?.hz != null) {
      summary.getHitHz = Math.round(row.timings['get(hit)'].hz)
      summary.prefixShortHz = Math.round(row.timings['prefix(short)']?.hz ?? 0)
    }
    corpora[id] = summary
  }
  return {
    protocolVersion: 1,
    recordKind: payload.metadata?.recordKind ?? 'clean-commit',
    capturedAt: payload.metadata?.capturedAt,
    packageVersion: payload.metadata?.packageVersion,
    git: payload.metadata?.git,
    baselineCommit: payload.metadata?.baselineCommit ?? payload.metadata?.git?.commit,
    suiteFingerprint: Object.keys(corpora),
    corpora,
  }
}

/**
 * Append one packed-radix snapshot (clean tree required unless force).
 * @returns {'appended' | 'skipped-duplicate'}
 */
export function appendPackedRadixHistory (payload, options = {}) {
  const {
    historyPath = PACKED_RADIX_HISTORY_PATH,
    force = false,
  } = options
  const entry = packedRadixHistoryEntry(payload)
  const headSha = entry.baselineCommit
  if (!headSha) {
    console.warn('appendPackedRadixHistory: no commit, history not written')
    return 'skipped-duplicate'
  }

  if (existsSync(historyPath) && !force) {
    for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e.baselineCommit === headSha || e.git?.commit === headSha) {
          console.log(`History: already recorded for ${e.git?.commitShort ?? headSha.slice(0, 7)}`)
          return 'skipped-duplicate'
        }
      } catch { /* ignore */ }
    }
  }

  if (force && existsSync(historyPath)) {
    const kept = readFileSync(historyPath, 'utf8').split('\n').filter((line) => {
      if (!line.trim()) return false
      try {
        const e = JSON.parse(line)
        return e.baselineCommit !== headSha && e.git?.commit !== headSha
      } catch {
        return true
      }
    })
    writeFileSync(historyPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
  }

  appendFileSync(historyPath, `${JSON.stringify(entry)}\n`)
  return 'appended'
}

function readInstalledPackageVersion (name) {
  try {
    const pkgPath = join(REPO_ROOT, 'node_modules', name, 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version
  } catch {
    return null
  }
}

export function collectRunMetadata () {
  let version = null
  try {
    version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
  } catch { /* ignore */ }

  const trackedDirty = trackedTreePorcelain() !== ''
  const allDirty = gitCommand('status --porcelain') !== ''

  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    packageVersion: version,
    minisearchVersion: readInstalledPackageVersion('minisearch'),
    gcExposed: typeof global.gc === 'function',
    git: {
      commit: gitCommand('rev-parse HEAD'),
      commitShort: gitCommand('rev-parse --short HEAD'),
      branch: gitCommand('rev-parse --abbrev-ref HEAD'),
      dirty: allDirty,
      trackedDirty,
    }
  }
}
