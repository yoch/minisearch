/**
 * Compare MiniSearch (mutable) vs FrozenMiniSearch — human-readable report.
 * JSON metrics: pnpm benchmark:record | pnpm benchmark:diff
 *
 * Run: pnpm benchmark:compare
 * Requires: pnpm build && node --expose-gc
 */
import { buildBenchmarkScenarios, runBenchmarkSuite } from './benchmarkSuite.js'
import { parseBenchmarkArgs, loadBenchmarkPayload, argValue, formatFrozenVsMutableDelta } from './benchmarkUtils.js'

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2)

const pct = (base, value) => {
  if (base === 0) return '—'
  const delta = ((value - base) / base) * 100
  const sign = delta <= 0 ? '' : '+'
  return `${sign}${delta.toFixed(1)}%`
}

function printTable (rows) {
  const col = (s, w) => String(s).padEnd(w)
  const w = [28, 14, 14, 14, 12]
  console.log(col('Scenario', w[0]) + col('Heap (MB)', w[1]) + col('Disk (MB)', w[2]) + col('Load (ms)', w[3]) + col('vs mutable', w[4]))
  console.log('-'.repeat(w.reduce((a, b) => a + b, 0)))
  for (const r of rows) {
    console.log(
      col(r.label, w[0]) +
      col(r.heapMb ?? '—', w[1]) +
      col(r.diskMb ?? '—', w[2]) +
      col(r.loadMs != null ? r.loadMs.toFixed(1) : '—', w[3]) +
      col(r.vsMutable ?? '—', w[4])
    )
  }
}

function printMemoryBreakdown (b) {
  console.log('\nMemory breakdown (FrozenMiniSearch, estimated structured bytes):')
  console.log(`  terms: ${b.termCount}, docs: ${b.documentCount}, nextId slots: ${b.nextId}`)
  console.log(`  postings typed arrays: ${mb(b.postings.totalTypedBytes)} MB  (docIds ${mb(b.postings.allDocIdsBytes)}, freqs ${mb(b.postings.allFreqsBytes)})`)
  console.log(`  packed term index (${b.termIndex.nodeCount} nodes, ${b.termIndex.edgeCount} edges): ~${mb(b.termIndex.estimatedBytes)} MB`)
  console.log(`  stored fields (JSON est.): ${mb(b.documents.storedFieldsJsonBytes)} MB`)
  console.log(`  field length matrix: ${mb(b.documents.fieldLengthMatrixBytes)} MB`)
  console.log(`  id lookup: ${b.documents.idLookupMode} (map entries: ${b.documents.idToShortIdEntries})`)
  if (b.postings.layout != null) {
    console.log(`  postings layout: ${b.postings.layout}, docId width: ${b.postings.docIdWidth} bits`)
  }
  console.log(`  total structured estimate: ${mb(b.estimatedStructuredBytes)} MB`)
}

function printScenario (data) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`Profile: ${data.name}`)
  console.log(`  documents: ${data.documentCount}, fields: [${data.fields.join(', ')}], storeFields: [${data.storeFields.join(', ') || '(none)'}]`)
  if (data.benchSurfaces) {
    console.log(`  surfaces: [${data.benchSurfaces.join(', ')}]`)
  }
  console.log('='.repeat(72))

  if (data.memoryBreakdown) printMemoryBreakdown(data.memoryBreakdown)

  if (data.indexing) {
    console.log('\nIndexing:')
    if (data.indexing.addAllMs != null) console.log(`  addAll:         ${data.indexing.addAllMs.toFixed(1)} ms`)
    if (data.indexing.toJSONMs != null) console.log(`  toJSON:         ${data.indexing.toJSONMs.toFixed(1)} ms  (snapshot export)`)
    if (data.indexing.freezeMs != null) console.log(`  freeze (import): ${data.indexing.freezeMs.toFixed(1)} ms  (internal snapshot import)`)
    if (data.indexing.jsonSerializeMs != null) console.log(`  JSON.stringify: ${data.indexing.jsonSerializeMs.toFixed(1)} ms`)
    if (data.indexing.saveBinaryMs != null) {
      console.log(`  saveBinary:     ${data.indexing.saveBinaryMs.toFixed(1)} ms  (format ${data.indexing.binaryMagic})`)
    }
  }

  if (data.heapMb && data.diskMb) {
    const baseTotal = data.heapMb.mutableTotalResident ?? data.memoryMb?.mutable?.totalResidentApprox ?? data.heapMb.mutable
    const frozenTotal = data.heapMb.frozenTotalResident ?? data.memoryMb?.frozen?.totalResidentApprox ?? data.heapMb.frozen
    printTable([
      { label: 'Mutable MiniSearch', heapMb: baseTotal.toFixed(2), diskMb: data.diskMb.json?.toFixed(2), loadMs: data.loadMs?.json, vsMutable: 'baseline' },
      { label: 'FrozenMiniSearch', heapMb: frozenTotal.toFixed(2), diskMb: data.diskMb.binary?.toFixed(2), loadMs: null, vsMutable: pct(baseTotal, frozenTotal) },
      { label: 'loadJSON → MiniSearch', heapMb: data.heapMb.loadJson?.toFixed(2), diskMb: data.diskMb.json?.toFixed(2), loadMs: data.loadMs?.json, vsMutable: data.heapMb.loadJson != null ? pct(baseTotal, data.heapMb.loadJson) : '—' },
      { label: 'loadBinary → Frozen', heapMb: data.heapMb.loadBinary?.toFixed(2), diskMb: data.diskMb.binary?.toFixed(2), loadMs: data.loadMs?.binary, vsMutable: data.heapMb.loadBinary != null ? pct(baseTotal, data.heapMb.loadBinary) : '—' }
    ])
  }

  if (data.loadMs?.json != null && data.loadMs?.binary != null) {
    console.log('\nCold load:')
    console.log(`  loadJSON:   ${data.loadMs.json.toFixed(1)} ms`)
    console.log(`  loadBinary: ${data.loadMs.binary.toFixed(1)} ms  (${pct(data.loadMs.json, data.loadMs.binary)} vs loadJSON)`)
  }

  if (data.search) printSearchTable(data)

  if (data.summary && Object.keys(data.summary).length > 0) {
    console.log('\nProfile summary:')
    if (data.summary.heapFrozenVsMutableSavingPct != null) {
      console.log(`  RAM frozen vs mutable (isolated totalResident):  ${data.summary.heapFrozenVsMutableSavingPct.toFixed(1)}% smaller`)
    }
    if (data.summary.diskBinaryVsJsonSavingPct != null) {
      console.log(`  Disk binary vs JSON:               ${data.summary.diskBinaryVsJsonSavingPct.toFixed(1)}% smaller`)
    }
    if (data.summary.loadBinaryVsJsonSavingPct != null) {
      console.log(`  Cold load binary vs JSON:          ${data.summary.loadBinaryVsJsonSavingPct.toFixed(1)}% faster`)
    }
    if (data.summary.searchFrozenP50AvgGainPct != null) {
      console.log(`  Search p50 (avg across queries):   ${data.summary.searchFrozenP50AvgGainPct.toFixed(1)}% faster on frozen`)
    }
  }

  if (data.scoreDrift && data.scoreDrift.length > 0) {
    console.log('\nScore drift (mutable vs frozen):')
    for (const row of data.scoreDrift) {
      console.log(`  ${row.query}: max Δ=${row.maxAbsScoreDelta} (rel ${row.maxRelScoreDeltaPct}%), missing topK=${row.missingInFrozenTopK}, orderChanged=${row.topKOrderChanged}`)
    }
  }
}

function printSearchTable (data) {
  console.log('\nSearch p50 / p95 (ms, paired hrtime):\n')
  console.log(
    'Query'.padEnd(12) +
    'Mutable p50'.padEnd(14) +
    'Frozen p50'.padEnd(14) +
    'Δ p50'.padEnd(12) +
    'Ratio p50'.padEnd(10) +
    'Mutable p95'.padEnd(14) +
    'Frozen p95',
  )
  console.log('-'.repeat(88))
  for (const row of data.search) {
    const ratio = row.pairedRatioP50 != null ? row.pairedRatioP50.toFixed(3) : '—'
    console.log(
      row.label.padEnd(12) +
      row.mutableP50.toFixed(3).padEnd(14) +
      row.frozenP50.toFixed(3).padEnd(14) +
      formatFrozenVsMutableDelta(row.mutableP50, row.frozenP50).padEnd(12) +
      ratio.padEnd(10) +
      row.mutableP95.toFixed(3).padEnd(14) +
      row.frozenP95.toFixed(3),
    )
  }

  if (data.searchLevels && Object.keys(data.searchLevels).length > 0) {
    console.log('\nSearch levels (L0 lookup, L1 executeQuery frozen, L2 search paired):\n')
    for (const [label, lv] of Object.entries(data.searchLevels)) {
      console.log(`  ${label} [term=${lv.term}]`)
      console.log(
        `    L0 lookup   mut ${lv.L0.mutableP50.toFixed(4)} ms  frz ${lv.L0.frozenP50.toFixed(4)} ms  `
        + `ratio ${lv.L0.pairedRatioP50?.toFixed(3) ?? '—'}`,
      )
      console.log(`    L1 execute  frz ${lv.L1.frozenP50.toFixed(4)} ms`)
      console.log(
        `    L2 search   mut ${lv.L2.mutableP50.toFixed(4)} ms  frz ${lv.L2.frozenP50.toFixed(4)} ms  `
        + `ratio ${lv.L2.pairedRatioP50?.toFixed(3) ?? '—'}`,
      )
    }
  }
}

const { runs, searchIterations, surfaces } = parseBenchmarkArgs()
const fromPath = argValue('--from')

console.log('=== MiniSearch vs FrozenMiniSearch (isolated measurements) ===\n')

let scenarios
if (fromPath) {
  const payload = loadBenchmarkPayload(fromPath)
  scenarios = payload.scenarios
  console.log(`From file: ${fromPath}`)
  console.log(`  captured: ${payload.capturedAt} @ ${payload.git?.commitShort}`)
  console.log(`  runs: ${payload.runs ?? 1}, search iterations: ${payload.searchIterations ?? '(legacy)'}\n`)
} else {
  if (!global.gc) {
    console.log('Tip: run with --expose-gc for accurate heap numbers.\n')
  }
  console.log(`${runs} run(s)/scenario, ${searchIterations} search iterations (median)\n`)
  scenarios = runBenchmarkSuite(buildBenchmarkScenarios(), runs, { surfaces })
}

for (const result of scenarios) {
  printScenario(result)
}

console.log('\n' + '='.repeat(72))
console.log('JSON baselines')
console.log('='.repeat(72))
console.log('• pnpm benchmark:record            → benchmarks/baselines/latest.json')
console.log('• pnpm benchmark:diff              → latest.json vs reference (no re-run)')
console.log('• pnpm benchmark:compare --from …  → report from saved JSON')
console.log('• pnpm bench:reference:update      → refresh reference + README table')
console.log('='.repeat(72))
console.log('Notes')
console.log('='.repeat(72))
console.log('• Heap is measured with one index alive; use --expose-gc for stable numbers.')
console.log('• Memory breakdown estimates structured data; V8 object overhead is additional.')
console.log('• saveBinarySync writes a zstd-compressed binary snapshot; loadBinarySync/Async read the current format only.')
console.log('• Production: fromDocuments / fromJSON → saveBinarySync → loadBinarySync.\n')
