import {
  AND,
  combineResults,
  type CombinationOperator,
  type DocIdGate,
  type RawResult,
} from './scoring'
import {
  gateIsSelectiveEnough,
  DEFAULT_POSTING_GATE_MIN_LENGTH,
  DEFAULT_POSTING_GATE_POLICY,
  DEFAULT_POSTING_GATE_RATIO_SHIFT,
  resolveGateMaxSize,
  type QueryEngineRunOptions,
} from './queryEngineGateLimits'
import type { QueryEngineParams } from './queryEngine'

/** Empirical broad-exclusion cutoff: only collect first when both sides cover much of the corpus. */
const BROAD_EXCLUSION_TWO_PHASE_MIN_FRACTION = 0.5

function gateFromResult(result: RawResult): DocIdGate {
  return {
    get size() {
      return result.size
    },
    has(docId) {
      return result.has(docId)
    },
    [Symbol.iterator]() {
      return result.keys()
    },
  }
}

function intersectDocIdsInPlace(docIds: Set<number>, branchDocIds: DocIdGate): void {
  for (const docId of docIds) {
    if (!branchDocIds.has(docId)) docIds.delete(docId)
  }
}

function subtractDocIdsInPlace(docIds: Set<number>, excludedDocIds: DocIdGate): void {
  for (const docId of excludedDocIds) docIds.delete(docId)
}

function subtractDocIdsFromResult(result: RawResult, excludedDocIds: DocIdGate): void {
  for (const docId of excludedDocIds) result.delete(docId)
}

function twoPhasePostingLengths<T>(
  branches: readonly T[],
  estimateTwoPhasePostingLength: ((branch: T) => number | undefined) | undefined,
): number[] | undefined {
  if (estimateTwoPhasePostingLength == null) return undefined
  const lengths = new Array<number>(branches.length)
  for (let i = 0; i < branches.length; i++) {
    const length = estimateTwoPhasePostingLength(branches[i])
    if (length == null) return undefined
    lengths[i] = length
  }
  return lengths
}

function shouldUseTwoPhaseAnd(
  branchPostingLengths: readonly number[],
  allowedDocs: DocIdGate | undefined,
): boolean {
  if (branchPostingLengths.length <= 1) return false

  const firstLength = branchPostingLengths[0]
  const effectiveFirstLength = allowedDocs == null
    ? firstLength
    : Math.min(firstLength, allowedDocs.size)
  if (effectiveFirstLength < DEFAULT_POSTING_GATE_MIN_LENGTH) return false

  const targetLength = effectiveFirstLength >>> DEFAULT_POSTING_GATE_RATIO_SHIFT
  for (let i = 1; i < branchPostingLengths.length; i++) {
    const len = branchPostingLengths[i]
    if (len > 0 && len <= targetLength) return true
  }
  return false
}

function shouldUseTwoPhaseAndNot(
  branchPostingLengths: readonly number[],
  allowedDocs: DocIdGate | undefined,
  documentCount: number,
): boolean {
  if (branchPostingLengths.length <= 1) return false

  const firstLength = branchPostingLengths[0]
  const effectiveFirstLength = allowedDocs == null
    ? firstLength
    : Math.min(firstLength, allowedDocs.size)
  const largeThreshold = Math.max(
    DEFAULT_POSTING_GATE_MIN_LENGTH,
    Math.floor(documentCount * BROAD_EXCLUSION_TWO_PHASE_MIN_FRACTION),
  )
  if (effectiveFirstLength < largeThreshold) return false

  for (let i = 1; i < branchPostingLengths.length; i++) {
    if (branchPostingLengths[i] >= largeThreshold) return true
  }
  return false
}

function executeAndWithFinalGate<T>(
  branches: readonly T[],
  finalGate: Set<number>,
  executeBranch: (branch: T, allowedDocs?: DocIdGate) => RawResult,
): RawResult {
  if (finalGate.size === 0) return new Map()

  let result = executeBranch(branches[0], finalGate)
  for (let i = 1; i < branches.length; i++) {
    if (result.size === 0) return result
    result = combineResults([result, executeBranch(branches[i], finalGate)], AND)
  }
  return result
}

function collectAndDocIdsByEstimatedLength<T>(
  branches: readonly T[],
  branchPostingLengths: readonly number[],
  collectBranch: (branch: T, allowedDocs?: DocIdGate) => Set<number>,
  allowedDocs?: DocIdGate,
): Set<number> {
  const order = branches.map((_, i) => i)
  order.sort((a, b) => branchPostingLengths[a] - branchPostingLengths[b] || a - b)

  const docIds = collectBranch(branches[order[0]], allowedDocs)
  for (let i = 1; i < order.length; i++) {
    if (docIds.size === 0) return docIds
    intersectDocIdsInPlace(docIds, collectBranch(branches[order[i]], docIds))
  }
  return docIds
}

export function collectCombinedDocIds<T>(
  branches: readonly T[],
  operator: CombinationOperator,
  collectBranch: (branch: T, allowedDocs?: DocIdGate) => Set<number>,
  allowedDocs?: DocIdGate,
): Set<number> {
  if (branches.length === 0) return new Set()

  const op = operator.toLowerCase()
  if (op === 'or') {
    const docIds = new Set<number>()
    for (const branch of branches) {
      for (const docId of collectBranch(branch, allowedDocs)) {
        docIds.add(docId)
      }
    }
    return docIds
  }

  const docIds = collectBranch(branches[0], allowedDocs)
  if (op === 'and') {
    for (let i = 1; i < branches.length; i++) {
      if (docIds.size === 0) return docIds
      intersectDocIdsInPlace(docIds, collectBranch(branches[i], docIds))
    }
    return docIds
  }

  if (op === 'and_not') {
    for (let i = 1; i < branches.length; i++) {
      subtractDocIdsInPlace(docIds, collectBranch(branches[i], docIds))
      if (docIds.size === 0) return docIds
    }
    return docIds
  }

  throw new Error(`FrozenMiniSearch: invalid combination operator: ${operator}`)
}

/**
 * AND: normally score left-to-right with optional docId gates; for cheap-estimated broad-first
 * queries, collect the final gate first, then score branches in original order.
 * AND_NOT: score the positive branch only; negated branches are collected as docId sets and
 * subtracted without scoring. Large cheap-estimated exclusions may collect survivors first.
 */
export function executeCombinedBranches<T>(
  branches: readonly T[],
  operator: CombinationOperator,
  params: QueryEngineParams,
  executeBranch: (branch: T, allowedDocs?: DocIdGate) => RawResult,
  collectBranch: (branch: T, allowedDocs?: DocIdGate) => Set<number>,
  allowedDocs?: DocIdGate,
  run?: QueryEngineRunOptions,
  estimateBranchPostingLength?: (branch: T) => number,
  estimateTwoPhasePostingLength?: (branch: T) => number | undefined,
): RawResult {
  if (branches.length === 0) return new Map()

  const op = operator.toLowerCase()
  if (op === 'or') {
    return combineResults(
      branches.map(branch => executeBranch(branch, allowedDocs)),
      operator,
    )
  }

  if (op === 'and') {
    const branchPostingLengths = twoPhasePostingLengths(branches, estimateTwoPhasePostingLength)
    if (branchPostingLengths != null && shouldUseTwoPhaseAnd(branchPostingLengths, allowedDocs)) {
      const finalGate = collectAndDocIdsByEstimatedLength(
        branches,
        branchPostingLengths,
        collectBranch,
        allowedDocs,
      )
      return executeAndWithFinalGate(branches, finalGate, executeBranch)
    }

    let result = executeBranch(branches[0], allowedDocs)
    let gate = gateFromResult(result)
    const limits = run?.gateLimits
    const documentCount = params.aggregateContext.documentCount
    const postingGatePolicy = run?.postingGatePolicy ?? DEFAULT_POSTING_GATE_POLICY
    const maxGateSize = resolveGateMaxSize(documentCount, limits)
    for (let i = 1; i < branches.length; i++) {
      if (gate.size === 0) return result

      const absoluteSelective = gate.size <= maxGateSize
      const postingListLength = absoluteSelective
        ? undefined
        : estimateBranchPostingLength?.(branches[i])

      const selective = gateIsSelectiveEnough(
        gate.size,
        documentCount,
        limits,
        postingListLength,
        postingGatePolicy,
      )
      const branchAllowed = selective
        ? gate
        : allowedDocs
      result = combineResults([result, executeBranch(branches[i], branchAllowed)], AND)
      gate = gateFromResult(result)
    }
    return result
  }

  if (op === 'and_not') {
    const branchPostingLengths = twoPhasePostingLengths(branches, estimateTwoPhasePostingLength)
    if (branchPostingLengths != null && shouldUseTwoPhaseAndNot(
      branchPostingLengths,
      allowedDocs,
      params.aggregateContext.documentCount,
    )) {
      const finalGate = collectCombinedDocIds(
        branches,
        operator,
        collectBranch,
        allowedDocs,
      )
      return finalGate.size === 0 ? new Map() : executeBranch(branches[0], finalGate)
    }

    const result = executeBranch(branches[0], allowedDocs)
    let gate = gateFromResult(result)
    for (let i = 1; i < branches.length; i++) {
      subtractDocIdsFromResult(result, collectBranch(branches[i], gate))
      if (result.size === 0) return result
      gate = gateFromResult(result)
    }
    return result
  }

  throw new Error(`FrozenMiniSearch: invalid combination operator: ${operator}`)
}
