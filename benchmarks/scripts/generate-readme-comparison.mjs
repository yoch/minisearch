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
  if (n < 0) return `~${Math.abs(n).toFixed(0)}% more`
  if (n === 0) return '0%'
  return `~${n.toFixed(0)}% less`
}

function fmtFaster (n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n < 0) return `~${Math.abs(n).toFixed(0)}% slower`
  if (n === 0) return '0%'
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

function fmtCount (n) {
  if (n == null || Number.isNaN(n)) return '—'
  return Number(n).toLocaleString('en-US')
}

function fmtPct (n) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${Number(n).toFixed(1)}%`
}

function fmtBytes (n) {
  if (n == null || Number.isNaN(n)) return '—'
  const bytes = Number(n)
  const compact = bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${bytes} B`
  return `${compact} (${fmtCount(bytes)} bytes)`
}

function fmtValue (value) {
  if (value == null) return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(fmtValue).join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return Number.isInteger(value) ? fmtCount(value) : String(value)
  return String(value)
}

function fmtList (values) {
  if (!values || values.length === 0) return '—'
  return values.map((value) => `\`${value}\``).join(', ')
}

function mdCell (value) {
  return String(value).replaceAll('\n', '<br>').replaceAll('|', '\\|')
}

function htmlEscape (value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
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
  const docs = fmtCount(scenario.documentCount)
  const heap = fmtHeapPair(scenario)
  const disk = fmtSaving(scenario.diskMb?.binaryVsJsonSavingPct)
  const loadJson = fmtBenchMs(scenario.loadMs?.json)
  const loadBinary = fmtBenchMs(scenario.loadMs?.binary)
  const freeze = fmtBenchMs(scenario.indexing?.freezeMs)
  const search = fmtFaster(searchGainPct(scenario))
  return `| [\`${scenario.id}\`](#${scenarioAnchor(scenario)}) | ${docs} | ${heap} | ${disk} | ${loadJson} | ${loadBinary} | ${freeze} | ${search} |`
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
  const head = `| ${headers.map(mdCell).join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  return `${head}\n${sep}\n${rows.join('\n')}\n`
}

function scenarioAnchor (scenario) {
  return `scenario-${scenario.id.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
}

function runContextTable (meta) {
  const searchProto = payload.searchBenchProtocol
  const heapProto = payload.heapBenchProtocol
  const rows = [
    ['Baseline', `\`${meta.baselineRel}\` @ \`${meta.commitShort}\``],
    ['Runtime', `Node ${meta.node}; MiniSearch ${meta.minisearch}; ${meta.runs} requested runs`],
    ['Surfaces', fmtList(payload.benchSurfaces)],
    ['Search protocol', searchProto ? `v${searchProto.protocolVersion}; paired hrtime; batch target ${searchProto.batchTargetMs} ms; ${searchProto.defaultIterations}/${searchProto.fastIterations} iterations` : '—'],
    ['Heap protocol', heapProto ? `v${heapProto.version}; ${heapProto.trials} trials; totalResident = heapUsed + external; isolated per scenario` : '—'],
  ].map(([metric, value]) => `| ${metric} | ${value} |`)
  return mdTable(['Context', 'Value'], rows)
}

function performanceTable (scenario) {
  const idx = scenario.indexing ?? {}
  const disk = scenario.diskMb ?? {}
  const load = scenario.loadMs ?? {}
  const heap = scenario.heapMb
  const heapText = scenario.heapSkipped
    ? `skipped (${scenario.heapSkipped})`
    : heap
      ? `${fmtNum(heap.frozenTotalResident, 2)} MB frozen vs ${fmtNum(heap.mutableTotalResident, 1)} MB mutable (${fmtSaving(heap.frozenVsMutableSavingPct)})`
      : '—'
  const rows = [
    ['Build mutable addAll', fmtBenchMs(idx.addAllMs), 'MiniSearch baseline build path'],
    ['Build frozen fromDocuments', fmtBenchMs(idx.fromDocumentsMs), 'Direct frozen build path'],
    ['Migrate toJSON → fromJSON', `${fmtBenchMs(idx.toJSONMs)} + ${fmtBenchMs(idx.freezeMs)}`, 'MiniSearch snapshot migration'],
    ['Save snapshot', `${fmtBenchMs(idx.jsonSerializeMs)} JSON / ${fmtBenchMs(idx.saveBinaryMs)} binary`, idx.binaryMagic ? `binary ${idx.binaryMagic}` : '—'],
    ['Snapshot size', `${fmtNum(disk.json, 3)} MB JSON / ${fmtNum(disk.binary, 3)} MB binary`, fmtSaving(disk.binaryVsJsonSavingPct)],
    ['Load snapshot', `${fmtBenchMs(load.json)} JSON / ${fmtBenchMs(load.binary)} binary`, fmtSaving(load.binaryVsJsonSavingPct).replace('more', 'slower')],
    ['Resident index RAM', heapText, heap?.frozenVsMutableHeapOnlySavingPct == null ? '—' : `heap-only ${fmtSaving(heap.frozenVsMutableHeapOnlySavingPct)}`],
  ].map(([metric, value, detail]) => `| ${metric} | ${value} | ${detail} |`)
  return mdTable(['Metric', 'Value', 'Detail'], rows)
}

function searchTable (scenario) {
  const rows = (scenario.search ?? []).map((row) =>
    `| ${row.label} | \`${row.query ?? '—'}\` | ${fmtMs(row.mutableP50)} | ${fmtMs(row.frozenP50)} | ${fmtMs(row.mutableP95)} | ${fmtMs(row.frozenP95)} | ${fmtNum(row.pairedRatioP50)} | ${fmtPct(row.frozenP50VsMutablePct)} | ${row.batchSize ?? '—'}×${row.searchIterations ?? '—'} | ${row.belowSearchFloor ? 'yes' : 'no'} |`,
  )
  return mdTable(
    ['Label', 'Query', 'Mutable p50', 'Frozen p50', 'Mutable p95', 'Frozen p95', 'Ratio p50', 'Frozen delta', 'Batch×iter', '<0.1ms'],
    rows,
  )
}

function searchLevelsTable (scenario) {
  const levels = scenario.searchLevels
  if (!levels || Object.keys(levels).length === 0) return '_Not measured._\n'
  const rows = []
  for (const [label, entry] of Object.entries(levels)) {
    const l0 = entry.L0
    const l1 = entry.L1
    const l2 = entry.L2
    rows.push(
      `| ${label} | \`${entry.term ?? '—'}\` | ${fmtMs(l0?.mutableP50)} → ${fmtMs(l0?.frozenP50)} | ${fmtMs(l1?.frozenP50)} | ${fmtMs(l2?.mutableP50)} → ${fmtMs(l2?.frozenP50)} | ${fmtNum(l2?.pairedRatioP50)} | ${fmtPct(l2?.frozenP50VsMutablePct)} | ${l2?.batchSize ?? l1?.batchSize ?? l0?.batchSize ?? '—'} |`,
    )
  }
  return mdTable(
    ['Query label', 'Term', 'L0 lookup p50', 'L1 frozen p50', 'L2 search p50', 'L2 ratio', 'L2 delta', 'Batch'],
    rows,
  )
}

function scoreDriftTable (scenario) {
  const rows = (scenario.scoreDrift ?? []).map((row) =>
    `| \`${row.query}\` | ${row.topK ?? '—'} | ${fmtNum(row.maxAbsScoreDelta, 4)} | ${fmtPct(row.maxRelScoreDeltaPct)} | ${row.missingInFrozenTopK ?? '—'} | ${row.topKOrderChanged ? 'yes' : 'no'} |`,
  )
  if (rows.length === 0) return ''
  return mdTable(['Query', 'topK', 'Max abs Δ', 'Max rel Δ', 'Missing in frozen topK', 'Order changed'], rows)
}

function memoryBreakdownTable (scenario) {
  const b = scenario.memoryBreakdown
  if (!b) return '_Not measured._\n'
  const postingsDetail = [
    b.postings?.layout,
    b.postings?.docIdWidth == null ? null : `${b.postings.docIdWidth}-bit doc ids`,
  ].filter(Boolean).join(', ') || '—'
  const docsDetail = [
    b.documents?.idLookupMode,
    b.documents?.storedFieldsJsonBytes ? `${fmtBytes(b.documents.storedFieldsJsonBytes)} stored fields` : null,
  ].filter(Boolean).join(', ') || '—'
  const rows = [
    ['Terms / docs', `${fmtCount(b.termCount)} terms / ${fmtCount(b.documentCount)} docs`, `nextId ${fmtCount(b.nextId)}`],
    ['Postings typed arrays', fmtBytes(b.postings?.totalTypedBytes), postingsDetail],
    ['Term index estimate', fmtBytes(b.termIndex?.estimatedBytes ?? b.radixTree?.estimatedBytes), `${fmtCount(b.termIndex?.nodeCount ?? b.radixTree?.mapNodeCount)} nodes`],
    ['Document metadata', fmtBytes((b.documents?.fieldLengthMatrixBytes ?? 0) + (b.documents?.storedFieldsJsonBytes ?? 0)), docsDetail],
    ['Estimated structured total', fmtBytes(b.estimatedStructuredBytes), 'postings + term index + document metadata'],
  ].filter(([, , value]) => value !== '—')
    .map(([area, metric, value]) => `| ${area} | ${metric} | ${value} |`)
  return mdTable(['Area', 'Size / count', 'Detail'], rows)
}

function scenarioConfigTable (scenario) {
  const capped = scenario.benchmarkRuns
    ? `${fmtValue(scenario.benchmarkRuns.effective)}/${fmtValue(scenario.benchmarkRuns.requested)} runs (${scenario.benchmarkRuns.reason})`
    : null
  const heap = scenario.heapSkipped ? `heap skipped: ${scenario.heapSkipped}` : null
  const rows = [
    ['Corpus', `${fmtCount(scenario.documentCount)} docs; fields ${fmtList(scenario.fields)}; storeFields ${fmtList(scenario.storeFields)}`],
    ['Measurement notes', [capped, heap].filter(Boolean).join('; ') || 'standard run'],
  ].map(([metric, value]) => `| ${metric} | ${value} |`)
  return mdTable(['Property', 'Value'], rows)
}

function diagnosticsBlock (scenario) {
  const drift = scoreDriftTable(scenario)
  return `<details>
<summary>Diagnostics</summary>

#### Search-level breakdown

${searchLevelsTable(scenario)}
${drift ? `#### Score drift\n\n${drift}\n` : ''}#### Memory structure

${memoryBreakdownTable(scenario)}
</details>
`
}

function scenarioSummaryLine (scenario) {
  return [
    `${fmtCount(scenario.documentCount)} docs`,
    `${fmtSaving(scenario.summary?.heapFrozenVsMutableSavingPct)} RAM`,
    `${fmtSaving(scenario.summary?.diskBinaryVsJsonSavingPct)} binary`,
    `${fmtFaster(scenario.summary?.searchFrozenP50AvgGainPct)} search p50`,
  ].filter((part) => !part.includes('—')).join(' · ')
}

function scenarioSection (scenario) {
  const anchor = scenarioAnchor(scenario)
  const summary = htmlEscape(scenarioSummaryLine(scenario))
  return `<a id="${anchor}"></a>
<details>
<summary><strong>${htmlEscape(scenario.name)}</strong> (<code>${htmlEscape(scenario.id)}</code>) · ${summary}</summary>

### At a glance

${scenarioConfigTable(scenario)}
### Performance

${performanceTable(scenario)}
### Search

${searchTable(scenario)}

${diagnosticsBlock(scenario)}
</details>
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
  const meta = captureMeta()
  const { captured, node, minisearch, packageVersion, runs, commitShort, baselineRel, heapNote } = meta
  const { wins, total } = aggregateSearchWins()
  const allSummaryRows = payload.scenarios.map(summaryRow).join('\n')
  const scenarioSections = payload.scenarios.map(scenarioSection).join('\n---\n\n')

  return `# FrozenMiniSearch vs MiniSearch — detailed reference benchmark

Generated by \`pnpm bench:readme\` from \`${baselineRel}\`.

Package **${packageVersion}** · MiniSearch **${minisearch}** · captured **${captured}** on Node **${node}** · **${runs}** runs per scenario · baseline commit \`${commitShort}\`.

Across this full run, frozen wins on **${wins}/${total}** search cases. ${heapNote}

## How to read this

- The summary table links to one collapsible section per scenario.
- \`Index RAM\` is total resident index memory when heap data is available: \`heapUsed + external\`.
- \`Load JSON\` is \`MiniSearch.loadJSON\` from the same \`toJSON\` snapshot. \`Load binary\` is \`FrozenMiniSearch.loadBinarySync\` after \`saveBinarySync\`.
- \`Freeze import\` is the one-time \`FrozenMiniSearch.fromJSON\` migration path, not the hot binary reload path.
- Detailed search tables use \`Frozen p50 delta\`: negative means frozen was faster/lower, positive means frozen was slower/higher.
- \`Below floor\` marks sub-0.1 ms probe rows where percentage ratios are noisier than absolute timings.
- Search levels are benchmark-only internals: L0 = term-index lookup, L1 = frozen \`executeQuery\`, L2 = full paired \`search()\`.

## Run context

${runContextTable(meta)}

## Summary — all scenarios

| Scenario | Docs | Index RAM | Binary size | Load JSON | Load binary | Freeze import | Search p50 |
|----------|-----:|-----------|------------:|----------:|------------:|--------------:|-----------:|
${allSummaryRows}

---

## Scenario details

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
