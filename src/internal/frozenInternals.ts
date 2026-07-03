import type FrozenMiniSearchCore from '../FrozenMiniSearchCore'
import { type FrozenTermIndex } from '../frozenTermIndex'
import { type FrozenPostingsLayout } from '../frozenPostings'
import type { OptionsWithDefaults } from '../frozenTypes'
import type { StoredFieldsLayout } from '../storedFieldsLayout'
import { readStoredFields } from '../storedFieldsLayout'
import type { Query, SearchOptions } from '../searchTypes'
import { finalizeRawSearchResults, type RawResult } from '../scoring'
import {
  executeQuery,
  executeQueryWithRunOptions,
  type QueryEngineParams,
} from '../queryEngine'
import type { QueryEngineRunOptions } from '../queryEngineGateLimits'

type FrozenInternalView<T = any> = {
  _options: OptionsWithDefaults<T>
  _index: FrozenTermIndex
  _externalIds: unknown[]
  _storedFields: StoredFieldsLayout
  _postings: FrozenPostingsLayout
  _queryEngineParams: QueryEngineParams
}

function viewOf<T>(frozen: FrozenMiniSearchCore<T>): FrozenInternalView<T> {
  return frozen as unknown as FrozenInternalView<T>
}

export function frozenTermIndex<T>(frozen: FrozenMiniSearchCore<T>): FrozenTermIndex {
  return viewOf(frozen)._index
}

export function frozenPostings<T>(frozen: FrozenMiniSearchCore<T>): FrozenPostingsLayout {
  return viewOf(frozen)._postings
}

function frozenQueryEngineParams<T>(frozen: FrozenMiniSearchCore<T>): QueryEngineParams {
  return viewOf(frozen)._queryEngineParams
}

export function executeRaw<T>(
  frozen: FrozenMiniSearchCore<T>,
  query: Query,
  searchOptions: SearchOptions = {},
): RawResult {
  return executeQuery(query, searchOptions, frozenQueryEngineParams(frozen))
}

export function executeRawWithRunOptions<T>(
  frozen: FrozenMiniSearchCore<T>,
  query: Query,
  searchOptions: SearchOptions = {},
  run?: QueryEngineRunOptions,
): RawResult {
  return executeQueryWithRunOptions(query, searchOptions, frozenQueryEngineParams(frozen), run)
}

export function finalizeRaw<T>(
  frozen: FrozenMiniSearchCore<T>,
  raw: RawResult,
  query: Query,
  searchOptions: SearchOptions = {},
) {
  const view = viewOf(frozen)
  return finalizeRawSearchResults(
    raw,
    query,
    searchOptions,
    view._options.searchOptions,
    docId => view._externalIds[docId],
    undefined,
    view._storedFields,
  )
}

export function mergedAutoSuggestOptions<T>(
  frozen: FrozenMiniSearchCore<T>,
  autoSuggestOptions: SearchOptions = {},
): SearchOptions {
  return { ...viewOf(frozen)._options.autoSuggestOptions, ...autoSuggestOptions }
}

export function searchWithRunOptions<T>(
  frozen: FrozenMiniSearchCore<T>,
  query: Query,
  searchOptions: SearchOptions = {},
  run?: QueryEngineRunOptions,
) {
  const view = viewOf(frozen)
  const raw = executeRawWithRunOptions(frozen, query, searchOptions, run)
  return finalizeRawSearchResults(
    raw,
    query,
    searchOptions,
    view._options.searchOptions,
    docId => view._externalIds[docId],
    docId => readStoredFields(view._storedFields, docId),
  )
}
