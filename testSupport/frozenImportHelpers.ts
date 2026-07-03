import type FrozenMiniSearchCore from '../src/FrozenMiniSearchCore'
import { materializeFrozenAssembleParams, type FrozenMiniSearchCtor } from '../src/FrozenMiniSearchCore'
import { buildFrozenAssembleParamsFromMiniSearchSnapshot, type MiniSearchSnapshot } from '../src/fromMiniSearch'
import type { FrozenAssembleParams } from '../src/frozenTypes'
import type { SnapshotOwnershipMode } from '../src/frozenOwnedSnapshot'
import type { Options } from '../src/searchTypes'

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
