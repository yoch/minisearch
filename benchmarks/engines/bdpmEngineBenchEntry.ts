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
const BUILD_SAMPLES = 3
const SEARCH_SAMPLES = 7
const SEARCH_TARGET_MS = 50
const SEARCH_MAX_BATCH = 1 << 12
const RELATED_LIMIT = 50

// Frozen snapshot of the real consumer shape documented by
// fr.gouv.medicaments.rest (2026-08): 15,848 specialities,
// 20,905 presentations and 32,389 compositions.
const SPECIALITES_COUNT = 15_848
const PRESENTATIONS_COUNT = 20_905
const COMPOSITIONS_COUNT = 32_389

const INGREDIENTS = [
  'paracetamol', 'amoxicilline', 'ibuprofene', 'metformine', 'omeprazole',
  'atorvastatine', 'levothyroxine', 'azithromycine', 'prednisone', 'spasfon',
  'acide clavulanique', 'chlorure sodium', 'cetirizine', 'ramipril', 'bisoprolol',
  'pantoprazole', 'sertraline', 'tramadol', 'diclofenac', 'doxycycline',
] as const
const BRANDS = [
  'doliprane', 'efferalgan', 'clamoxyl', 'augmentin', 'advil', 'nurofen',
  'dafalgan', 'spasfon', 'levothyrox', 'zithromax', 'solupred', 'generic',
] as const
const FORMS = [
  'comprime', 'gelule', 'solution buvable', 'poudre', 'sirop', 'suppositoire',
  'comprime pellicule', 'comprime effervescent', 'suspension buvable',
] as const
const LABS = ['sanofi', 'teva', 'biogaran', 'sandoz', 'viatris', 'eg labo', 'arrow'] as const
const INDICATION_WORDS = [
  'douleur', 'fievre', 'infection', 'inflammation', 'traitement', 'adulte', 'enfant',
  'bacterienne', 'chronique', 'aigue', 'respiratoire', 'digestif', 'cardiaque',
  'symptomatique', 'oral', 'voie', 'dose', 'quotidienne', 'hypertension', 'allergie',
] as const
const DOSES = [50, 100, 125, 200, 250, 400, 500, 750, 1000] as const

type Specialite = {
  id: number
  cis: string
  denomination: string
  forme_pharma: string
  titulaire: string
}
type Presentation = {
  id: number
  cis: string
  cip7: string
  cip13: string
  libelle: string
  indications: string
}
type Composition = {
  id: number
  cis: string
  denomination_substance: string
  dosage: string
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
type Ranked = {
  rowIndex: number
  score: number
  priority: number
  match_quality: 'fuzzy' | 'prefix' | 'exact'
}
type ApiHit = Record<string, unknown> & {
  id: string | number
  cis: string
  match_quality: 'fuzzy' | 'prefix' | 'exact'
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
  throw new Error('bdpm engine benchmark: no print() or console.log() available')
}
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
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
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function queryTerms(query: string): string[] {
  return tokenizeSearchText(query).map(normalizeSearchText).filter(Boolean)
}
function termMatchesAsWord(haystack: string, term: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:[^a-z0-9]|$)`).test(haystack)
}
function computeMatchPriority(primaryValue: unknown, query: string, idValue = '', codeValues: unknown[] = []): number {
  const normalizedQuery = normalizeSearchText(query)
  const terms = queryTerms(query)
  if (!terms.length) return 0
  const value = normalizeSearchText(primaryValue)
  const normalizedId = normalizeSearchText(idValue)
  if (value === normalizedQuery || normalizedId === normalizedQuery) return 2
  for (const codeValue of codeValues) {
    if (normalizeSearchText(codeValue) === normalizedQuery) return 2
  }
  if (value.startsWith(normalizedQuery)) return 1
  const haystack = value || normalizedId
  if (!haystack) return 0
  if (!terms.every(term => haystack.includes(term))) return 0
  if (terms.every(term => termMatchesAsWord(haystack, term))) return 1
  if (haystack.startsWith(terms[0])) return 1
  return 0
}
function quality(priority: number): 'fuzzy' | 'prefix' | 'exact' {
  return priority >= 2 ? 'exact' : priority === 1 ? 'prefix' : 'fuzzy'
}

const COMMON_SEARCH_OPTIONS = {
  tokenize: tokenizeSearchText,
  processTerm: normalizeSearchText,
  combineWith: 'AND' as const,
  prefix: (term: string) => !/^\d+$/.test(term),
  fuzzy: (term: string) => (/^\d/.test(term) ? false : 0.2),
}

function createEngineIndex<T extends { id: number }>(documents: readonly T[], options: Options<T>): EngineIndex {
  const params = buildFrozenParamsFromDocuments(documents, options)
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

function makeCorpora(): { specialites: Specialite[], presentations: Presentation[], compositions: Composition[] } {
  const specialites = new Array<Specialite>(SPECIALITES_COUNT)
  for (let id = 0; id < SPECIALITES_COUNT; id++) {
    const ingredient = INGREDIENTS[id % INGREDIENTS.length]
    const brand = BRANDS[(id * 7) % BRANDS.length]
    const dose = DOSES[(id * 5) % DOSES.length]
    const cis = String(6_000_0000 + id)
    specialites[id] = {
      id,
      cis,
      denomination: `${brand} ${ingredient} ${dose} mg`,
      forme_pharma: FORMS[(id * 3) % FORMS.length],
      titulaire: LABS[(id * 11) % LABS.length],
    }
  }

  const presentations = new Array<Presentation>(PRESENTATIONS_COUNT)
  for (let id = 0; id < PRESENTATIONS_COUNT; id++) {
    const specialiteId = (id * 7919) % SPECIALITES_COUNT
    const source = specialites[specialiteId]
    const words = new Array<string>(8)
    for (let j = 0; j < words.length; j++) words[j] = INDICATION_WORDS[(id * 5 + j * 7) % INDICATION_WORDS.length]
    presentations[id] = {
      id,
      cis: source.cis,
      cip7: pad(3_000_000 + id, 7),
      cip13: `34009${pad(3_000_000 + id, 8)}`,
      libelle: `${source.denomination}, ${source.forme_pharma}, boite de ${(id % 5 + 1) * 10}`,
      indications: `${INGREDIENTS[specialiteId % INGREDIENTS.length]} ${words.join(' ')}`,
    }
  }

  const compositions = new Array<Composition>(COMPOSITIONS_COUNT)
  for (let id = 0; id < COMPOSITIONS_COUNT; id++) {
    const specialiteId = (id * 3571) % SPECIALITES_COUNT
    const ingredient = INGREDIENTS[(specialiteId + id % 3) % INGREDIENTS.length]
    compositions[id] = {
      id,
      cis: specialites[specialiteId].cis,
      denomination_substance: ingredient,
      dosage: `${DOSES[(id * 7) % DOSES.length]} mg`,
    }
  }
  return { specialites, presentations, compositions }
}

const SPECIALITES_OPTIONS = {
  fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
  storeFields: [],
  tokenize: tokenizeSearchText,
  processTerm: normalizeSearchText,
  searchOptions: COMMON_SEARCH_OPTIONS,
  boost: { denomination: 3, cis: 2, forme_pharma: 0.5, titulaire: 1 },
} as unknown as Options<Specialite>
const PRESENTATIONS_OPTIONS = {
  fields: ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
  storeFields: [],
  tokenize: tokenizeSearchText,
  processTerm: normalizeSearchText,
  searchOptions: COMMON_SEARCH_OPTIONS,
  boost: { libelle: 3, indications: 2, cis: 2, cip7: 1.5, cip13: 1.5 },
} as unknown as Options<Presentation>
const COMPOSITIONS_OPTIONS = {
  fields: ['cis', 'denomination_substance', 'dosage'],
  storeFields: [],
  tokenize: tokenizeSearchText,
  processTerm: normalizeSearchText,
  searchOptions: COMMON_SEARCH_OPTIONS,
  boost: { denomination_substance: 3, cis: 2, dosage: 1 },
} as unknown as Options<Composition>

type BdpmIndexes = {
  specialites: EngineIndex
  presentations: EngineIndex
  compositions: EngineIndex
}
function buildIndexes(corpora: ReturnType<typeof makeCorpora>): BdpmIndexes {
  return {
    specialites: createEngineIndex(corpora.specialites, SPECIALITES_OPTIONS),
    presentations: createEngineIndex(corpora.presentations, PRESENTATIONS_OPTIONS),
    compositions: createEngineIndex(corpora.compositions, COMPOSITIONS_OPTIONS),
  }
}
function buildRelated<T extends { cis: string }>(rows: readonly T[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const key = rows[i].cis
    const values = map.get(key)
    if (values) values.push(i)
    else map.set(key, [i])
  }
  return map
}
function rankAndMaterialize<T extends { id: number } & Record<string, unknown>>(
  rows: readonly T[], results: SearchResult[], query: string,
  primaryField: keyof T, idField: keyof T, codeFields: (keyof T)[] = [],
): ApiHit[] {
  const ranked = new Array<Ranked>(results.length)
  for (let i = 0; i < results.length; i++) {
    const res = results[i]
    const rowIndex = Number(res.id)
    const row = rows[rowIndex]
    const priority = computeMatchPriority(
      row[primaryField], query, String(row[idField] ?? ''), codeFields.map(field => row[field]),
    )
    ranked[i] = { rowIndex, score: res.score, priority, match_quality: quality(priority) }
  }
  ranked.sort((a, b) => b.priority - a.priority || b.score - a.score)
  const out = new Array<ApiHit>(ranked.length)
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i]
    const row = rows[item.rowIndex]
    out[i] = { ...row, id: row.id, cis: String(row.cis), match_quality: item.match_quality }
  }
  return out
}

function runBdpmSearch(
  corpora: ReturnType<typeof makeCorpora>, indexes: BdpmIndexes,
  presentationByCis: Map<string, number[]>, compositionByCis: Map<string, number[]>, query: string,
): ApiHit[] {
  const searches = [
    rankAndMaterialize(corpora.specialites, indexes.specialites.search(query), query, 'denomination', 'cis'),
    rankAndMaterialize(
      corpora.presentations, indexes.presentations.search(query), query,
      'libelle', 'cis', ['cis', 'cip7', 'cip13'],
    ),
    rankAndMaterialize(corpora.compositions, indexes.compositions.search(query), query, 'denomination_substance', 'cis'),
  ]

  const qualityByCis: Record<string, 'fuzzy' | 'prefix' | 'exact'> = {}
  const rank = { fuzzy: 1, prefix: 2, exact: 3 }
  for (const items of searches) {
    for (const item of items) {
      const previous = qualityByCis[item.cis]
      if (!previous || rank[item.match_quality] > rank[previous]) qualityByCis[item.cis] = item.match_quality
    }
  }

  const keys = Object.keys(qualityByCis)
  const out = new Array<ApiHit>(keys.length)
  for (let i = 0; i < keys.length; i++) {
    const cis = keys[i]
    const specialiteId = Number(cis) - 6_000_0000
    const source = corpora.specialites[specialiteId]
    const p = presentationByCis.get(cis) || []
    const c = compositionByCis.get(cis) || []
    out[i] = {
      ...source,
      id: cis,
      cis,
      match_quality: qualityByCis[cis],
      presentations: p.slice(0, RELATED_LIMIT).map(index => ({ ...corpora.presentations[index] })),
      compositions: c.slice(0, RELATED_LIMIT).map(index => ({ ...corpora.compositions[index] })),
    }
  }
  return out
}

function consume(results: readonly ApiHit[]): void {
  let value = results.length | 0
  const limit = Math.min(results.length, 16)
  for (let i = 0; i < limit; i++) value = Math.imul(value ^ String(results[i].id).length, 16777619)
  blackhole ^= value
}
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
function runBatch(run: () => ApiHit[], batch: number): number {
  const start = nowMs()
  for (let i = 0; i < batch; i++) consume(run())
  return nowMs() - start
}
function calibrate(run: () => ApiHit[]): number {
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
function measureSearch(run: () => ApiHit[]): Timing {
  for (let i = 0; i < 8; i++) consume(run())
  const batch = calibrate(run)
  const values = new Array<number>(SEARCH_SAMPLES)
  for (let i = 0; i < SEARCH_SAMPLES; i++) values[i] = runBatch(run, batch) * 1000 / batch
  return { medianUs: median(values), minUs: Math.min(...values), maxUs: Math.max(...values), batch, samples: SEARCH_SAMPLES }
}
function measureBuild(corpora: ReturnType<typeof makeCorpora>): Timing {
  buildIndexes(corpora)
  const values = new Array<number>(BUILD_SAMPLES)
  for (let i = 0; i < BUILD_SAMPLES; i++) {
    const start = nowMs()
    const indexes = buildIndexes(corpora)
    values[i] = (nowMs() - start) * 1000
    blackhole ^= indexes.specialites.termCount ^ indexes.presentations.termCount ^ indexes.compositions.termCount
  }
  return { medianUs: median(values), minUs: Math.min(...values), maxUs: Math.max(...values), batch: 1, samples: BUILD_SAMPLES }
}
function hashResults(results: readonly ApiHit[]): string {
  let hash = Math.imul(2166136261 ^ results.length, 16777619) >>> 0
  const limit = Math.min(results.length, 128)
  for (let i = 0; i < limit; i++) {
    const value = String(results[i].id)
    for (let j = 0; j < value.length; j++) hash = Math.imul(hash ^ value.charCodeAt(j), 16777619) >>> 0
    hash = Math.imul(hash ^ (results[i].match_quality === 'exact' ? 3 : results[i].match_quality === 'prefix' ? 2 : 1), 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function main(): void {
  const corpora = makeCorpora()
  const build = measureBuild(corpora)
  const indexes = buildIndexes(corpora)
  const presentationByCis = buildRelated(corpora.presentations)
  const compositionByCis = buildRelated(corpora.compositions)

  const workloads = {
    'bdpm-brand': () => runBdpmSearch(corpora, indexes, presentationByCis, compositionByCis, 'doliprane'),
    'bdpm-substance': () => runBdpmSearch(corpora, indexes, presentationByCis, compositionByCis, 'paracetamol'),
    'bdpm-multi': () => runBdpmSearch(corpora, indexes, presentationByCis, compositionByCis, 'amoxicilline 500'),
    'bdpm-accent': () => runBdpmSearch(corpora, indexes, presentationByCis, compositionByCis, 'paracétamol'),
  }
  const fingerprints: Record<string, string> = {}
  const timings: Record<string, Timing> = { 'bdpm-build': build }
  for (const [name, run] of Object.entries(workloads)) {
    fingerprints[name] = hashResults(run())
    timings[name] = measureSearch(run)
  }
  const termCount = indexes.specialites.termCount + indexes.presentations.termCount + indexes.compositions.termCount
  emit(`${REPORT_PREFIX}${JSON.stringify({
    schema: 1,
    profile: 'bdpm-shaped',
    corpus: {
      documents: SPECIALITES_COUNT + PRESENTATIONS_COUNT + COMPOSITIONS_COUNT,
      terms: termCount,
    },
    timer: timerName(),
    fingerprints,
    timings,
    sink: blackhole >>> 0,
  })}`)
}

main()
