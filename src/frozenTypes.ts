import type { FrozenTermIndex } from './frozenTermIndex'
import type { IdToShortIdLookup } from './frozenIdLookup'
import type { FrozenPostingsLayout } from './frozenPostings'
import type { FieldLengthArray } from './fieldLengthMatrix'
import type { StoredFieldsLayout } from './storedFieldsLayout'
import type { OptionsWithDefaults } from './searchTypes'

export type { OptionsWithDefaults } from './searchTypes'
export type { FieldLengthArray } from './fieldLengthMatrix'

/**
 * Low-level parameters for internal frozen index assembly (custom frozen index pipelines).
 * Typical apps use {@link buildFrozenFromDocuments}, {@link FrozenMiniSearch.fromJSON},
 * or binary load instead.
 */
export interface FrozenAssembleParams<T = any> {
  options: OptionsWithDefaults<T>
  documentCount: number
  nextId: number
  fieldIds: { [field: string]: number }
  fieldCount: number
  externalIds: unknown[]
  idLookup: IdToShortIdLookup
  storedFields: StoredFieldsLayout
  fieldLengthMatrix: FieldLengthArray
  avgFieldLength: Float32Array
  index: FrozenTermIndex
  termCount: number
  postings: FrozenPostingsLayout
}
