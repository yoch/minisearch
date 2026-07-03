import { storedFieldsJsonBytes, storedFieldsSlotCount } from '../src/storedFieldsLayoutMetrics.js'

// Keep this aligned with FrozenPostingsLayout dense/sparse buffers.
function postingsTypedBytes(layout) {
  const allDocIdsBytes = layout.allDocIds.byteLength
  const allFreqsBytes = layout.allFreqs.byteLength
  if (layout.layout === 'dense') {
    const offsetsBytes = layout.denseOffsets.byteLength
    const lengthsBytes = layout.denseLengths.byteLength
    return {
      allDocIdsBytes,
      allFreqsBytes,
      offsetsBytes,
      lengthsBytes,
      totalTypedBytes: allDocIdsBytes + allFreqsBytes + offsetsBytes + lengthsBytes,
      slotCount: layout.termCount * layout.fieldCount,
    }
  }

  const offsetsBytes = layout.sparseOffsets.byteLength + layout.sparseTermStarts.byteLength
  const lengthsBytes = layout.sparseLengths.byteLength + layout.sparseFieldIds.byteLength
  return {
    allDocIdsBytes,
    allFreqsBytes,
    offsetsBytes,
    lengthsBytes,
    totalTypedBytes: allDocIdsBytes + allFreqsBytes + offsetsBytes + lengthsBytes,
    slotCount: layout.sparseFieldIds.length,
  }
}

/** Benchmark/test-only retained structure estimate for source and dist builds. */
export function frozenMemoryBreakdown(frozen) {
  const postingsStats = postingsTypedBytes(frozen._postings)
  const storedJson = storedFieldsJsonBytes(frozen._storedFields)
  const radixEst = frozen._index.packedByteLength()
  const idMapBytes = frozen._idLookup.mode === 'lazy-map' ? frozen._idLookup.mapEntryCount * 32 : 0

  const estimatedStructuredBytes
    = postingsStats.totalTypedBytes
      + frozen._fieldLengthMatrix.byteLength
      + frozen._avgFieldLength.byteLength
      + radixEst
      + storedJson
      + idMapBytes

  return {
    termCount: frozen.termCount,
    documentCount: frozen._documentCount,
    nextId: frozen._nextId,
    postings: {
      slotCount: postingsStats.slotCount,
      layout: frozen._postings.layout,
      docIdWidth: frozen._postings.docIdWidth,
      allDocIdsBytes: postingsStats.allDocIdsBytes,
      allFreqsBytes: postingsStats.allFreqsBytes,
      offsetsBytes: postingsStats.offsetsBytes,
      lengthsBytes: postingsStats.lengthsBytes,
      totalTypedBytes: postingsStats.totalTypedBytes,
    },
    termIndex: {
      nodeCount: frozen._index.packedNodeCount(),
      edgeCount: frozen._index.packedEdgeCount(),
      estimatedBytes: radixEst,
    },
    documents: {
      externalIdsSlots: frozen._externalIds.length,
      storedFieldsSlots: storedFieldsSlotCount(frozen._storedFields),
      idLookupMode: frozen._idLookup.mode,
      idToShortIdEntries: frozen._idLookup.mapEntryCount,
      fieldLengthMatrixBytes: frozen._fieldLengthMatrix.byteLength,
      avgFieldLengthBytes: frozen._avgFieldLength.byteLength,
      storedFieldsJsonBytes: storedJson,
    },
    estimatedStructuredBytes,
  }
}

/** Test-only access to the compact field-length matrix backing array. */
export function frozenFieldLengthMatrix(frozen) {
  return frozen._fieldLengthMatrix
}
