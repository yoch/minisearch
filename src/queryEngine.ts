import type { FrozenTermIndex } from './frozenTermIndex'
import {
  collectDocIdsFromFrozenLayout,
  type FrozenFieldTermFlyweight,
  type FrozenPostingsLayout,
} from './frozenPostings'
import {
  aggregateTerm,
  combineResults,
  fieldBoostsForQuery,
  type AggregateContext,
  type AggregateTermOptions,
  type DocIdGate,
  type FieldBoostsForQuery,
  type FieldTermDataLike,
  type QuerySpec,
  type RawResult,
  termToQuerySpec,
} from './scoring'
import type {
  CombinationOperator,
  Query,
  QueryCombination,
  SearchOptions,
  SearchOptionsWithDefaults,
} from './searchTypes'
import { isWildcardQuery } from './symbols'
import { type QueryEngineRunOptions } from './queryEngineGateLimits'
import {
  collectCombinedDocIds,
  executeCombinedBranches,
} from './queryEngineGating'
import {
  estimateCheapTwoPhasePostingLengthForQuerySpec,
  estimateMaxPostingLengthForQuerySpec,
  forEachQuerySpecTermRef,
  type NormalizedStringQuery,
  visitQuerySpecForScoring,
} from './queryTermRefs'
import { defaultSearchOptions } from './searchDefaults'

/**
 * Adapter exposing packed frozen index storage to the shared query engine.
 * Accessors push prefix/fuzzy matches through visitors to avoid per-match
 * allocation on hot query paths.
 */
export interface QueryIndexView {
  getTermData(term: string): FieldTermDataLike | undefined
  /** Iterate over active documents (used by wildcard queries). */
  forEachActiveDoc(callback: (docId: number, externalId: unknown, storedFields?: Record<string, unknown>) => void): void
  resolveTermIndex(term: string): number | undefined
  /**
   * Rebinds the instance flyweight; returned reference is valid only until the next
   * `fieldTermData` call or prefix/fuzzy iterator step on this view.
   */
  fieldTermData(termIndex: number): FieldTermDataLike
  collectDocIds(
    termIndex: number,
    fieldBoosts: FieldBoostsForQuery,
    context: AggregateContext,
    docIds: Set<number>,
    allowedDocs?: DocIdGate,
  ): void
  visitPrefixMatchesByIndex(term: string, visit: (termIndex: number, length: number) => void): void
  visitFuzzyMatchesByIndex(
    term: string,
    maxDistance: number,
    visit: (termIndex: number, length: number, distance: number) => void,
  ): void
}

export interface QueryEngineParams {
  fields: string[]
  globalSearchOptions: SearchOptionsWithDefaults
  tokenize: (text: string, fieldName?: string) => string[]
  processTerm: (term: string, fieldName?: string) => string | string[] | null | undefined | false
  indexView: QueryIndexView
  aggregateContext: AggregateContext
}

function useGatedEvaluation(
  run: QueryEngineRunOptions | undefined,
  branchCount: number,
  operator: CombinationOperator,
  hasWildcard: boolean,
): boolean {
  if (run?.disableGating) return false
  return shouldUseGatedEvaluation(branchCount, operator, hasWildcard)
}

function isQueryCombination(query: Query): query is QueryCombination {
  return typeof query === 'object'
    && query != null
    && 'queries' in query
    && Array.isArray((query as QueryCombination).queries)
}

function combinationHasWildcard(query: QueryCombination): boolean {
  return query.queries.some(q => isWildcardQuery(q) || (typeof q === 'object' && q != null && 'queries' in q && combinationHasWildcard(q)))
}

function isGatedCombinationOperator(operator: CombinationOperator): boolean {
  const op = operator.toLowerCase()
  return op === 'and' || op === 'and_not'
}

function shouldUseGatedEvaluation(
  branchCount: number,
  operator: CombinationOperator,
  hasWildcard: boolean,
): boolean {
  if (hasWildcard) return false
  if (branchCount <= 1) return false
  return isGatedCombinationOperator(operator)
}

function normalizeStringQuery(
  query: string,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): NormalizedStringQuery {
  const options = {
    tokenize: params.tokenize,
    processTerm: params.processTerm,
    ...params.globalSearchOptions,
    ...searchOptions,
  }
  const tokens = options.tokenize(query)
  const terms: string[] = []
  for (const token of tokens) {
    const processed = options.processTerm(token)
    if (Array.isArray(processed)) {
      for (const term of processed) {
        if (term) terms.push(term)
      }
    } else if (processed) {
      terms.push(processed)
    }
  }

  const toSpec = termToQuerySpec(options)
  const specs: QuerySpec[] = new Array(terms.length)
  for (let i = 0; i < terms.length; i++) {
    specs[i] = toSpec(terms[i], i, terms)
  }

  const { fuzzy: fuzzyWeight, prefix: prefixWeight } = {
    ...defaultSearchOptions.weights,
    ...options.weights,
  }

  return {
    options,
    specs,
    operator: options.combineWith as CombinationOperator,
    fieldBoosts: fieldBoostsForQuery(options, params.fields),
    fuzzyWeight,
    prefixWeight,
  }
}

function executeQuerySpecInternal(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
): RawResult {
  const { fieldBoosts, options } = normalized
  const termOptions: AggregateTermOptions | undefined = allowedDocs == null ? undefined : { allowedDocs }
  const results = new Map() as RawResult

  visitQuerySpecForScoring(query, normalized, params, (data, derivedTerm, termWeight) => {
    aggregateTerm(
      query.term,
      derivedTerm,
      termWeight,
      query.termBoost,
      data,
      fieldBoosts,
      params.aggregateContext,
      options.boostDocument,
      options.bm25,
      results,
      termOptions,
    )
  })

  return results
}

function estimateMaxPostingLengthForQuery(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): number {
  if (isWildcardQuery(query)) {
    return params.aggregateContext.documentCount
  }

  if (isQueryCombination(query)) {
    const options = { ...searchOptions, ...query, queries: undefined }
    let maxLen = 0
    for (const branch of query.queries) {
      maxLen = Math.max(maxLen, estimateMaxPostingLengthForQuery(branch, options, params))
    }
    return maxLen
  }

  if (typeof query !== 'string') return 0

  const normalized = normalizeStringQuery(query, searchOptions, params)
  let maxLen = 0
  for (const spec of normalized.specs) {
    maxLen = Math.max(maxLen, estimateMaxPostingLengthForQuerySpec(spec, normalized, params))
  }
  return maxLen
}

function collectDocIdsForQuerySpec(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
): Set<number> {
  const { fieldBoosts } = normalized
  const docIds = new Set<number>()
  const { indexView, aggregateContext } = params

  forEachQuerySpecTermRef(query, normalized, params, (_kind, termIndex) => {
    if (termIndex != null) {
      indexView.collectDocIds(termIndex, fieldBoosts, aggregateContext, docIds, allowedDocs)
    }
  })
  return docIds
}

/** Query adapter for packed frozen term indexes. */
export function createFrozenQueryIndexView(
  index: FrozenTermIndex,
  layout: FrozenPostingsLayout,
  flyweight: FrozenFieldTermFlyweight,
  forEachActiveDoc: QueryIndexView['forEachActiveDoc'],
): QueryIndexView {
  return {
    resolveTermIndex(term) {
      const ti = index.get(term)
      return ti == null ? undefined : ti
    },
    fieldTermData(termIndex) {
      return flyweight.bind(termIndex)
    },
    collectDocIds(termIndex, fieldBoosts, context, docIds, allowedDocs) {
      collectDocIdsFromFrozenLayout(layout, termIndex, fieldBoosts, context, docIds, allowedDocs)
    },
    getTermData(term) {
      const ti = index.get(term)
      return ti == null ? undefined : flyweight.bind(ti)
    },
    visitPrefixMatchesByIndex(term, visit) {
      index.visitPrefixRefs(term, visit)
    },
    visitFuzzyMatchesByIndex(term, maxDistance, visit) {
      index.visitFuzzyRefs(term, maxDistance, visit)
    },
    forEachActiveDoc,
  }
}

function collectDocIdsForQueryInternal(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
): Set<number> {
  if (isWildcardQuery(query)) {
    const docIds = new Set<number>()
    params.indexView.forEachActiveDoc((docId) => {
      if (allowedDocs != null && !allowedDocs.has(docId)) return
      docIds.add(docId)
    })
    return docIds
  }

  if (isQueryCombination(query)) {
    const options = { ...searchOptions, ...query, queries: undefined }
    const operator = (options.combineWith ?? params.globalSearchOptions.combineWith) as CombinationOperator
    return collectCombinedDocIds(
      query.queries,
      operator,
      (branch, branchAllowed) => collectDocIdsForQueryInternal(branch, options, params, branchAllowed),
      allowedDocs,
    )
  }

  if (typeof query !== 'string') {
    throw new Error('FrozenMiniSearch: invalid query')
  }

  const normalized = normalizeStringQuery(query, searchOptions, params)
  const { specs, operator } = normalized

  if (specs.length <= 1) {
    return specs.length === 1
      ? collectDocIdsForQuerySpec(specs[0], normalized, params, allowedDocs)
      : new Set<number>()
  }

  return collectCombinedDocIds(
    specs,
    operator,
    (spec, branchAllowed) => collectDocIdsForQuerySpec(spec, normalized, params, branchAllowed),
    allowedDocs,
  )
}

function executeWildcardQuery(
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  const results = new Map() as RawResult
  const options: SearchOptionsWithDefaults = { ...params.globalSearchOptions, ...searchOptions }
  const { boostDocument } = options

  params.indexView.forEachActiveDoc((shortId, id, storedFields) => {
    const score = boostDocument ? boostDocument(id, '', storedFields) : 1
    results.set(shortId, { score, terms: [], match: {} })
  })

  return results
}

function executeQueryInternal(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
  run?: QueryEngineRunOptions,
): RawResult {
  if (isWildcardQuery(query)) {
    return executeWildcardQuery(searchOptions, params)
  }

  if (isQueryCombination(query)) {
    // Spread inherits parent combineWith into child branches (MiniSearch 7.2 behavior).
    const options = { ...searchOptions, ...query, queries: undefined }
    const operator = (options.combineWith ?? params.globalSearchOptions.combineWith) as CombinationOperator

    if (useGatedEvaluation(run, query.queries.length, operator, combinationHasWildcard(query))) {
      return executeCombinedBranches(
        query.queries,
        operator,
        params,
        (branch, branchAllowed) => executeQueryInternal(branch, options, params, branchAllowed, run),
        (branch, branchAllowed) => collectDocIdsForQueryInternal(branch, options, params, branchAllowed),
        allowedDocs,
        run,
        branch => estimateMaxPostingLengthForQuery(branch, options, params),
      )
    }

    const results = query.queries.map(subquery =>
      executeQueryInternal(subquery, options, params, allowedDocs, run),
    )
    return combineResults(results, operator)
  }

  if (typeof query !== 'string') {
    throw new Error('FrozenMiniSearch: invalid query')
  }

  const normalized = normalizeStringQuery(query, searchOptions, params)
  const { specs, operator } = normalized

  if (useGatedEvaluation(run, specs.length, operator, false)) {
    return executeCombinedBranches(
      specs,
      operator,
      params,
      (spec, branchAllowed) => executeQuerySpecInternal(spec, normalized, params, branchAllowed),
      (spec, branchAllowed) => collectDocIdsForQuerySpec(spec, normalized, params, branchAllowed),
      allowedDocs,
      run,
      spec => estimateMaxPostingLengthForQuerySpec(spec, normalized, params),
      spec => estimateCheapTwoPhasePostingLengthForQuerySpec(spec, normalized, params),
    )
  }

  const results = specs.map(spec => executeQuerySpecInternal(spec, normalized, params, allowedDocs))
  return combineResults(results, operator)
}

export function executeQuery(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  return executeQueryInternal(query, searchOptions, params)
}

/** @packageInternal Tests and benchmarks only. */
export function executeQueryWithRunOptions(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  run?: QueryEngineRunOptions,
): RawResult {
  return executeQueryInternal(query, searchOptions, params, undefined, run)
}
