import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SearchableMap, { packSearchableMap } from '../testSupport/upstreamSearchableMap.js'
import { packedPrefixEntries } from '../testSupport/packedRadixStringIterators.js'
import { corpora } from './packedRadixCorpora.js'
import { loadMedicamentsCorpus } from './medicamentsIndexes.js'
import { collectRunMetadata, median } from './benchmarkUtils.js'
import { discoverPrefixProbes, countPrefixEntries } from './packedRadixEmitProbes.js'

const WARMUP = 5
const RUNS = 40

const BASELINES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'baselines')
const LATEST_PATH = join(BASELINES_DIR, 'packed-emit-latest.json')

function buildTree (entries) {
  const map = SearchableMap.from(entries)
  return packSearchableMap(map)
}

/**
 * Median duration over RUNS iterations for one scenario (after WARMUP).
 */
function benchScenario (tree, exec) {
  const times = []
  for (let round = 0; round < WARMUP + RUNS; round++) {
    const t0 = performance.now()
    exec()
    if (round >= WARMUP) times.push(performance.now() - t0)
  }
  return { medianMs: median(times), runs: RUNS }
}

function benchCorpus (tree, scenarioList) {
  const scenarios = [
    {
      id: 'entries-full',
      terms: tree.size,
      exec: () => {
        Array.from(tree.entries())
      },
    },
    ...scenarioList.map(({ id, prefix }) => {
      const terms = countPrefixEntries(tree, prefix)
      return {
        id,
        prefix,
        terms,
        exec: () => {
          Array.from(packedPrefixEntries(tree, prefix))
        },
      }
    }),
  ]

  const row = {}
  for (const { id, terms, prefix, exec } of scenarios) {
    const { medianMs } = benchScenario(tree, exec)
    row[id] = {
      medianMs,
      terms,
      ...(prefix != null ? { prefix } : {}),
      nsPerTerm: terms > 0 ? (medianMs * 1e6) / terms : null,
    }
  }
  return row
}

function logCorpus (corpusId, discovered, row) {
  console.log(`\n${corpusId} (terms=${discovered.treeSize})`)
  console.log(
    `  discovered: short="${discovered.prefixShort}" (${discovered.shortTerms})`
    + ` wide="${discovered.prefixWide}" (${discovered.wideTerms})`,
  )
  console.log(`  entries-full: ${row['entries-full'].medianMs.toFixed(3)} ms`)
  const wide = row['prefix-discovered-wide']
  if (wide != null) {
    console.log(`  prefix-discovered-wide: ${wide.medianMs.toFixed(3)} ms (${wide.terms} terms)`)
  }
  const mid = row['mid-edge-prefix']
  if (mid != null) {
    console.log(`  mid-edge-prefix: ${mid.medianMs.toFixed(3)} ms (${mid.terms} terms)`)
  }
}

function benchSyntheticCorpus ({ corpusId, entries, probeOptions, extraScenarios = [] }) {
  const tree = buildTree(entries)
  const discovered = discoverPrefixProbes(tree, probeOptions)
  const scenarioList = [
    { id: 'prefix-discovered-short', prefix: discovered.prefixShort },
    { id: 'prefix-discovered-wide', prefix: discovered.prefixWide },
    ...extraScenarios,
  ]
  return {
    corpusId,
    discovered: { ...discovered, treeSize: tree.size },
    timings: benchCorpus(tree, scenarioList),
  }
}

async function main () {
  const writeBaseline = process.argv.includes('--baseline')
  const payload = {
    metadata: {
      ...collectRunMetadata(),
      warmup: WARMUP,
      runs: RUNS,
      note: 'Production emitSubtree (explicit stack + prefix strings).',
    },
    corpora: {},
  }

  const results = []

  const syntheticDefs = [
    {
      corpusId: 'scale',
      entries: corpora.find((c) => c.id === 'scale')?.entries,
      probeOptions: { wideTarget: 400, minWideMatches: 20 },
    },
    {
      corpusId: 'prefix-suffix-5k',
      entries: corpora.find((c) => c.id === 'prefix-suffix-5k')?.entries,
      probeOptions: { wideTarget: 1000 },
    },
    {
      corpusId: 'mid-edge',
      entries: [['acquire', 3]],
      probeOptions: { wideTarget: 1, minWideMatches: 1 },
      extraScenarios: [{ id: 'mid-edge-prefix', prefix: 'acq' }],
    },
  ]

  for (const def of syntheticDefs) {
    if (def.entries == null) continue
    results.push(benchSyntheticCorpus(def))
  }

  const medicamentDefs = [
    { corpusId: 'bdpm-presentations', wideTarget: 2500, minWideMatches: 200 },
    { corpusId: 'bdpm-specialites', wideTarget: 1500, minWideMatches: 200 },
  ]

  for (const { corpusId, wideTarget, minWideMatches } of medicamentDefs) {
    try {
      const med = loadMedicamentsCorpus(corpusId)
      const discovered = discoverPrefixProbes(med.tree, { wideTarget, minWideMatches })
      results.push({
        corpusId,
        discovered: { ...discovered, treeSize: med.tree.size },
        timings: benchCorpus(med.tree, [
          { id: 'prefix-discovered-short', prefix: discovered.prefixShort },
          { id: 'prefix-discovered-wide', prefix: discovered.prefixWide },
        ]),
      })
    } catch (err) {
      console.warn(`skip ${corpusId}: ${err.message}`)
    }
  }

  for (const r of results) {
    logCorpus(r.corpusId, r.discovered, r.timings)
    payload.corpora[r.corpusId] = {
      discovered: r.discovered,
      timings: r.timings,
    }
  }

  if (writeBaseline) {
    mkdirSync(BASELINES_DIR, { recursive: true })
    writeFileSync(LATEST_PATH, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`\nWrote ${LATEST_PATH}`)
  }
}

const isMain = process.argv[1]?.endsWith('packedRadixEmitSubtree.cjs')
  || process.argv[1]?.endsWith('packedRadixEmitSubtree.js')

if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export { buildTree, benchCorpus, discoverPrefixProbes, countPrefixEntries }
