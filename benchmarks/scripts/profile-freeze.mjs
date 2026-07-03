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
  accumulateSnapshotIndex,
  buildFrozenAssembleParamsFromMiniSearchSnapshot,
  parseSnapshotIndex,
} from '../../src/fromMiniSearch.ts'
import {
  frozenAssembleWithCtor,
  frozenFromMiniSearchSnapshot,
} from '../harness/frozenSourceInternals.ts'
import { packTermsFromList } from '../../src/PackedRadixTree/packTermList.ts'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { argValue, intArg, timed } from './cpuBenchUtils.mjs'

const SCENARIOS = {
  overflow: 'extreme-overflowFrequency',
  highFrequency: 'extreme-highFrequency',
  dense: 'denseNumericIds-100k',
  docId: 'docIdUint16Boundary-65536',
  giant: 'extreme-giantVocabulary',
}

const scenarioKey = argValue('--scenario') ?? 'overflow'
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
  const params = buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options)

  const phases = {
    toJSON: () => ms.toJSON(),
    accumulateIndex: () => accumulateSnapshotIndex(snapshot, fieldCount, nextId),
    packTermsOnly: () => packTermsFromList(terms),
    parseSnapshotIndex: () => parseSnapshotIndex(snapshot, fieldCount, nextId),
    finalizePostings: () => {
      const parsed = accumulateSnapshotIndex(snapshot, fieldCount, nextId)
      return parsed.accumulator.finalize(parsed.termCount, nextId)
    },
    buildFrozenParams: () => buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options),
    assembleTrusted: () => frozenAssembleWithCtor(params, true, 'minisearch-json', FrozenMiniSearch),
    assembleUntrusted: () => frozenAssembleWithCtor(params, false, 'minisearch-json', FrozenMiniSearch),
    freezeImport: () => frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options),
  }

  console.log(`Profile freeze — ${scenario.name} (${scenarioId})`)
  console.log(`  docs: ${corpus.length}, index entries: ${snapshot.index.length}`)
  console.log(`  warmup=${warmup}, iterations=${iterations}\n`)

  for (const [label, fn] of Object.entries(phases)) {
    const { p50 } = timed(fn, warmup, iterations)
    console.log(`  ${label.padEnd(24)} ${p50.toFixed(3)} ms`)
  }

  const accumulateP50 = timed(phases.accumulateIndex, warmup, iterations).p50
  const packP50 = timed(phases.packTermsOnly, warmup, iterations).p50
  const parseP50 = timed(phases.parseSnapshotIndex, warmup, iterations).p50
  const finalizeP50 = timed(phases.finalizePostings, warmup, iterations).p50
  const paramsP50 = timed(phases.buildFrozenParams, warmup, iterations).p50
  const freezeP50 = timed(phases.freezeImport, warmup, iterations).p50
  const trustedP50 = timed(phases.assembleTrusted, warmup, iterations).p50
  const untrustedP50 = timed(phases.assembleUntrusted, warmup, iterations).p50

  console.log('\nDerived splits:')
  console.log(`  accumulate (walk only)       ${accumulateP50.toFixed(3)} ms`)
  console.log(`  packTermsOnly                ${packP50.toFixed(3)} ms`)
  console.log(`  parse = accumulate + pack    ${parseP50.toFixed(3)} ms (est ${(accumulateP50 + packP50).toFixed(3)} ms)`)
  console.log(`  finalizePostings             ${finalizeP50.toFixed(3)} ms`)
  console.log(`  finalize − accumulate        ${(finalizeP50 - accumulateP50).toFixed(3)} ms est.`)
  console.log(`  snapshot shell (params−finalize) ${(paramsP50 - finalizeP50).toFixed(3)} ms est.`)
  console.log(`  assemble validation overhead ${(untrustedP50 - trustedP50).toFixed(3)} ms est.`)
  console.log(`  parse share of freezeImport  ${((parseP50 / freezeP50) * 100).toFixed(1)}%`)
}

main()
