/**
 * Binary save benchmarks: saveBinarySync vs saveBinaryAsync (size + wall-clock).
 *
 *   pnpm benchmark:binary-format
 */
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../dist/es/index.js'
import { frozenFromMiniSearch } from './harness/frozenSourceInternals'
import { CODEC_RAW, CODEC_ZSTD, MSV5_PAYLOAD_CODEC_OFFSET } from '../src/msv5/binaryMsv5Constants.ts'
import { gc } from './benchmarkUtils.js'
import { loadDivinaLines } from './loadDivinaLines.js'
import {
  denseNumericIds,
  highFrequencyTerms,
  largeDocuments,
  manyFields,
  sparseFields,
} from './benchmarkScenarios.js'

const SAVE_RUNS = 7
const SAVE_WARMUP = 2

interface Scenario {
  id: string
  corpus: Array<Record<string, unknown>>
  options: { fields: string[], storeFields?: string[] }
}

interface SaveResult {
  id: string
  payload: 'raw' | 'zstd'
  syncKiB: number
  asyncKiB: number
  byteDelta: number
  saveSyncMs: number
  saveAsyncMs: number
}

function median (values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function pct (base: number, value: number): number {
  if (base === 0) return 0
  return ((value - base) / base) * 100
}

function payloadKind (buf: Buffer): 'raw' | 'zstd' {
  const codec = buf.readUInt8(MSV5_PAYLOAD_CODEC_OFFSET)
  return codec === CODEC_ZSTD ? 'zstd' : codec === CODEC_RAW ? 'raw' : 'raw'
}

function benchSync (fn: () => void, runs = SAVE_RUNS, warmup = SAVE_WARMUP): number {
  for (let i = 0; i < warmup; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

async function benchAsync (
  fn: () => Promise<unknown>,
  runs = SAVE_RUNS,
  warmup = SAVE_WARMUP,
): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

function buildScenarios (): Scenario[] {
  const many = manyFields(2000, 10)
  const sparse = sparseFields(5000, 20)
  return [
    { id: 'divina', corpus: loadDivinaLines() as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'highFrequency-10k', corpus: highFrequencyTerms(10000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'largeDocs-500', corpus: largeDocuments(500, 3000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'denseNumeric-50k', corpus: denseNumericIds(50000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'denseNumeric-70k', corpus: denseNumericIds(70000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'manyFields-2k', corpus: many.docs as Array<Record<string, unknown>>, options: { fields: many.fields } },
    { id: 'sparseFields-5k', corpus: sparse.docs as Array<Record<string, unknown>>, options: { fields: sparse.fields } },
  ]
}

async function runScenario (scenario: Scenario): Promise<SaveResult> {
  const { corpus, options, id } = scenario

  const ms = new MiniSearch(options)
  ms.addAll(corpus)
  const frozen = frozenFromMiniSearch(FrozenMiniSearch, ms, options)

  const bufSync = frozen.saveBinarySync() as Buffer
  const saveSyncMs = benchSync(() => {
    frozen.saveBinarySync()
  })

  const bufAsync = await frozen.saveBinaryAsync()
  const saveAsyncMs = await benchAsync(async () => {
    await frozen.saveBinaryAsync()
  })

  return {
    id,
    payload: payloadKind(bufSync),
    syncKiB: bufSync.length / 1024,
    asyncKiB: bufAsync.length / 1024,
    byteDelta: Math.abs(bufSync.length - bufAsync.length),
    saveSyncMs,
    saveAsyncMs,
  }
}

function pad (s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

function printSaveSyncVsAsync (rows: SaveResult[]): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════')
  console.log('  SAVE — saveBinarySync vs saveBinaryAsync')
  console.log(`  median wall-clock, ${SAVE_RUNS} runs (+${SAVE_WARMUP} warmup)  |  baseline = sync`)
  console.log('═══════════════════════════════════════════════════════════════════════════════\n')

  console.log(
    pad('corpus', 22)
    + pad('pay', 6)
    + pad('sync KiB', 10)
    + pad('async KiB', 10)
    + pad('|Δ| B', 8)
    + pad('save sync', 11)
    + pad('save async', 11)
    + pad('async/sync', 12),
  )
  console.log('-'.repeat(90))

  for (const r of rows) {
    const ratio = r.saveSyncMs > 0 ? (r.saveAsyncMs / r.saveSyncMs).toFixed(2) + '×' : '—'
    const timePct = `${pct(r.saveSyncMs, r.saveAsyncMs) >= 0 ? '+' : ''}${pct(r.saveSyncMs, r.saveAsyncMs).toFixed(0)}%`
    console.log(
      pad(r.id, 22)
      + pad(r.payload, 6)
      + pad(r.syncKiB.toFixed(1), 10)
      + pad(r.asyncKiB.toFixed(1), 10)
      + pad(String(r.byteDelta), 8)
      + pad(`${r.saveSyncMs.toFixed(1)} ms`, 11)
      + pad(`${r.saveAsyncMs.toFixed(1)} ms`, 11)
      + pad(`${ratio} ${timePct}`, 12),
    )
  }

  const syncAvg = rows.reduce((s, r) => s + r.saveSyncMs, 0) / rows.length
  const asyncAvg = rows.reduce((s, r) => s + r.saveAsyncMs, 0) / rows.length
  console.log('-'.repeat(90))
  console.log(
    pad('moyenne', 22)
    + pad('', 6)
    + pad('', 10)
    + pad('', 10)
    + pad('', 8)
    + pad(`${syncAvg.toFixed(1)} ms`, 11)
    + pad(`${asyncAvg.toFixed(1)} ms`, 11)
    + pad(`${(asyncAvg / syncAvg).toFixed(2)}× ${pct(syncAvg, asyncAvg) >= 0 ? '+' : ''}${pct(syncAvg, asyncAvg).toFixed(0)}%`, 12),
  )

  const maxDelta = Math.max(...rows.map((r) => r.byteDelta))
  console.log(`\n  Max sync/async size delta: ${maxDelta} B (zstd may vary slightly; decompressed payload identical).`)
}

function printNotes (): void {
  console.log(`
Notes
─────
• saveBinarySync  — zstdCompressSync on the concatenated payload.
• saveBinaryAsync — zstd via async callback (same semantics; compressed size ± few bytes).
• Current format only (dense/sparse postings, radix columnar, adaptive field lengths).
`)
}

async function main (): Promise<void> {
  console.log('Binary format SAVE benchmark')
  console.log(`Node ${process.version}  ${new Date().toISOString()}`)

  const rows: SaveResult[] = []
  for (const scenario of buildScenarios()) {
    rows.push(await runScenario(scenario))
    gc()
  }

  printSaveSyncVsAsync(rows)
  printNotes()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
