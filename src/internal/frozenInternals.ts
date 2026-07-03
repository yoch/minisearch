import type FrozenMiniSearchCore from '../FrozenMiniSearchCore'
import { materializeFrozenAssembleParams, type FrozenMiniSearchCtor } from '../FrozenMiniSearchCore'
import { buildFrozenAssembleParamsFromMiniSearchSnapshot, type MiniSearchSnapshot } from '../fromMiniSearch'
import { type FrozenTermIndex } from '../frozenTermIndex'
import type { IdToShortIdLookup } from '../frozenIdLookup'
import {
  postingsTypedBytes,
  type FrozenPostingsLayout,
} from '../frozenPostings'
import type { FieldLengthArray } from '../fieldLengthMatrix'
import type { FrozenAssembleParams, FrozenMemoryBreakdown, OptionsWithDefaults } from '../frozenTypes'
import { type SnapshotOwnershipMode } from '../frozenOwnedSnapshot'
import type { StoredFieldsLayout } from '../storedFieldsLayout'
import {
  readStoredFields,
  storedFieldsJsonBytes,
  storedFieldsSlotCount,
} from '../storedFieldsLayout'
import type { Options, Query, SearchOptions } from '../searchTypes'
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
  _documentCount: number
  _nextId: number
  _externalIds: unknown[]
  _idLookup: IdToShortIdLookup
  _fieldLengthMatrix: FieldLengthArray
  _avgFieldLength: Float32Array
  _storedFields: StoredFieldsLayout
  _postings: FrozenPostingsLayout
  _queryEngineParams: QueryEngineParams
}

function viewOf<T>(frozen: FrozenMiniSearchCore<T>): FrozenInternalView<T> {
  return frozen as unknown as FrozenInternalView<T>
}

/** Test/benchmark-only low-level assembly path. */
export function frozenAssembleWithCtor<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor: FrozenMiniSearchCtor<T, I>,
): I {
  return new Ctor(materializeFrozenAssembleParams(params, trustedSource, ownershipMode))
}

/** Test/benchmark-only import path from a pre-parsed MiniSearch snapshot. */
export function frozenFromMiniSearchSnapshot<T, I extends FrozenMiniSearchCore<T>>(
  Ctor: FrozenMiniSearchCtor<T, I>,
  snapshot: MiniSearchSnapshot,
  options: Options<T> = {} as Options<T>,
): I {
  return frozenAssembleWithCtor(
    buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options),
    false,
    'minisearch-json',
    Ctor,
  )
}

/** Test/benchmark-only import path from an object exposing MiniSearch `toJSON()`. */
export function frozenFromMiniSearch<T, I extends FrozenMiniSearchCore<T>>(
  Ctor: FrozenMiniSearchCtor<T, I>,
  source: { toJSON(): MiniSearchSnapshot },
  options: Options<T> = {} as Options<T>,
): I {
  return frozenFromMiniSearchSnapshot(Ctor, source.toJSON(), options)
}

/** Benchmark-only retained structure estimate. */
export function frozenMemoryBreakdown<T>(frozen: FrozenMiniSearchCore<T>): FrozenMemoryBreakdown {
  const view = viewOf(frozen)
  const postingsStats = postingsTypedBytes(view._postings)
  const storedJson = storedFieldsJsonBytes(view._storedFields)
  const radixEst = view._index.packedByteLength()
  const idMapBytes = view._idLookup.mode === 'lazy-map' ? view._idLookup.mapEntryCount * 32 : 0

  const estimatedStructuredBytes
    = postingsStats.totalTypedBytes
      + view._fieldLengthMatrix.byteLength
      + view._avgFieldLength.byteLength
      + radixEst
      + storedJson
      + idMapBytes

  return {
    termCount: frozen.termCount,
    documentCount: view._documentCount,
    nextId: view._nextId,
    postings: {
      slotCount: postingsStats.slotCount,
      layout: view._postings.layout,
      docIdWidth: view._postings.docIdWidth,
      allDocIdsBytes: postingsStats.allDocIdsBytes,
      allFreqsBytes: postingsStats.allFreqsBytes,
      offsetsBytes: postingsStats.offsetsBytes,
      lengthsBytes: postingsStats.lengthsBytes,
      totalTypedBytes: postingsStats.totalTypedBytes,
    },
    termIndex: {
      nodeCount: view._index.packedNodeCount(),
      edgeCount: view._index.packedEdgeCount(),
      estimatedBytes: radixEst,
    },
    documents: {
      externalIdsSlots: view._externalIds.length,
      storedFieldsSlots: storedFieldsSlotCount(view._storedFields),
      idLookupMode: view._idLookup.mode,
      idToShortIdEntries: view._idLookup.mapEntryCount,
      fieldLengthMatrixBytes: view._fieldLengthMatrix.byteLength,
      avgFieldLengthBytes: view._avgFieldLength.byteLength,
      storedFieldsJsonBytes: storedJson,
    },
    estimatedStructuredBytes,
  }
}

export function frozenTermIndex<T>(frozen: FrozenMiniSearchCore<T>): FrozenTermIndex {
  return viewOf(frozen)._index
}

export function frozenPostings<T>(frozen: FrozenMiniSearchCore<T>): FrozenPostingsLayout {
  return viewOf(frozen)._postings
}

export function frozenFieldLengthMatrix<T>(frozen: FrozenMiniSearchCore<T>): FieldLengthArray {
  return viewOf(frozen)._fieldLengthMatrix
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
