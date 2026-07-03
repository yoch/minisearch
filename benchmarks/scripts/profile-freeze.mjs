/**
 * Break down freeze import (freezeMs) cost by phase.
 * Bench freezeMs times the internal snapshot import helper on a pre-built snapshot (toJSON excluded).
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-freeze.mjs
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-freeze.mjs --scenario=dense
 */
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  buildFrozenAssembleParamsFromMiniSearchSnapshot,
  parseSnapshotIndex,
} from '../../src/fromMiniSearch.ts'
import { frozenFromMiniSearchSnapshot } from '../harness/frozenSourceInternals.ts'
import { packTermsFromList } from '../../src/PackedRadixTree/packTermList.ts'
import { validateFrozenTermIndexLeaves } from '../../src/frozenTermIndex.ts'
import SearchableMap, { packSearchableMap } from '../../testSupport/upstreamSearchableMap.js'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { intArg, timed } from './cpuBenchUtils.mjs'

function argValue(name) {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === `--${name}`) return process.argv[i + 1]
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

const SCENARIOS = {
  overflow: 'extreme-overflowFrequency',
  highFrequency: 'extreme-highFrequency',
  dense: 'denseNumericIds-100k',
  docId: 'docIdUint16Boundary-65536',
  giant: 'extreme-giantVocabulary',
}

const scenarioKey = argValue('scenario') ?? 'overflow'
const warmup = intArg('warmup', 3, { min: 0 })
const iterations = intArg('iterations', 25)

function main() {
  const scenarioId = SCENARIOS[scenarioKey]
  if (scenarioId == null) {
    console.error(`Unknown scenario=${scenarioKey}. Try: ${Object.keys(SCENARIOS).join(', ')}`)
    process.exit(1)
  }
  const scenario = getScenarioById(scenarioId)
  if (scenario == null) {
    console.error(`Scenario not found: ${scenarioId}`)
    process.exit(1)
  }

  const { corpus, options } = scenario
  const ms = new MiniSearch(options)
  ms.addAll(corpus)
  const snapshot = ms.toJSON()
  const fieldCount = options.fields.length
  const nextId = snapshot.nextId
  const terms = snapshot.index.map(([term]) => term)

  const phases = {
    toJSON: () => ms.toJSON(),
    parseSnapshotIndex: () => parseSnapshotIndex(snapshot, fieldCount, nextId),
    packTermsOnly: () => packTermsFromList(terms),
    validatePackedTermIndex: () => {
      const packed = packTermsFromList(terms)
      validateFrozenTermIndexLeaves(packed, terms.length)
      return packed
    },
    packSearchableMap: () => {
      const map = SearchableMap.from(terms.map((term, i) => [term, i]))
      return packSearchableMap(map)
    },
    finalizePostings: () => {
      const parsed = parseSnapshotIndex(snapshot, fieldCount, nextId)
      return parsed.accumulator.finalize(parsed.termCount, nextId)
    },
    buildFrozenParams: () => buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options),
    freezeImport: () => frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options),
  }

  console.log(`Profile freeze — ${scenario.name} (${scenarioId})`)
  console.log(`  docs: ${corpus.length}, index entries: ${snapshot.index.length}`)
  console.log(`  warmup=${warmup}, iterations=${iterations}\n`)

  for (const [label, fn] of Object.entries(phases)) {
    const { p50 } = timed(fn, warmup, iterations)
    console.log(`  ${label.padEnd(24)} ${p50.toFixed(3)} ms`)
  }

  const parseP50 = timed(phases.parseSnapshotIndex, warmup, iterations).p50
  const finalizeP50 = timed(phases.finalizePostings, warmup, iterations).p50
  const packP50 = timed(phases.packTermsOnly, warmup, iterations).p50
  console.log('\nDerived splits:')
  console.log(`  packTermsOnly                ${packP50.toFixed(3)} ms`)
  console.log(`  postings (finalize − parse)  ${(finalizeP50 - parseP50).toFixed(3)} ms est.`)
  console.log(`  snapshot shell (params−finalize) ${(timed(phases.buildFrozenParams, warmup, iterations).p50 - finalizeP50).toFixed(3)} ms est.`)
  const freezeP50 = timed(phases.freezeImport, warmup, iterations).p50
  console.log(`  parseSnapshotIndex share    ${((parseP50 / freezeP50) * 100).toFixed(1)}% of freezeImport`)
}

main()
