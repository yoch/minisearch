import type { FrozenTermIndex } from './frozenTermIndex'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'
import { buildFrozenAssembleParamsFromMiniSearchSnapshot, type MiniSearchSnapshot } from './fromMiniSearch'
import { type AggregateContext, type RawResult, finalizeRawSearchResults } from './scoring'
import type { IdToShortIdLookup } from './frozenIdLookup'
import {
  createFrozenFieldTermFlyweight,
  validateFrozenPostingsLayout,
  type FrozenFieldTermFlyweight,
  type FrozenPostingsLayout,
} from './frozenPostings'
import {
  buildFrozenParamsFromDocuments,
  createFrozenIndexBuilder,
  type FrozenIndexBuilder,
  type FrozenIndexBuilderHints,
} from './frozenBuild'
import {
  createFrozenQueryIndexView,
  executeQuery as runQuery,
  type QueryEngineParams,
} from './queryEngine'
import { suggestFromRawResults, suggestFromSearchResults } from './suggestions'
import type {
  Options,
  Query,
  SearchOptions,
  SearchResult,
  Suggestion,
} from './searchTypes'
import { type FieldLengthArray } from './fieldLengthMatrix'
import type {
  FrozenAssembleParams,
  OptionsWithDefaults,
} from './frozenTypes'
import { forEachLiveShortId } from './forEachLiveShortId'
import { miniSearchSnapshotFromFrozen } from './toMiniSearch'
import {
  binaryLoadOwnershipModeFromCodec,
  materializeOwnedSnapshot,
  type SnapshotOwnershipMode,
} from './frozenOwnedSnapshot'
import { assembleParamsFromBinarySnapshot, buildBinarySnapshotInput } from './frozenBinaryShared'
import type { FrozenSnapshot } from './binaryStructures'
import { readU8 } from './binaryBytes'
import { MSV5_PAYLOAD_CODEC_OFFSET } from './msv5/binaryMsv5Constants'
import {
  readStoredFields,
  type StoredFieldsLayout,
} from './storedFieldsLayout'
import { WILDCARD_QUERY } from './symbols'
import { getFrozenDefault, type FrozenDefaultOptionName } from './searchDefaults'

const noStoredFields = (): undefined => undefined
type FrozenMiniSearchCtor<T, I extends FrozenMiniSearchCore<T>> = new (params: FrozenAssembleParams<T>) => I
export type { FrozenMiniSearchCtor }

export function materializeFrozenAssembleParams<T>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
): FrozenAssembleParams<T> {
  const owned = materializeOwnedSnapshot(params, ownershipMode)
  const termCount = owned.termCount
  if (owned.fieldLengthMatrix.length !== owned.nextId * owned.fieldCount) {
    throw new Error('FrozenMiniSearch: fieldLengthMatrix size mismatch')
  }
  if (owned.avgFieldLength.length !== owned.fieldCount) {
    throw new Error('FrozenMiniSearch: avgFieldLength size mismatch')
  }
  if (!trustedSource) {
    validateFrozenPostingsLayout(owned.postings, owned.documentCount, owned.nextId)
    validateFrozenTermIndexLeaves(owned.index, termCount)
  }
  return owned
}

function assembleFrozenInternal<T>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
): FrozenMiniSearchCore<T>
function assembleFrozenInternal<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor: FrozenMiniSearchCtor<T, I>,
): I
function assembleFrozenInternal<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor?: FrozenMiniSearchCtor<T, I>,
): FrozenMiniSearchCore<T> | I {
  const owned = materializeFrozenAssembleParams(params, trustedSource, ownershipMode)
  if (Ctor == null) {
    return new FrozenMiniSearchCore(owned)
  }
  return new Ctor(owned)
}

/**
 * @internal Assemble a frozen index from a decoded binary snapshot, shared by the
 * Node and browser entry points. The decode step already ran
 * {@link validateFrozenSnapshot}, so assembly trusts the snapshot. Ownership is
 * derived from the wire codec: raw payloads alias `wireBuffer` and must be copied,
 * compressed payloads are decoded into an owned allocation and can be kept as-is.
 */
export function assembleFrozenFromBinarySnapshot<T, I extends FrozenMiniSearchCore<T>>(
  snap: FrozenSnapshot,
  options: Options<T>,
  wireBuffer: Uint8Array,
  Ctor: FrozenMiniSearchCtor<T, I>,
): I {
  const ownershipMode = binaryLoadOwnershipModeFromCodec(readU8(wireBuffer, MSV5_PAYLOAD_CODEC_OFFSET))
  return assembleFrozenInternal(assembleParamsFromBinarySnapshot(snap, options), true, ownershipMode, Ctor)
}

/** @internal Trusted document build for a concrete FrozenMiniSearch subclass. */
export function frozenFromDocumentsWithCtor<T, I extends FrozenMiniSearchCore<T>>(
  Ctor: FrozenMiniSearchCtor<T, I>,
  documents: readonly T[],
  options: Options<T>,
): I {
  return assembleFrozenInternal(buildFrozenParamsFromDocuments(documents, options), true, 'trusted-build', Ctor)
}

/** @internal Trusted builder finalize for a concrete FrozenMiniSearch subclass. */
export function frozenFromIndexBuilderWithCtor<T, I extends FrozenMiniSearchCore<T>>(
  Ctor: FrozenMiniSearchCtor<T, I>,
  builder: FrozenIndexBuilder<T>,
): I {
  return assembleFrozenInternal(builder.freezeParams(), true, 'trusted-build', Ctor)
}

export default class FrozenMiniSearchCore<T = any> {
  protected readonly _options: OptionsWithDefaults<T>
  protected readonly _index: FrozenTermIndex
  protected readonly _documentCount: number
  protected readonly _nextId: number
  protected readonly _externalIds: unknown[]
  protected readonly _idLookup: IdToShortIdLookup
  protected readonly _fieldIds: { [field: string]: number }
  protected readonly _fieldCount: number
  protected readonly _fieldLengthMatrix: FieldLengthArray
  protected readonly _avgFieldLength: Float32Array
  protected readonly _storedFields: StoredFieldsLayout
  protected readonly _termCount: number
  protected readonly _postings: FrozenPostingsLayout
  protected readonly _fieldTermFlyweight: FrozenFieldTermFlyweight
  private readonly _queryEngineParams: QueryEngineParams
  private readonly _hasStoredFields: boolean

  constructor(params: FrozenAssembleParams<T>) {
    this._options = params.options
    this._documentCount = params.documentCount
    this._nextId = params.nextId
    this._externalIds = params.externalIds
    this._idLookup = params.idLookup
    this._fieldIds = params.fieldIds
    this._fieldCount = params.fieldCount
    this._fieldLengthMatrix = params.fieldLengthMatrix
    this._avgFieldLength = params.avgFieldLength
    this._storedFields = params.storedFields
    this._index = params.index
    this._termCount = params.termCount
    this._postings = params.postings
    this._fieldTermFlyweight = createFrozenFieldTermFlyweight(this._postings)
    this._hasStoredFields = this._storedFields.kind !== 'none'

    const aggregateContext: AggregateContext = {
      documentCount: this._documentCount,
      avgFieldLength: this._avgFieldLength,
      fieldIds: this._fieldIds,
      getFieldLength: (docId, fieldId) => this._getFieldLength(docId, fieldId),
      getExternalId: docId => this._externalIds[docId],
      resolveTermByIndex: termIndex => this._index.termByIndex(termIndex),
      getStoredFields: this._hasStoredFields
        ? docId => readStoredFields(this._storedFields, docId)
        : noStoredFields,
    }
    this._queryEngineParams = {
      fields: this._options.fields,
      globalSearchOptions: this._options.searchOptions,
      tokenize: this._options.tokenize,
      processTerm: this._options.processTerm,
      indexView: createFrozenQueryIndexView(
        this._index,
        this._postings,
        this._fieldTermFlyweight,
        this._hasStoredFields
          ? (callback) => {
              forEachLiveShortId(this._nextId, this._externalIds, (shortId, id) => {
                callback(shortId, id, readStoredFields(this._storedFields, shortId))
              })
            }
          : (callback) => {
              forEachLiveShortId(this._nextId, this._externalIds, callback)
            },
      ),
      aggregateContext,
    }
  }

  static readonly wildcard: typeof WILDCARD_QUERY = WILDCARD_QUERY

  get documentCount(): number { return this._documentCount }
  get termCount(): number { return this._termCount }

  /** Whether a document with the given external id is in the index. */
  has(id: unknown): boolean {
    return this._idLookup.has(id)
  }

  /**
   * Stored fields for a document id, when configured via {@link Options.storeFields}.
   * Returns `undefined` if the id is missing or no fields were stored.
   */
  getStoredFields(id: unknown): Record<string, unknown> | undefined {
    const shortId = this._idLookup.get(id)
    return shortId == null ? undefined : readStoredFields(this._storedFields, shortId)
  }

  /**
   * Search the index. API and scoring match MiniSearch 7 for the same options.
   *
   * `query` may be a string, {@link FrozenMiniSearchCore.wildcard}, or a nested
   * {@link QueryCombination}. Per-query options override index defaults from
   * {@link Options.searchOptions}; see {@link SearchOptions} for boosts, prefix,
   * fuzzy, filters, and `combineWith`.
   *
   * @returns Matches sorted by descending score.
   */
  search(query: Query, searchOptions: SearchOptions = {}): SearchResult[] {
    return finalizeRawSearchResults(
      this._executeQuery(query, searchOptions),
      query,
      searchOptions,
      this._options.searchOptions,
      docId => this._externalIds[docId],
      undefined,
      this._storedFields,
    )
  }

  /**
   * Without a `filter`, aggregates suggestions from raw query hits (no full result materialization).
   * With a `filter`, uses {@link search} so stored fields are available to the predicate.
   */
  autoSuggest(queryString: string, options: SearchOptions = {}): Suggestion[] {
    const merged = { ...this._options.autoSuggestOptions, ...options }
    if (merged.filter == null) {
      return suggestFromRawResults(this._executeQuery(queryString, merged))
    }
    return suggestFromSearchResults(this.search(queryString, merged))
  }

  /** Built-in default for indexing / load options (`tokenize`, `processTerm`, `extractField`, …). */
  static getDefault<K extends FrozenDefaultOptionName>(optionName: K) {
    return getFrozenDefault(optionName)
  }

  /**
   * Build a read-only index in one pass from an in-memory document array.
   * Indexing semantics match MiniSearch `addAll` for the same {@link Options}.
   *
   * For custom ingestion (streaming, per-document transforms), use
   * {@link createFrozenIndexBuilder} and {@link freezeFrozenIndexBuilder} instead.
   * The named export {@link buildFrozenFromDocuments} is equivalent on the Node/browser entry.
   */
  static fromDocuments<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    documents: readonly T[],
    options: Options<T>,
  ): I {
    return frozenFromDocumentsWithCtor(this, documents, options)
  }

  /**
   * Export this index as a MiniSearch wire snapshot (`serializationVersion: 2`).
   * Use for migration or interchange with the `minisearch` package (`JSON.stringify` works via this method).
   * Term order in `index` may differ from MiniSearch native `toJSON`; search scores stay equivalent.
   */
  toJSON(): MiniSearchSnapshot {
    return miniSearchSnapshotFromFrozen({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      externalIds: this._externalIds,
      fieldLengthMatrix: this._fieldLengthMatrix,
      avgFieldLength: this._avgFieldLength,
      storedFields: this._storedFields,
      index: this._index,
      fieldTermFlyweight: this._fieldTermFlyweight,
    })
  }

  /**
   * Build a new frozen index **from** a MiniSearch JSON snapshot string (import / migration).
   * Accepts the wire format produced by MiniSearch `toJSON` or by {@link toJSON} on this class.
   * No runtime dependency on the `minisearch` package.
   */
  static fromJSON<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    json: string,
    options: Options<T> = {} as Options<T>,
  ): I {
    return assembleFrozenInternal(
      buildFrozenAssembleParamsFromMiniSearchSnapshot(JSON.parse(json) as MiniSearchSnapshot, options),
      false,
      'minisearch-json',
      this,
    )
  }

  /**
   * Build a read-only index from an async stream of documents (e.g. CSV parser).
   * For sync iterables, use {@link createFrozenIndexBuilder} with `for...of` instead.
   *
   * @param hints  Optional builder hints; `estimatedDocumentCount` pre-allocates
   *   per-document arrays when the final document count is known upfront.
   */
  static async fromAsyncIterable<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    iterable: AsyncIterable<T>,
    options: Options<T>,
    hints?: FrozenIndexBuilderHints,
  ): Promise<I> {
    const builder = createFrozenIndexBuilder<T>(options, hints)
    for await (const document of iterable) {
      builder.add(document)
    }
    return assembleFrozenInternal(builder.freezeParams(), true, 'trusted-build', this)
  }

  protected _binarySnapshotInput(): ReturnType<typeof buildBinarySnapshotInput> {
    return buildBinarySnapshotInput({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      avgFieldLength: this._avgFieldLength,
      externalIds: this._externalIds,
      storedFieldsLayout: this._storedFields,
      fieldLengthMatrix: this._fieldLengthMatrix,
      postings: this._postings,
    })
  }

  private _getFieldLength(docId: number, fieldId: number): number {
    return this._fieldLengthMatrix[docId * this._fieldCount + fieldId] ?? 0
  }

  private _executeQuery(query: Query, searchOptions: SearchOptions = {}): RawResult {
    return runQuery(query, searchOptions, this._queryEngineParams)
  }
}
