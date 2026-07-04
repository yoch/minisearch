#!/usr/bin/env node
/**
 * Regenerate vs-reference docs from a baseline JSON:
 *   - benchmarks/VS_REFERENCE.md — full comparison table and metadata
 *   - README.md — short pointer to VS_REFERENCE.md (between HTML comment markers)
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
const VS_REFERENCE = join(root, 'benchmarks/VS_REFERENCE.md')
const DEFAULT_BASELINE = join(root, 'benchmarks/baselines/reference.json')

const START = '<!-- vs-reference:start'
const END = '<!-- vs-reference:end -->'

const argv = process.argv.slice(2)
const fromFlag = argv.find((a) => a.startsWith('--from='))
const baselinePath = fromFlag?.split('=')[1] ?? DEFAULT_BASELINE

const payload = JSON.parse(readFileSync(baselinePath, 'utf8'))

/** Scenarios shown in the public comparison table (order matters). */
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

/** Median bench timings for table cells (load/freeze). */
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

function captureMeta () {
  const captured = payload.capturedAt?.slice(0, 10) ?? '—'
  const node = payload.node ?? '—'
  const minisearch = payload.minisearchVersion ?? '—'
  const runs = payload.runs ?? '—'
  const commitShort = payload.baselineCommit?.slice(0, 7) ?? payload.git?.commitShort ?? '—'
  const baselineRel = baselinePath.replace(`${root}/`, '')
  const heapProto = payload.heapBenchProtocol?.version
  const heapNote = heapProto != null
    ? `Heap protocol v${heapProto} (isolated scenario processes, in-process trials, median+MAD; totalResident = heapUsed + external on both sides) — trend, not exact accounting. Index RAM column shows — for scenarios outside the heap allowlist.`
    : 'Heap is measured with one index alive and should be read as a trend, not exact accounting.'

  return { captured, node, minisearch, runs, commitShort, baselineRel, heapNote }
}

function buildVsReferenceDocument () {
  const { captured, node, minisearch, runs, commitShort, baselineRel, heapNote } = captureMeta()
  const { wins, total } = aggregateSearchWins()
  const heroes = HERO_IDS.map(scenarioById).filter(Boolean)
  const tableRows = heroes.map(heroRow).join('\n')
  const exactLine = divinaExactLine()

  return `# FrozenMiniSearch vs MiniSearch — reference benchmark

Generated by \`pnpm bench:readme\` from \`${baselineRel}\`.

Same corpora, same BM25-style queries, MiniSearch ${minisearch} as the reference.

| Scenario | Docs | Index RAM | Binary size | Load JSON | Load binary | Freeze import | Search p50 |
|----------|-----:|-----------|------------:|----------:|------------:|--------------:|-----------:|
${tableRows}

Load JSON = \`MiniSearch.loadJSON\` on the same \`toJSON\` snapshot. Load binary = \`loadBinarySync\` after \`saveBinarySync\`. Freeze import = one-time \`FrozenMiniSearch.fromJSON\` (not the hot reload path).

Across this full run, frozen is faster on **${wins}/${total}** search cases. ${exactLine ?? ''}

Numbers are from \`${baselineRel}\` @ \`${commitShort}\`, captured ${captured} on Node ${node}, ${runs} runs per scenario. ${heapNote}

See [benchmarks/README.md](README.md) for harness profiles, surfaces, and how to refresh this file (\`pnpm bench:reference:update\`).
`
}

function buildReadmePointer () {
  const { captured, minisearch, commitShort, baselineRel } = captureMeta()
  const { wins, total } = aggregateSearchWins()
  const divina = scenarioById('divina-storeFields')
  const ramSave = divina?.heapMb?.frozenVsMutableSavingPct ?? divina?.memoryMb?.frozenVsMutableSavingPct

  const ramTeaser = ramSave != null ? `~${Math.round(ramSave)}% less index RAM` : 'substantially less index RAM'
  const searchTeaser = `${wins}/${total} search cases`

  return `${START} — pnpm bench:readme -->
### Measured vs MiniSearch

On the main benchmark set vs MiniSearch ${minisearch}, frozen indexes use **${ramTeaser}** and win on **${searchTeaser}**.

Full comparison table, column definitions, and capture metadata: **[benchmarks/VS_REFERENCE.md](benchmarks/VS_REFERENCE.md)** (\`${baselineRel}\` @ \`${commitShort}\`, ${captured}).
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

const vsReferenceDoc = buildVsReferenceDocument()
const readmePointer = buildReadmePointer()

writeFileSync(VS_REFERENCE, vsReferenceDoc)
patchReadme(readmePointer)
console.log(`Updated ${VS_REFERENCE.replace(`${root}/`, '')}`)
console.log(`Updated README.md pointer from ${baselinePath.replace(`${root}/`, '')}`)
