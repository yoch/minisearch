/**
 * Report growable column reallocation during snapshot index accumulation.
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-accumulator-growth.mjs
 */
import MiniSearch from 'minisearch'
import { accumulateSnapshotIndex } from '../../src/fromMiniSearch.ts'
import {
  readIncrementalGrowStats,
  resetIncrementalGrowStats,
} from '../../src/incrementalPostings.ts'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { argValue } from './cpuBenchUtils.mjs'

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

resetIncrementalGrowStats()
const accumulated = accumulateSnapshotIndex(snapshot, options.fields.length, snapshot.nextId)
const stats = readIncrementalGrowStats()
const postings = accumulated.accumulator.totalPostings

console.log(`Accumulator growth — ${scenario.name}`)
console.log(`  postings: ${postings}`)
console.log(`  growEvents: ${stats.growEvents}`)
console.log(`  bytesCopied: ${stats.bytesCopied}`)
console.log(`  bytesCopied/posting: ${(stats.bytesCopied / Math.max(1, postings)).toFixed(2)}`)
