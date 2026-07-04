#!/usr/bin/env node
/**
 * Regenerate the vs-reference comparison block in README.md from a baseline JSON.
 *
 *   node benchmarks/scripts/generate-readme-comparison.mjs
 *   node benchmarks/scripts/generate-readme-comparison.mjs --from=benchmarks/baselines/latest.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatFrozenVsMutableDelta } from '../searchBenchTiming.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const README = join(root, 'README.md')
const DEFAULT_BASELINE = join(root, 'benchmarks/baselines/reference.json')

const START = '<!-- vs-reference:start'
const END = '<!-- vs-reference:end -->'

const argv = process.argv.slice(2)
const fromFlag = argv.find((a) => a.startsWith('--from='))
const baselinePath = fromFlag?.split('=')[1] ?? DEFAULT_BASELINE

const payload = JSON.parse(readFileSync(baselinePath, 'utf8'))

/** Scenarios shown in the public README table (order matters). */
const HERO_IDS = [
  'divina-storeFields',
  'divina-indexOnly',
  'extreme-giantVocabulary',
  'denseNumericIds-100k',
  'genericStringIds-100k',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
]

const HERO_LABELS = {
  'divina-storeFields': 'Divina, with stored text',
  'divina-indexOnly': 'Divina, index only',
  'extreme-giantVocabulary': 'Giant vocabulary (50k terms)',
  'denseNumericIds-100k': 'Dense numeric ids',
  'genericStringIds-100k': 'Generic string ids',
  'docIdUint16Boundary-65535': 'Uint16 doc id boundary',
  'docIdUint16Boundary-65536': 'Uint32 doc id boundary',
}

/** `frozenVsMutableSavingPct` etc. — positive = frozen wins (smaller/faster). */
function fmtSaving (n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n <= 0) return `${n.toFixed(0)}%`
  return `~${n.toFixed(0)}% less`
}

function fmtFaster (n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n <= 0) return `${n.toFixed(0)}%`
  return `~${n.toFixed(0)}% faster`
}

function fmtMs (n, digits = 2) {
  if (n == null) return '—'
  if (n < 0.001) return `${(n * 1e6).toFixed(0)} ns`
  if (n < 0.1) return `${(n * 1000).toFixed(1)} µs`
  if (n < 10) return `${n.toFixed(digits)} ms`
  return `${n.toFixed(1)} ms`
}

/** Median bench timings for README table cells (load/freeze). */
function fmtBenchMs (n) {
  if (n == null) return '—'
  if (n < 10) return `${n.toFixed(1)} ms`
  return `${Math.round(n)} ms`
}

function fmtHeapPair (scenario) {
  const mut = scenario.heapMb?.mutableTotalResident ?? scenario.memoryMb?.mutable?.totalResidentApprox
  const frz = scenario.heapMb?.frozenTotalResident ?? scenario.memoryMb?.frozen?.totalResidentApprox
  const save = scenario.heapMb?.frozenVsMutableSavingPct
  if (mut == null || frz == null) return '—'
  return `${frz.toFixed(2)} vs ${mut.toFixed(1)} MB (~${save?.toFixed(0) ?? '—'}% less)`
}

function scenarioById (id) {
  return payload.scenarios.find((s) => s.id === id)
}

function searchGainPct (scenario) {
  return scenario?.summary?.searchFrozenP50AvgGainPct
}

function heroLabel (scenario) {
  return HERO_LABELS[scenario.id]
    ?? scenario.name.replace(/^Divina Commedia — /, 'Divina ').replace(/^Extreme — /, '')
}

function heroRow (scenario) {
  const docs = scenario.documentCount?.toLocaleString('en-US') ?? '—'
  const heap = fmtHeapPair(scenario)
  const disk = fmtSaving(scenario.diskMb?.binaryVsJsonSavingPct)
  const loadJson = fmtBenchMs(scenario.loadMs?.json)
  const loadBinary = fmtBenchMs(scenario.loadMs?.binary)
  const freeze = fmtBenchMs(scenario.indexing?.freezeMs)
  const search = fmtFaster(searchGainPct(scenario))
  return `| ${heroLabel(scenario)} | ${docs} | ${heap} | ${disk} | ${loadJson} | ${loadBinary} | ${freeze} | ${search} |`
}

function divinaExactLine () {
  const s = scenarioById('divina-storeFields')
  const ex = s?.search?.find((r) => r.label === 'exact')
  if (!ex) return null
  const delta = formatFrozenVsMutableDelta(ex.mutableP50, ex.frozenP50)
  const ratio = ex.pairedRatioP50?.toFixed(2) ?? '—'
  return `Divina \`inferno\` (exact, paired p50): mutable ${fmtMs(ex.mutableP50)} → frozen ${fmtMs(ex.frozenP50)} (**${delta}**, ratio ${ratio}).`
}

function aggregateSearchWins () {
  let wins = 0
  let total = 0
  for (const s of payload.scenarios) {
    for (const row of s.search ?? []) {
      total++
      if (row.pairedRatioP50 != null && row.pairedRatioP50 < 1) wins++
      else if (row.pairedRatioP50 == null && row.frozenP50 < row.mutableP50) wins++
    }
  }
  return { wins, total }
}

function buildBlock () {
  const captured = payload.capturedAt?.slice(0, 10) ?? '—'
  const node = payload.node ?? '—'
  const minisearch = payload.minisearchVersion ?? '—'
  const runs = payload.runs ?? '—'
  const commitShort = payload.baselineCommit?.slice(0, 7) ?? payload.git?.commitShort ?? '—'
  const { wins, total } = aggregateSearchWins()

  const heroes = HERO_IDS.map(scenarioById).filter(Boolean)
  const tableRows = heroes.map(heroRow).join('\n')
  const exactLine = divinaExactLine()

  const heapProto = payload.heapBenchProtocol?.version
  const heapNote = heapProto != null
    ? `Heap protocol v${heapProto} (isolated scenario processes, in-process trials, median+MAD; totalResident = heapUsed + external on both sides) — trend, not exact accounting.`
    : 'Heap is measured with one index alive and should be read as a trend, not exact accounting.'

  return `${START} — pnpm bench:readme -->
### Measured vs MiniSearch

Same corpora, same BM25-style queries, MiniSearch ${minisearch} as the reference.

| Scenario | Docs | Index RAM | Binary size | Load JSON | Load binary | Freeze import | Search p50 |
|----------|-----:|-----------|------------:|----------:|------------:|--------------:|-----------:|
${tableRows}

Load JSON = \`MiniSearch.loadJSON\` on the same \`toJSON\` snapshot. Load binary = \`loadBinarySync\` after \`saveBinarySync\`. Freeze import = one-time \`FrozenMiniSearch.fromJSON\` (not the hot reload path).

Across this full run, frozen is faster on **${wins}/${total}** search cases. ${exactLine ?? ''}

Numbers are from \`${baselinePath.replace(`${root}/`, '')}\` @ \`${commitShort}\`, captured ${captured} on Node ${node}, ${runs} runs per scenario. ${heapNote}
${END}`
}

function patchReadme (block) {
  const readme = readFileSync(README, 'utf8')
  const startIdx = readme.indexOf(START)
  const endIdx = readme.indexOf(END)

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README.md missing ${START} … ${END} markers`)
  }

  const before = readme.slice(0, startIdx)
  const after = readme.slice(endIdx + END.length)
  writeFileSync(README, `${before}${block}${after}`)
}

const block = buildBlock()
patchReadme(block)
console.log(`Updated README.md comparison from ${baselinePath}`)
