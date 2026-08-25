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
import type { Options, Query, SearchOptions, SearchResult } from '../../src/searchTypes'

const REPORT_PREFIX = '@@FROZEN_ENGINE_BENCH@@'
const SEARCH_SAMPLES = 7
const SEARCH_TARGET_MS = 50
const SEARCH_MAX_BATCH = 1 << 11

// Deliberately copied from residentEngineBenchEntry.ts. The only material experiment
// is removing all pre-training workloads: this fresh process measures the multi-term
// workload alone, while keeping the exact production benchmark search call shape.
const INDEX_SPECS = [
  { name: 'specialites', count: 15_848, textWords: 6, payloadWords: 8 },
  { name: 'presentations', count: 20_905, textWords: 24, payloadWords: 18 },
  { name: 'compositions', count: 32_389, textWords: 8, payloadWords: 8 },
  { name: 'avis_smr', count: 15_257, textWords: 18, payloadWords: 14 },
  { name: 'avis_asmr', count: 9_906, textWords: 18, payloadWords: 14 },
  { name: 'generiques', count: 10_704, textWords: 7, payloadWords: 7 },
  { name: 'conditions', count: 28_151, textWords: 12, payloadWords: 10 },
  { name: 'ruptures', count: 766, textWords: 5, payloadWords: 7 },
  { name: 'mitm', count: 7_711, textWords: 10, payloadWords: 9 },
  { name: 'substances', count: 3_896, textWords: 5, payloadWords: 6 },
  { name: 'vet_medicaments', count: 3_213, textWords: 9, payloadWords: 12 },
] as const

const TARGET_INDEXES = ['specialites', 'presentations', 'compositions'] as const

const BRANDS = [
  'doliprane', 'efferalgan', 'clamoxyl', 'augmentin', 'advil', 'nurofen',
  'dafalgan', 'spasfon', 'levothyrox', 'zithromax', 'solupred', 'generic',
] as const
const INGREDIENTS = [
  'paracetamol', 'amoxicilline', 'ibuprofene', 'metformine', 'omeprazole',
  'atorvastatine', 'levothyroxine', 'azithromycine', 'prednisone', 'phloroglucinol',
  'acide clavulanique', 'cetirizine', 'ramipril', 'bisoprolol', 'sertraline',
] as const
const MEDICAL_WORDS = [
  'douleur', 'fievre', 'infection', 'inflammation', 'traitement', 'adulte', 'enfant',
  'bacterienne', 'chronique', 'aigue', 'respiratoire', 'digestif', 'cardiaque',
  'symptomatique', 'oral', 'voie', 'dose', 'quotidienne', 'hypertension', 'allergie',
  'comprime', 'gelule', 'solution', 'buvable', 'poudre', 'sirop', 'pellicule',
] as const
const DOSES = [50, 100, 125, 200, 250, 400, 500, 750, 1000] as const

type ResidentDocument = {
  id: number
  code: string
  title: string
  text: string
  payload: string
}

type EngineIndex = {
  termCount: number
  search: (query: Query, options?: SearchOptions) => SearchResult[]
}

type Timing = {
  medianUs: number
  minUs: number
  maxUs: number
  batch: number
  samples: number
}

type ResidentCorpus = {
  name: string
  rows: ResidentDocument[]
  byCode: Map<string, number>
}

type ResidentIndex = {
  name: string
  index: EngineIndex
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
  if (typeof shellPrint === 'function') return shellPrint(line)
  const consoleLike = (globalThis as { console?: { log?: (value: string) => void } }).console
  if (typeof consoleLike?.log === 'function') return consoleLike.log(line)
  throw new Error('resident multi-only benchmark: no print() or console.log() available')
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

const SPACE_OR_PUNCTUATION = /[\s\p{P}]+/u
function tokenizeSearchText(value: unknown): string[] {
  return String(value ?? '').split(SPACE_OR_PUNCTUATION).filter(Boolean)
}

const SEARCH_OPTIONS = {
  tokenize: tokenizeSearchText,
  processTerm: normalizeSearchText,
  combineWith: 'AND' as const,
  prefix: (term: string) => !/^\d+$/.test(term),
  fuzzy: (term: string) => (/^\d/.test(term) ? false : 0.2),
}

const INDEX_OPTIONS = {
  fields: ['code', 'title', 'text'],
  storeFields: [],
  tokenize: tokenizeSearchText,
  processTerm: normalizeSearchText,
  searchOptions: SEARCH_OPTIONS,
  boost: { title: 3, code: 2, text: 1 },
} as unknown as Options<ResidentDocument>

function createEngineIndex(documents: readonly ResidentDocument[]): EngineIndex {
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
    termCount: params.termCount,
    search(query: Query, searchOptions: SearchOptions = {}): SearchResult[] {
      return finalizeRawSearchResults(
        executeQuery(query, searchOptions, queryEngineParams),
        query,
        searchOptions,
        params.options.searchOptions,
        docId => params.externalIds[docId],
        undefined,
        params.storedFields,
      )
    },
  }
}

function makeWords(count: number, seed: number): string {
  const words = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    const selector = (seed * 17 + i * 29) >>> 0
    words[i] = MEDICAL_WORDS[selector % MEDICAL_WORDS.length]
  }
  return words.join(' ')
}

function makeCorpus(name: string, count: number, textWords: number, payloadWords: number, salt: number): ResidentCorpus {
  const rows = new Array<ResidentDocument>(count)
  const byCode = new Map<string, number>()
  for (let id = 0; id < count; id++) {
    const brand = BRANDS[(id * 7 + salt) % BRANDS.length]
    const ingredient = INGREDIENTS[(id * 11 + salt * 3) % INGREDIENTS.length]
    const dose = DOSES[(id * 5 + salt) % DOSES.length]
    const code = `${salt}${String(1_000_000 + id).padStart(7, '0')}`
    rows[id] = {
      id,
      code,
      title: `${brand} ${ingredient} ${dose} mg group${id % 2048}`,
      text: `${ingredient} ${makeWords(textWords, id + salt * 101)} token${(id * 13 + salt) % 8192}`,
      payload: `${name} payload${id % 4096} ${makeWords(payloadWords, id * 3 + salt * 211)}`,
    }
    byCode.set(code, id)
  }
  return { name, rows, byCode }
}

function buildResidentState(): { corpora: ResidentCorpus[], indexes: ResidentIndex[], build: Timing } {
  const corpora = new Array<ResidentCorpus>(INDEX_SPECS.length)
  for (let i = 0; i < INDEX_SPECS.length; i++) {
    const spec = INDEX_SPECS[i]
    corpora[i] = makeCorpus(spec.name, spec.count, spec.textWords, spec.payloadWords, i + 1)
  }

  const started = nowMs()
  const indexes = new Array<ResidentIndex>(corpora.length)
  for (let i = 0; i < corpora.length; i++) {
    indexes[i] = { name: corpora[i].name, index: createEngineIndex(corpora[i].rows) }
  }
  const elapsedUs = (nowMs() - started) * 1000
  for (const item of indexes) blackhole ^= item.index.termCount

  return {
    corpora,
    indexes,
    build: { medianUs: elapsedUs, minUs: elapsedUs, maxUs: elapsedUs, batch: 1, samples: 1 },
  }
}

function residentGuard(corpora: readonly ResidentCorpus[]): void {
  let value = 0
  for (let i = 0; i < corpora.length; i++) {
    const corpus = corpora[i]
    const row = corpus.rows[(i * 997) % corpus.rows.length]
    value ^= row.payload.length
    value ^= corpus.byCode.get(row.code) ?? 0
  }
  blackhole ^= value
}

function targetIndexes(indexes: readonly ResidentIndex[]): EngineIndex[] {
  const out: EngineIndex[] = []
  for (const target of TARGET_INDEXES) {
    const found = indexes.find(item => item.name === target)
    if (found == null) throw new Error(`resident benchmark target missing: ${target}`)
    out.push(found.index)
  }
  return out
}

function runSearch(corpora: readonly ResidentCorpus[], targets: readonly EngineIndex[], query: string): SearchResult[] {
  residentGuard(corpora)
  const parts = new Array<SearchResult[]>(targets.length)
  let total = 0
  for (let i = 0; i < targets.length; i++) {
    parts[i] = targets[i].search(query)
    total += parts[i].length
  }
  const out = new Array<SearchResult>(total)
  let cursor = 0
  for (const part of parts) {
    for (const result of part) out[cursor++] = result
  }
  return out
}

function consume(results: readonly SearchResult[]): void {
  let value = results.length | 0
  const limit = Math.min(results.length, 16)
  for (let i = 0; i < limit; i++) {
    const id = results[i].id
    value = Math.imul(value ^ (typeof id === 'number' ? id : String(id).length), 16777619)
  }
  blackhole ^= value
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function runBatch(run: () => SearchResult[], batch: number): number {
  const started = nowMs()
  for (let i = 0; i < batch; i++) consume(run())
  return nowMs() - started
}

function calibrate(run: () => SearchResult[]): number {
  let batch = 1
  while (batch < SEARCH_MAX_BATCH) {
    const elapsed = runBatch(run, batch)
    if (elapsed >= SEARCH_TARGET_MS / 4) {
      return Math.max(1, Math.min(SEARCH_MAX_BATCH, Math.round(batch * SEARCH_TARGET_MS / Math.max(elapsed, 0.001))))
    }
    batch *= 2
  }
  return SEARCH_MAX_BATCH
}

function measureSearch(run: () => SearchResult[]): Timing {
  for (let i = 0; i < 8; i++) consume(run())
  const batch = calibrate(run)
  const values = new Array<number>(SEARCH_SAMPLES)
  for (let i = 0; i < SEARCH_SAMPLES; i++) values[i] = runBatch(run, batch) * 1000 / batch
  return {
    medianUs: median(values),
    minUs: Math.min(...values),
    maxUs: Math.max(...values),
    batch,
    samples: SEARCH_SAMPLES,
  }
}

function fingerprint(results: readonly SearchResult[]): string {
  let hash = Math.imul(2166136261 ^ results.length, 16777619) >>> 0
  const limit = Math.min(results.length, 128)
  for (let i = 0; i < limit; i++) {
    const id = String(results[i].id)
    for (let j = 0; j < id.length; j++) hash = Math.imul(hash ^ id.charCodeAt(j), 16777619) >>> 0
    hash = Math.imul(hash ^ results[i].terms.length, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function main(): void {
  const { corpora, indexes, build } = buildResidentState()
  const targets = targetIndexes(indexes)
  const run = () => runSearch(corpora, targets, 'amoxicilline 500')
  const fingerprints: Record<string, string> = {
    'i4-multi-only': fingerprint(run()),
  }
  const timings: Record<string, Timing> = {
    'i4-multi-only-build': build,
    'i4-multi-only': measureSearch(run),
  }

  let documents = 0
  let terms = 0
  for (let i = 0; i < corpora.length; i++) {
    documents += corpora[i].rows.length
    terms += indexes[i].index.termCount
  }
  residentGuard(corpora)

  emit(`${REPORT_PREFIX}${JSON.stringify({
    schema: 1,
    profile: 'issue4-multi-only',
    corpus: { documents, terms },
    resident: {
      corpusCount: corpora.length,
      targetIndexes: TARGET_INDEXES,
    },
    timer: timerName(),
    fingerprints,
    timings,
    sink: blackhole >>> 0,
  })}`)
}

main()
