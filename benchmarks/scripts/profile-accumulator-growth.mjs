/**
 * Report growable column reallocation during snapshot index accumulation.
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-accumulator-growth.mjs
 */
import MiniSearch from 'minisearch'
import {
  accumulateSnapshotIndex,
} from '../harness/freezeImportProfiler.ts'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { argValue } from './cpuBenchUtils.mjs'
import { simulateColumnGrowth } from '../../testSupport/growableColumnGrowth.js'

const SCENARIOS = {
  dense: 'denseNumericIds-100k',
  docId: 'docIdUint16Boundary-65536',
  giant: 'extreme-giantVocabulary',
}

const scenarioKey = argValue('--scenario') ?? 'dense'
const scenarioId = SCENARIOS[scenarioKey]
const scenario = getScenarioById(scenarioId)
const { corpus, options } = scenario
const ms = new MiniSearch(options)
ms.addAll(corpus)
const snapshot = ms.toJSON()

const accumulated = accumulateSnapshotIndex(snapshot, options.fields.length, snapshot.nextId)
const postings = accumulated.accumulator.totalPostings
const docIdBytes = snapshot.nextId <= 0xffff ? 2 : 4
const freqBytes = accumulated.accumulator.maxFreq <= 0xff ? 1 : 2
const stats = [docIdBytes, freqBytes, 4]
  .map(bytes => simulateColumnGrowth(postings, bytes))
  .reduce((total, column) => ({
    growEvents: total.growEvents + column.growEvents,
    bytesCopied: total.bytesCopied + column.bytesCopied,
  }), { growEvents: 0, bytesCopied: 0 })

console.log(`Accumulator growth — ${scenario.name}`)
console.log(`  postings: ${postings}`)
console.log(`  growEvents: ${stats.growEvents}`)
console.log(`  bytesCopied: ${stats.bytesCopied}`)
console.log(`  bytesCopied/posting: ${(stats.bytesCopied / Math.max(1, postings)).toFixed(2)}`)
