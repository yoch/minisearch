import Benchmark from 'benchmark'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SearchableMap, { packSearchableMap } from '../testSupport/upstreamSearchableMap.js'
import { packedPrefixEntries } from '../testSupport/packedRadixStringIterators.js'
import { corpora } from './packedRadixCorpora.js'
import { fuzzyCasesFromProbe } from './packedRadixFuzzyCases.js'
import {
  loadMedicamentsCorpora,
  loadPackedTreeFromMsbin,
  MEDICAMENTS_INDEX_SPECS,
  printMedicamentsAnalysis,
} from './medicamentsIndexes.js'
import {
  appendPackedRadixHistory,
  assertCleanTrackedTree,
  collectRunMetadata,
  enrichGitForBaseline,
  medianMeasureHeap,
} from './benchmarkUtils.js'

// The bench is run as the rollup-compiled CJS under benchmarks/dist/, so the
// versioned baselines live one level up (benchmarks/baselines).
const BASELINES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'baselines')
const REFERENCE_PATH = join(BASELINES_DIR, 'packed-radix-reference.json')
const LATEST_PATH = join(BASELINES_DIR, 'packed-radix-latest.json')

/** CPU smoke only — structured bytes remain the primary metric. */
const BENCH_OPTS = { minSamples: 12, minTime: 0.15 }
const HEAP_RUNS = 3

import { measureStructuredBytes } from './packedRadixMetrics.js'

function buildTree (entries) {
  const map = SearchableMap.from(entries)
  return packSearchableMap(map)
}

/** Incremental heap after GC (--expose-gc): TypedArrays often show up in external/arrayBuffers. */
function measureRuntimeHeap (entries) {
  const sample = medianMeasureHeap(() => buildTree(entries), HEAP_RUNS)
  return {
    tree: sample.value,
    runtime: {
      runs: HEAP_RUNS,
      heapBytes: sample.heapBytes,
      externalBytes: sample.externalBytes,
      arrayBuffersBytes: sample.arrayBuffersBytes,
      rssBytes: sample.rssBytes,
      totalResidentApproxBytes: sample.totalResidentApproxBytes,
    },
  }
}

function runCpuSmoke (tree, probes) {
  const suite = new Benchmark.Suite('cpu-smoke')
  suite
    .add('get(hit)', () => { tree.get(probes.getHit) }, BENCH_OPTS)
    .add('get(miss)', () => { tree.get(probes.getMiss) }, BENCH_OPTS)
    .add('prefix(short)', () => { Array.from(packedPrefixEntries(tree, probes.prefixShort)) }, BENCH_OPTS)

  for (const { label, query, maxDistance } of fuzzyCasesFromProbe(probes.fuzzyQuery)) {
    suite.add(label, () => {
      Array.from(tree.fuzzyRefs(query, maxDistance))
        .map(({ termIndex, distance }) => [tree.termByIndex(termIndex), termIndex, distance])
    }, BENCH_OPTS)
  }

  return new Promise((resolve) => {
    suite.on('complete', function onComplete () {
      const timings = {}
      this.forEach((bench) => {
        timings[bench.name] = { hz: bench.hz, meanMs: bench.stats.mean * 1000 }
      })
      resolve(timings)
    })
    suite.run()
  })
}

function logCorpusLine (id, tree, bytes, runtime, timings) {
  console.log(
    `${id}: terms=${tree.size} nodes=${tree.nodeCount} edges=${tree.edgeCount}`
    + ` structured=${bytes.totalStructuredBytes}B`
    + (runtime != null
      ? ` runtime≈${runtime.totalResidentApproxBytes}B`
        + ` (heap=${runtime.heapBytes} ext=${runtime.externalBytes} ab=${runtime.arrayBuffersBytes})`
      : ''),
  )
  if (timings != null) {
    for (const [name, t] of Object.entries(timings)) {
      console.log(`  ${name}: ${t.hz.toFixed(0)} ops/s`)
    }
  }
}

async function runCorpus (corpus) {
  const { tree, runtime } = measureRuntimeHeap(corpus.entries)
  const bytes = measureStructuredBytes(tree)
  const timings = corpus.benchCpu ? await runCpuSmoke(tree, corpus.probes) : null
  logCorpusLine(corpus.id, tree, bytes, runtime, timings)

  return {
    size: tree.size,
    nodeCount: tree.nodeCount,
    edgeCount: tree.edgeCount,
    bytes,
    runtime,
    timings,
    ...(corpus.meta != null ? { meta: corpus.meta } : {}),
  }
}

async function runMedicamentsCorpus (med) {
  const spec = MEDICAMENTS_INDEX_SPECS.find((s) => s.id === med.id)
  let runtime = null
  if (spec) {
    const sample = medianMeasureHeap(() => loadPackedTreeFromMsbin(spec.file), HEAP_RUNS)
    runtime = {
      runs: HEAP_RUNS,
      heapBytes: sample.heapBytes,
      externalBytes: sample.externalBytes,
      arrayBuffersBytes: sample.arrayBuffersBytes,
      rssBytes: sample.rssBytes,
      totalResidentApproxBytes: sample.totalResidentApproxBytes,
    }
  }
  const bytes = measureStructuredBytes(med.tree)
  const timings = med.benchCpu ? await runCpuSmoke(med.tree, med.probes) : null
  logCorpusLine(med.id, med.tree, bytes, runtime, timings)

  return {
    size: med.tree.size,
    nodeCount: med.tree.nodeCount,
    edgeCount: med.tree.edgeCount,
    bytes,
    runtime,
    timings,
    meta: med.meta,
  }
}

async function main () {
  // --reference: write the versioned golden (clean tree required unless --force).
  // --record:    write the local latest.json scratch (no clean-tree guard).
  // neither:     run and print only.
  const writeReference = process.argv.includes('--reference')
  const writeLatest = process.argv.includes('--record')
  const force = process.argv.includes('--force')
  const payload = { metadata: collectRunMetadata(), corpora: {} }

  const gcNote = payload.metadata.gcExposed ? '' : ' (warn: run with --expose-gc for reliable runtime heap)'
  console.log(`PackedRadixTree bench (structured bytes + runtime heap median/${HEAP_RUNS})${gcNote}`)

  for (const corpus of corpora) {
    payload.corpora[corpus.id] = await runCorpus(corpus)
  }

  const medicaments = loadMedicamentsCorpora({ withMap: false })
  printMedicamentsAnalysis(medicaments)
  for (const med of medicaments) {
    payload.corpora[med.id] = await runMedicamentsCorpus(med)
  }

  if (writeReference) {
    assertCleanTrackedTree({ force, context: 'packed-radix reference' })

    const git = force
      ? { ...payload.metadata.git, dirty: true }
      : enrichGitForBaseline(payload.metadata.git)

    payload.metadata = {
      ...payload.metadata,
      recordKind: force ? 'forced-dirty' : 'clean-commit',
      role: 'golden',
      baselineCommit: git.commit,
      git,
    }

    mkdirSync(BASELINES_DIR, { recursive: true })
    writeFileSync(REFERENCE_PATH, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`\nWrote ${REFERENCE_PATH}`)
    console.log(`  baselineCommit: ${git.commit}`)
    console.log(`  ${git.commitShort} — ${git.subject ?? '(no subject)'}`)

    const hist = appendPackedRadixHistory(payload, { force })
    if (hist === 'appended') {
      console.log('  historique → benchmarks/packed-radix-history.jsonl')
    }
  } else if (writeLatest) {
    payload.metadata = { ...payload.metadata, recordKind: 'local-latest' }
    mkdirSync(BASELINES_DIR, { recursive: true })
    writeFileSync(LATEST_PATH, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`\nWrote ${LATEST_PATH}`)
  }
}

const isPackedRadixBenchMain = process.argv[1]?.endsWith('packedRadixTree.cjs')
  || process.argv[1]?.endsWith('packedRadixTree.js')

if (isPackedRadixBenchMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
