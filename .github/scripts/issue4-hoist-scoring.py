from pathlib import Path
import re

path = Path('src/scoring.ts')
source = path.read_text()


def sub_once(pattern: str, replacement: str, *, expected: int = 1) -> None:
    global source
    source, count = re.subn(pattern, replacement, source, flags=re.S | re.M)
    if count != expected:
        raise SystemExit(f'expected {expected} replacements, got {count}: {pattern[:100]!r}')


sub_once(
    r"function getDerivedTerm\(.*?\n\}\n\n(?=function scorePostingDoc\()",
    """function resolveDerivedTerm(
  derivedTerm: AggregateDerivedTerm,
  context: AggregateContext,
): string {
  if (typeof derivedTerm === 'string') return derivedTerm
  const resolveTermByIndex = context.resolveTermByIndex
  if (resolveTermByIndex == null) {
    throw new Error('FrozenMiniSearch: missing term resolver for indexed derived term')
  }
  return resolveTermByIndex(derivedTerm)
}

""",
)

sub_once(
    r"function scorePostingDoc\(.*?\n\}\n\n(?=function aggregateSegmentPostingList\()",
    """function scorePostingDoc(
  sourceTerm: string,
  resolvedDerivedTerm: string,
  field: string,
  fieldId: number,
  docId: number,
  termFreq: number,
  scoreMultiplier: number,
  context: AggregateContext,
  boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,
  bm25: Bm25FieldConstants,
  hoistedIdf: number,
  results: RawResult,
): void {
  const docBoost = boostDocumentFn
    ? boostDocumentFn(context.getExternalId(docId), resolvedDerivedTerm, context.getStoredFields(docId))
    : 1
  if (!docBoost) return

  const fieldLength = context.getFieldLength(docId, fieldId)
  const rawScore = calcBm25TfWithConstants(termFreq, fieldLength, bm25, hoistedIdf)
  const weightedScore = scoreMultiplier * docBoost * rawScore

  const result = results.get(docId)
  if (result) {
    result.score += weightedScore
    assignUniqueTerm(result.terms, sourceTerm)
    const match = getOwnProperty(result.match as Record<string, unknown>, resolvedDerivedTerm) as string[] | undefined
    if (match) {
      match.push(field)
    } else {
      result.match[resolvedDerivedTerm] = [field]
    }
  } else {
    results.set(docId, {
      score: weightedScore,
      terms: [sourceTerm],
      match: { [resolvedDerivedTerm]: [field] },
    })
  }
}

""",
)

sub_once(
    r"  const matchingFields = list\.length\n"
    r"  const bm25 = bm25FieldConstants\(bm25params, context\.avgFieldLength\[fieldId\]\)\n"
    r"  const hoistedIdf = bm25Idf\(matchingFields, context\.documentCount\)\n"
    r"  const \{ docIds, freqs, offset, length \} = list\n"
    r"  const derivedTermCache: \{ value\?: string \} = \{\}\n",
    """  const matchingFields = list.length
  const bm25 = bm25FieldConstants(bm25params, context.avgFieldLength[fieldId])
  const hoistedIdf = bm25Idf(matchingFields, context.documentCount)
  const scoreMultiplier = termWeight * termBoost * fieldBoost
  let resolvedDerivedTerm = typeof derivedTerm === 'string' ? derivedTerm : undefined
  const { docIds, freqs, offset, length } = list
""",
)

sub_once(
    r"    const matchingFields = postingList\.size\n"
    r"    const bm25 = bm25FieldConstants\(bm25params, context\.avgFieldLength\[fieldId\]\)\n"
    r"    const hoistedIdf = bm25Idf\(matchingFields, context\.documentCount\)\n"
    r"    const derivedTermCache: \{ value\?: string \} = \{\}\n",
    """    const matchingFields = postingList.size
    const bm25 = bm25FieldConstants(bm25params, context.avgFieldLength[fieldId])
    const hoistedIdf = bm25Idf(matchingFields, context.documentCount)
    const scoreMultiplier = termWeight * termBoost * fieldBoost
    let resolvedDerivedTerm = typeof derivedTerm === 'string' ? derivedTerm : undefined
""",
)

call_pattern = re.compile(
    r"^(?P<indent> +)scorePostingDoc\(\s*"
    r"sourceTerm, derivedTerm, field, fieldId, docId, (?P<freq>freqs\[index\]|termFreq),\s*"
    r"termWeight, termBoost, fieldBoost, matchingFields,\s*"
    r"context, boostDocumentFn, bm25, results, derivedTermCache,\s*"
    r"hoistedIdf,\s*\)",
    flags=re.S | re.M,
)


def replace_call(match: re.Match[str]) -> str:
    indent = match.group('indent')
    freq = match.group('freq')
    return (
        f"{indent}if (resolvedDerivedTerm === undefined) {{\n"
        f"{indent}  resolvedDerivedTerm = resolveDerivedTerm(derivedTerm, context)\n"
        f"{indent}}}\n"
        f"{indent}scorePostingDoc(\n"
        f"{indent}  sourceTerm, resolvedDerivedTerm, field, fieldId, docId, {freq},\n"
        f"{indent}  scoreMultiplier, context, boostDocumentFn, bm25, hoistedIdf, results,\n"
        f"{indent})"
    )


source, call_count = call_pattern.subn(replace_call, source)
if call_count != 3:
    raise SystemExit(f'expected 3 scorePostingDoc call replacements, got {call_count}')

if 'derivedTermCache' in source or 'getDerivedTerm(' in source:
    raise SystemExit('stale derived-term hot-path code remains after transform')

path.write_text(source)
