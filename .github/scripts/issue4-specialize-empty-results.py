from pathlib import Path

path = Path('src/scoring.ts')
source = path.read_text()

marker = "function aggregateSegmentPostingList(\n"
helper = """function scorePostingDocNew(\n  sourceTerm: string,\n  derivedTerm: AggregateDerivedTerm,\n  field: string,\n  fieldId: number,\n  docId: number,\n  termFreq: number,\n  termWeight: number,\n  termBoost: number,\n  fieldBoost: number,\n  matchingFields: number,\n  context: AggregateContext,\n  boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,\n  bm25: Bm25FieldConstants,\n  results: RawResult,\n  derivedTermCache: { value?: string },\n  hoistedIdf?: number,\n): void {\n  const resolvedDerivedTerm = getDerivedTerm(derivedTerm, derivedTermCache, context)\n  const docBoost = boostDocumentFn\n    ? boostDocumentFn(context.getExternalId(docId), resolvedDerivedTerm, context.getStoredFields(docId))\n    : 1\n  if (!docBoost) return\n\n  const fieldLength = context.getFieldLength(docId, fieldId)\n  const rawScore = hoistedIdf !== undefined\n    ? calcBm25TfWithConstants(termFreq, fieldLength, bm25, hoistedIdf)\n    : calcBM25ScoreWithConstants(\n        termFreq, matchingFields, context.documentCount, fieldLength, bm25,\n      )\n  const weightedScore = termWeight * termBoost * fieldBoost * docBoost * rawScore\n\n  results.set(docId, {\n    score: weightedScore,\n    terms: [sourceTerm],\n    match: { [resolvedDerivedTerm]: [field] },\n  })\n}\n\n"""

if source.count(marker) != 1:
    raise SystemExit(f'expected one aggregateSegmentPostingList marker, got {source.count(marker)}')
source = source.replace(marker, helper + marker, 1)

needle = """  const { docIds, freqs, offset, length } = list\n  const derivedTermCache: { value?: string } = {}\n\n  if (allowedDocs != null && shouldSeekAllowedDocs(allowedDocs.size, length)) {\n"""
replacement = """  const { docIds, freqs, offset, length } = list\n  const derivedTermCache: { value?: string } = {}\n\n  // A fresh result map means every doc in this first segment is necessarily new.\n  // Keep that one-phase insertion workload away from the generic create/update scorer\n  // so its JIT profile starts only once result existence is naturally mixed.\n  if (results.size === 0 && !(allowedDocs != null && shouldSeekAllowedDocs(allowedDocs.size, length))) {\n    for (let i = 0; i < length; i++) {\n      const docId = readDocId(docIds, offset + i)\n      const termFreq = freqs[offset + i]\n      if (allowedDocs != null && !allowedDocs.has(docId)) continue\n\n      scorePostingDocNew(\n        sourceTerm, derivedTerm, field, fieldId, docId, termFreq,\n        termWeight, termBoost, fieldBoost, matchingFields,\n        context, boostDocumentFn, bm25, results, derivedTermCache,\n        hoistedIdf,\n      )\n    }\n    return\n  }\n\n  if (allowedDocs != null && shouldSeekAllowedDocs(allowedDocs.size, length)) {\n"""

if source.count(needle) != 1:
    raise SystemExit(f'expected one segment-loop insertion point, got {source.count(needle)}')
source = source.replace(needle, replacement, 1)

path.write_text(source)
