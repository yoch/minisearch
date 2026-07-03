import { labelSlice } from '../src/PackedRadixTree/strings.js'
import { emitSubtree } from '../src/PackedRadixTree/stringEmit.js'

function labelsMatch(heap, start, len, key, keyOff) {
  for (let i = 0; i < len; i++) {
    if (heap.charCodeAt(start + i) !== key.charCodeAt(keyOff + i)) return false
  }
  return true
}

function findEdge(tree, node, firstChar) {
  const end = tree.nodeEdgeOffset[node + 1]
  const heap = tree.labelHeap
  for (let ei = tree.nodeEdgeOffset[node]; ei < end; ei++) {
    if (heap.charCodeAt(tree.edgeLabelStart[ei]) === firstChar) return ei
  }
  return -1
}

function resolvePrefixWalk(tree, prefix) {
  if (prefix.length === 0) {
    return { node: 0, prefix: '' }
  }

  let node = 0
  let prefixStr = ''
  let pos = 0
  const heap = tree.labelHeap
  const n = prefix.length

  while (pos < n) {
    const ei = findEdge(tree, node, prefix.charCodeAt(pos))
    if (ei < 0) return null

    const start = tree.edgeLabelStart[ei]
    const len = tree.edgeLabelLength[ei]
    const remaining = n - pos

    if (remaining < len) {
      if (!labelsMatch(heap, start, remaining, prefix, pos)) return null
      prefixStr += labelSlice(heap, start, len)
      return { node: tree.edgeChild[ei], prefix: prefixStr }
    }

    if (!labelsMatch(heap, start, len, prefix, pos)) return null
    prefixStr += labelSlice(heap, start, len)
    pos += len
    node = tree.edgeChild[ei]
  }

  return { node, prefix: prefixStr }
}

/** Test/bench helper. Production code should use prefixRefs + termByIndex. */
export function* packedPrefixEntries(tree, prefix) {
  const start = resolvePrefixWalk(tree, prefix)
  if (start == null) return
  yield* emitSubtree(tree, start.node, start.prefix)
}
