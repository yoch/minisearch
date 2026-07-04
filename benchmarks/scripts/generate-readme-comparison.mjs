#!/usr/bin/env node
/**
 * Regenerate vs-reference docs from a baseline JSON:
 *   - README.md — hero summary table (between HTML comment markers)
 *   - benchmarks/VS_REFERENCE.md — full detailed report (all scenarios, all surfaces)
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

function fmtBenchMs (n) {
  if (n == null) return '—'
  if (n < 10) return `${n.toFixed(1)} ms`
  return `${Math.round(n)} ms`
}

function fmtNum (n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—'
  return Number(n).toFixed(digits)
}

function fmtPct (n) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${Number(n).toFixed(1)}%`
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

function summaryRow (scenario) {
  const docs = scenario.documentCount?.toLocaleString('en-US') ?? '—'
  const heap = fmtHeapPair(scenario)
  const disk = fmtSaving(scenario.diskMb?.binaryVsJsonSavingPct)
  const loadJson = fmtBenchMs(scenario.loadMs?.json)
  const loadBinary = fmtBenchMs(scenario.loadMs?.binary)
  const freeze = fmtBenchMs(scenario.indexing?.freezeMs)
  const search = fmtFaster(searchGainPct(scenario))
  return `| \`${scenario.id}\` | ${docs} | ${heap} | ${disk} | ${loadJson} | ${loadBinary} | ${freeze} | ${search} |`
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
  const packageVersion = payload.packageVersion ?? '—'
  const runs = payload.runs ?? '—'
  const commitShort = payload.baselineCommit?.slice(0, 7) ?? payload.git?.commitShort ?? '—'
  const baselineRel = baselinePath.replace(`${root}/`, '')
  const heapProto = payload.heapBenchProtocol?.version
  const heapNote = heapProto != null
    ? `Heap protocol v${heapProto} (isolated scenario processes, in-process trials, median+MAD; totalResident = heapUsed + external on both sides) — trend, not exact accounting. Index RAM column shows — for scenarios outside the heap allowlist.`
    : 'Heap is measured with one index alive and should be read as a trend, not exact accounting.'

  return { captured, node, minisearch, packageVersion, runs, commitShort, baselineRel, heapNote }
}

function mdTable (headers, rows) {
  if (rows.length === 0) return '_No data._\n'
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  return `${head}\n${sep}\n${rows.join('\n')}\n`
}

function indexingTable (scenario) {
  const idx = scenario.indexing
  if (!idx) return '_Not measured._\n'
  const rows = []
  const metrics = [
    ['addAll', idx.addAllMs],
    ['fromDocuments', idx.fromDocumentsMs],
    ['toJSON (migrate)', idx.toJSONMs],
    ['freeze import (fromJSON)', idx.freezeMs],
    ['JSON serialize (save)', idx.jsonSerializeMs],
    ['saveBinary', idx.saveBinaryMs],
  ]
  for (const [label, ms] of metrics) {
    if (ms != null) rows.push(`| ${label} | ${fmtBenchMs(ms)} |`)
  }
  if (idx.binaryMagic) rows.push(`| binary magic | ${idx.binaryMagic} |`)
  return mdTable(['Metric', 'Time'], rows)
}

function diskTable (scenario) {
  const disk = scenario.diskMb
  if (!disk) return '_Not measured._\n'
  return mdTable(['Format', 'Size', 'vs JSON'], [
    `| JSON snapshot | ${fmtNum(disk.json, 3)} MB | — |`,
    `| Binary snapshot | ${fmtNum(disk.binary, 3)} MB | ${fmtSaving(disk.binaryVsJsonSavingPct)} |`,
  ])
}

function loadTable (scenario) {
  const load = scenario.loadMs
  if (!load) return '_Not measured._\n'
  return mdTable(['Path', 'Time', 'vs JSON load'], [
    `| MiniSearch.loadJSON | ${fmtBenchMs(load.json)} | — |`,
    `| FrozenMiniSearch.loadBinarySync | ${fmtBenchMs(load.binary)} | ${fmtSaving(load.binaryVsJsonSavingPct)} |`,
  ])
}

function heapTable (scenario) {
  if (scenario.heapSkipped) {
    return `_Heap skipped (${scenario.heapSkipped})._\n`
  }
  const heap = scenario.heapMb
  const mem = scenario.memoryMb
  if (!heap && !mem) return '_Not measured._\n'
  const rows = []
  if (heap) {
    rows.push(
      `| Mutable total resident | ${fmtNum(heap.mutableTotalResident, 3)} MB | heap ${fmtNum(heap.mutable, 3)} MB |`,
      `| Frozen total resident | ${fmtNum(heap.frozenTotalResident, 3)} MB | heap ${fmtNum(heap.frozen, 3)} MB |`,
      `| Frozen vs mutable saving | ${fmtPct(heap.frozenVsMutableSavingPct)} | heap-only ${fmtPct(heap.frozenVsMutableHeapOnlySavingPct)} |`,
    )
  }
  if (mem?.mutable && mem?.frozen) {
    rows.push(
      `| Mutable external | ${fmtNum(mem.mutable.external, 3)} MB | arrayBuffers ${fmtNum(mem.mutable.arrayBuffers, 3)} MB |`,
      `| Frozen external | ${fmtNum(mem.frozen.external, 3)} MB | arrayBuffers ${fmtNum(mem.frozen.arrayBuffers, 3)} MB |`,
    )
  }
  const stab = scenario.heapStability
  if (stab) {
    rows.push(
      `| MAD (mutable total) | ${fmtNum(stab.mutableTotalResidentMadMb, 3)} MB | frozen ${fmtNum(stab.frozenTotalResidentMadMb, 3)} MB |`,
    )
  }
  return mdTable(['Metric', 'Value', 'Detail'], rows)
}

function searchTable (scenario) {
  const rows = (scenario.search ?? []).map((row) =>
    `| ${row.label} | \`${row.query ?? '—'}\` | ${row.batchSize ?? '—'} | ${row.searchIterations ?? '—'} | ${fmtMs(row.mutableP50)} | ${fmtMs(row.frozenP50)} | ${fmtMs(row.mutableP95)} | ${fmtMs(row.frozenP95)} | ${fmtNum(row.pairedRatioP50)} | ${fmtPct(row.frozenP50VsMutablePct)} |`,
  )
  return mdTable(
    ['Label', 'Query', 'Batch', 'Iter', 'Mutable p50', 'Frozen p50', 'Mutable p95', 'Frozen p95', 'Ratio p50', 'Frozen gain'],
    rows,
  )
}

function searchLevelsTable (scenario) {
  const levels = scenario.searchLevels
  if (!levels || Object.keys(levels).length === 0) return '_Not measured._\n'
  const rows = []
  for (const [label, entry] of Object.entries(levels)) {
    for (const level of ['L0', 'L1', 'L2']) {
      const row = entry[level]
      if (!row) continue
      rows.push(
        `| ${label} | ${level} | ${fmtMs(row.mutableP50)} | ${fmtMs(row.frozenP50)} | ${fmtMs(row.mutableP95)} | ${fmtMs(row.frozenP95)} | ${fmtNum(row.pairedRatioP50)} | ${fmtPct(row.frozenP50VsMutablePct)} | ${row.batchSize ?? '—'} |`,
      )
    }
  }
  return mdTable(
    ['Query label', 'Level', 'Mutable p50', 'Frozen p50', 'Mutable p95', 'Frozen p95', 'Ratio p50', 'Frozen gain', 'Batch'],
    rows,
  )
}

function scoreDriftTable (scenario) {
  const rows = (scenario.scoreDrift ?? []).map((row) =>
    `| \`${row.query}\` | ${row.topK ?? '—'} | ${fmtNum(row.maxAbsScoreDelta, 4)} | ${fmtPct(row.maxRelScoreDeltaPct)} | ${row.missingInFrozenTopK ?? '—'} | ${row.topKOrderChanged ? 'yes' : 'no'} |`,
  )
  if (rows.length === 0) return '_Not measured._\n'
  return mdTable(['Query', 'topK', 'Max abs Δ', 'Max rel Δ', 'Missing in frozen topK', 'Order changed'], rows)
}

function summaryMetricsTable (scenario) {
  const s = scenario.summary ?? {}
  const rows = [
    ['Disk binary vs JSON', fmtSaving(s.diskBinaryVsJsonSavingPct)],
    ['Load binary vs JSON', fmtSaving(s.loadBinaryVsJsonSavingPct)],
    ['Search frozen p50 avg gain', fmtFaster(s.searchFrozenP50AvgGainPct)],
    ['Heap frozen vs mutable saving', fmtSaving(s.heapFrozenVsMutableSavingPct)],
  ].map(([metric, value]) => `| ${metric} | ${value} |`)
  return mdTable(['Summary metric', 'Value'], rows)
}

function memoryBreakdownTable (scenario) {
  const b = scenario.memoryBreakdown
  if (!b) return '_Not measured._\n'
  const rows = [
    ['Terms', String(b.termCount ?? '—')],
    ['Documents', String(b.documentCount ?? '—')],
    ['nextId', String(b.nextId ?? '—')],
    ['Postings typed bytes', String(b.postings?.totalTypedBytes ?? '—')],
    ['Term index estimated bytes', String(b.termIndex?.estimatedBytes ?? '—')],
    ['Stored fields JSON bytes', String(b.documents?.storedFieldsJsonBytes ?? '—')],
    ['Estimated structured bytes', String(b.estimatedStructuredBytes ?? '—')],
  ].map(([metric, value]) => `| ${metric} | ${value} |`)
  return mdTable(['Breakdown', 'Value'], rows)
}

function scenarioSection (scenario) {
  const fields = scenario.fields?.join(', ') || '—'
  const store = scenario.storeFields?.length ? scenario.storeFields.join(', ') : '—'
  return `## ${scenario.name} (\`${scenario.id}\`)

${scenario.documentCount?.toLocaleString('en-US') ?? '—'} documents · fields: ${fields} · storeFields: ${store}

### Summary

${summaryMetricsTable(scenario)}
### Indexing & migrate

${indexingTable(scenario)}
### Disk

${diskTable(scenario)}
### Load

${loadTable(scenario)}
### Memory / heap

${heapTable(scenario)}
### Search

${searchTable(scenario)}
### Search levels

${searchLevelsTable(scenario)}
### Score drift

${scoreDriftTable(scenario)}
### Structured memory breakdown

${memoryBreakdownTable(scenario)}
`
}

function buildReadmeBlock () {
  const { captured, node, minisearch, runs, commitShort, baselineRel, heapNote } = captureMeta()
  const { wins, total } = aggregateSearchWins()
  const heroes = HERO_IDS.map(scenarioById).filter(Boolean)
  const tableRows = heroes.map(heroRow).join('\n')
  const exactLine = divinaExactLine()

  return `${START} — pnpm bench:readme -->
### Measured vs MiniSearch

Same corpora, same BM25-style queries, MiniSearch ${minisearch} as the reference.

| Scenario | Docs | Index RAM | Binary size | Load JSON | Load binary | Freeze import | Search p50 |
|----------|-----:|-----------|------------:|----------:|------------:|--------------:|-----------:|
${tableRows}

Load JSON = \`MiniSearch.loadJSON\` on the same \`toJSON\` snapshot. Load binary = \`loadBinarySync\` after \`saveBinarySync\`. Freeze import = one-time \`FrozenMiniSearch.fromJSON\` (not the hot reload path).

Across this full run, frozen is faster on **${wins}/${total}** search cases. ${exactLine ?? ''}

Numbers are from \`${baselineRel}\` @ \`${commitShort}\`, captured ${captured} on Node ${node}, ${runs} runs per scenario. ${heapNote}

Detailed tables for all ${payload.scenarios.length} scenarios (search, load, migrate, heap, drift, …): **[benchmarks/VS_REFERENCE.md](benchmarks/VS_REFERENCE.md)**.
${END}`
}

function buildDetailedReferenceDocument () {
  const { captured, node, minisearch, packageVersion, runs, commitShort, baselineRel, heapNote } = captureMeta()
  const { wins, total } = aggregateSearchWins()
  const allSummaryRows = payload.scenarios.map(summaryRow).join('\n')
  const scenarioSections = payload.scenarios.map(scenarioSection).join('\n---\n\n')

  return `# FrozenMiniSearch vs MiniSearch — detailed reference benchmark

Generated by \`pnpm bench:readme\` from \`${baselineRel}\`.

Package **${packageVersion}** · MiniSearch **${minisearch}** · captured **${captured}** on Node **${node}** · **${runs}** runs per scenario · baseline commit \`${commitShort}\`.

Across this full run, frozen wins on **${wins}/${total}** search cases. ${heapNote}

## Summary — all scenarios

| Scenario | Docs | Index RAM | Binary size | Load JSON | Load binary | Freeze import | Search p50 |
|----------|-----:|-----------|------------:|----------:|------------:|--------------:|-----------:|
${allSummaryRows}

---

${scenarioSections}
See [benchmarks/README.md](README.md) for harness profiles, surfaces, and how to refresh this file (\`pnpm bench:reference:update\`).
`
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

const readmeBlock = buildReadmeBlock()
const detailedDoc = buildDetailedReferenceDocument()

writeFileSync(VS_REFERENCE, detailedDoc)
patchReadme(readmeBlock)
console.log(`Updated ${VS_REFERENCE.replace(`${root}/`, '')}`)
console.log(`Updated README.md summary table from ${baselinePath.replace(`${root}/`, '')}`)
