import { buildFrozenParamsFromDocuments } from '../../src/frozenBuild'
import { createFrozenFieldTermFlyweight } from '../../src/frozenPostings'
import { forEachLiveShortId } from '../../src/forEachLiveShortId'
import {
  createFrozenQueryIndexView,
  executeQuery,
  type QueryEngineParams,
} from '../../src/queryEngine'
import {
  finalizeRawSearchResults,
  type AggregateContext,
} from '../../src/scoring'
import type {
  Options,
  Query,
  SearchOptions,
  SearchResult,
} from '../../src/searchTypes'

const REPORT_PREFIX = '@@FROZEN_ENGINE_BENCH@@'
const CORPUS_SIZE = 4096
const BUILD_SAMPLES = 5
const SEARCH_SAMPLES = 9
const SEARCH_TARGET_MS = 60
const SEARCH_MAX_BATCH = 1 << 15

const WORDS = [
  'aurora', 'binary', 'cache', 'delta', 'engine', 'forest', 'frozen', 'gamma',
  'heap', 'index', 'jitter', 'kernel', 'lambda', 'matrix', 'nebula', 'omega',
  'packet', 'prefix', 'query', 'radix', 'search', 'signal', 'tensor', 'vector',
  'window', 'yield', 'zenith', 'branch', 'compact', 'document', 'fuzzy', 'posting',
] as const

type BenchDocument = {
  id: number
  title: string
  text: string
}

type EngineIndex = {
  documentCount: number
  termCount: number
  search: (query: Query, options?: SearchOptions) => SearchResult[]
}

type Workload = {
  name: string
  run: () => SearchResult[]
}

type Timing = {
  medianUs: number
  minUs: number
  maxUs: number
  batch: number
  samples: number
}

let blackhole = 0

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

function timerName(): string {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  return typeof perf?.now === 'function' ? 'performance.now' : 'Date.now'
}

function emit(line: string): void {
  const shellPrint = (globalThis as { print?: (value: string) => void }).print
  if (typeof shellPrint === 'function') {
    shellPrint(line)
    return
  }
  const consoleLike = (globalThis as { console?: { log?: (value: string) => void } }).console
  if (typeof consoleLike?.log === 'function') {
    consoleLike.log(line)
    return
  }
  throw new Error('engine benchmark: no print() or console.log() available')
}

function nextRandom(state: { value: number }): number {
  let x = state.value >>> 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  state.value = x >>> 0
  return state.value
}

function makeDocuments(count: number): BenchDocument[] {
  const state = { value: 0x6d2b79f5 }
  const documents = new Array<BenchDocument>(count)
  for (let id = 0; id < count; id++) {
    const titleWords = new Array<string>(4)
    for (let j = 0; j < titleWords.length; j++) {
      titleWords[j] = WORDS[nextRandom(state) % WORDS.length]
    }

    const bodyWords = new Array<string>(28)
    for (let j = 0; j < bodyWords.length; j++) {
      const selector = nextRandom(state)
      if ((j & 3) === 0) {
        bodyWords[j] = `token${selector % 2048}`
      } else {
        bodyWords[j] = WORDS[selector % WORDS.length]
      }
    }

    documents[id] = {
      id,
      title: `${titleWords.join(' ')} topic${id % 256}`,
      text: `${bodyWords.join(' ')} topic${id % 256} shard${(id * 17) % 97}`,
    }
  }
  return documents
}

const INDEX_OPTIONS: Options<BenchDocument> = {
  fields: ['title', 'text'],
  searchOptions: {
    boost: { title: 1.7 },
  },
}

function createEngineIndex(documents: readonly BenchDocument[]): EngineIndex {
  const params = buildFrozenParamsFromDocuments(documents, INDEX_OPTIONS)
  const fieldTermFlyweight = createFrozenFieldTermFlyweight(params.postings)
  const aggregateContext: AggregateContext = {
    documentCount: params.documentCount,
    avgFieldLength: params.avgFieldLength,
    fieldIds: params.fieldIds,
    getFieldLength: (docId, fieldId) => params.fieldLengthMatrix[docId * params.fieldCount + fieldId] ?? 0,
    getExternalId: docId => params.externalIds[docId],
    resolveTermByIndex: termIndex => params.index.termByIndex(termIndex),
    getStoredFields: () => undefined,
  }
  const queryEngineParams: QueryEngineParams = {
    fields: params.options.fields,
    globalSearchOptions: params.options.searchOptions,
    tokenize: params.options.tokenize,
    processTerm: params.options.processTerm,
    indexView: createFrozenQueryIndexView(
      params.index,
      params.postings,
      fieldTermFlyweight,
      callback => forEachLiveShortId(params.nextId, params.externalIds, callback),
    ),
    aggregateContext,
  }

  return {
    documentCount: params.documentCount,
    termCount: params.termCount,
    search(query: Query, options: SearchOptions = {}): SearchResult[] {
      return finalizeRawSearchResults(
        executeQuery(query, options, queryEngineParams),
        query,
        options,
        params.options.searchOptions,
        docId => params.externalIds[docId],
        undefined,
        params.storedFields,
      )
    },
  }
}

function consumeResults(results: SearchResult[]): number {
  let value = results.length | 0
  const limit = Math.min(results.length, 8)
  for (let i = 0; i < limit; i++) {
    const id = results[i].id
    value = Math.imul(value ^ (typeof id === 'number' ? id : String(id).length), 16777619)
  }
  blackhole ^= value
  return value
}

function runSearchBatch(run: () => SearchResult[], batch: number): number {
  const start = nowMs()
  for (let i = 0; i < batch; i++) consumeResults(run())
  return nowMs() - start
}

function calibrateSearchBatch(run: () => SearchResult[]): number {
  let batch = 1
  while (batch < SEARCH_MAX_BATCH) {
    const elapsed = runSearchBatch(run, batch)
    if (elapsed >= SEARCH_TARGET_MS / 4) {
      const scaled = Math.round(batch * SEARCH_TARGET_MS / Math.max(elapsed, 0.001))
      return Math.max(1, Math.min(SEARCH_MAX_BATCH, scaled))
    }
    batch *= 2
  }
  return SEARCH_MAX_BATCH
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measureSearch(run: () => SearchResult[]): Timing {
  for (let i = 0; i < 24; i++) consumeResults(run())
  const batch = calibrateSearchBatch(run)
  const samples = new Array<number>(SEARCH_SAMPLES)
  for (let i = 0; i < SEARCH_SAMPLES; i++) {
    samples[i] = runSearchBatch(run, batch) * 1000 / batch
  }
  return {
    medianUs: median(samples),
    minUs: Math.min(...samples),
    maxUs: Math.max(...samples),
    batch,
    samples: SEARCH_SAMPLES,
  }
}

function measureBuild(documents: readonly BenchDocument[]): Timing {
  createEngineIndex(documents)
  createEngineIndex(documents)
  const samples = new Array<number>(BUILD_SAMPLES)
  for (let i = 0; i < BUILD_SAMPLES; i++) {
    const start = nowMs()
    const index = createEngineIndex(documents)
    samples[i] = (nowMs() - start) * 1000
    blackhole ^= index.termCount
  }
  return {
    medianUs: median(samples),
    minUs: Math.min(...samples),
    maxUs: Math.max(...samples),
    batch: 1,
    samples: BUILD_SAMPLES,
  }
}

function mixHash(hash: number, value: number): number {
  hash ^= value >>> 0
  return Math.imul(hash, 16777619) >>> 0
}

function mixString(hash: number, value: string): number {
  for (let i = 0; i < value.length; i++) hash = mixHash(hash, value.charCodeAt(i))
  return hash
}

function fingerprint(results: SearchResult[]): string {
  let hash = mixHash(2166136261, results.length)
  const limit = Math.min(results.length, 96)
  for (let i = 0; i < limit; i++) {
    const result = results[i]
    hash = mixHash(hash, typeof result.id === 'number' ? result.id : i)
    hash = mixHash(hash, result.terms.length)
    for (const term of result.terms) hash = mixString(hash, term)
  }
  return hash.toString(16).padStart(8, '0')
}

function main(): void {
  const documents = makeDocuments(CORPUS_SIZE)
  const build = measureBuild(documents)
  const index = createEngineIndex(documents)

  const workloads: Workload[] = [
    { name: 'exact', run: () => index.search('vector') },
    { name: 'prefix', run: () => index.search('token19', { prefix: true }) },
    { name: 'fuzzy', run: () => index.search('serch', { fuzzy: 1 }) },
    { name: 'and', run: () => index.search('vector matrix signal', { combineWith: 'AND' }) },
    { name: 'ranking', run: () => index.search('frozen search radix prefix') },
    {
      name: 'mixed',
      run: () => index.search('searc radi', { prefix: true, fuzzy: 1, combineWith: 'AND' }),
    },
  ]

  const fingerprints: Record<string, string> = {}
  const timings: Record<string, Timing> = { build }
  for (const workload of workloads) {
    fingerprints[workload.name] = fingerprint(workload.run())
    timings[workload.name] = measureSearch(workload.run)
  }

  const report = {
    schema: 1,
    corpus: {
      documents: documents.length,
      terms: index.termCount,
    },
    timer: timerName(),
    fingerprints,
    timings,
    sink: blackhole >>> 0,
  }
  emit(`${REPORT_PREFIX}${JSON.stringify(report)}`)
}

main()
