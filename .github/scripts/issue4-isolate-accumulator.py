from pathlib import Path

path = Path('src/scoring.ts')
source = path.read_text()

old = """  const result = results.get(docId)\n  if (result) {\n    result.score += weightedScore\n    assignUniqueTerm(result.terms, sourceTerm)\n    const match = getOwnProperty(result.match as Record<string, unknown>, resolvedDerivedTerm) as string[] | undefined\n    if (match) {\n      match.push(field)\n    } else {\n      result.match[resolvedDerivedTerm] = [field]\n    }\n  } else {\n    results.set(docId, {\n      score: weightedScore,\n      terms: [sourceTerm],\n      match: { [resolvedDerivedTerm]: [field] },\n    })\n  }\n"""
new = """  accumulateScoredResult(\n    results, docId, weightedScore, sourceTerm, resolvedDerivedTerm, field,\n  )\n"""

if source.count(old) != 1:
    raise SystemExit(f'expected one accumulation block, got {source.count(old)}')
source = source.replace(old, new, 1)

marker = "function scorePostingDoc(\n"
helper = """function accumulateScoredResult(\n  results: RawResult,\n  docId: number,\n  weightedScore: number,\n  sourceTerm: string,\n  resolvedDerivedTerm: string,\n  field: string,\n): void {\n  const result = results.get(docId)\n  if (result) {\n    result.score += weightedScore\n    assignUniqueTerm(result.terms, sourceTerm)\n    const match = getOwnProperty(result.match as Record<string, unknown>, resolvedDerivedTerm) as string[] | undefined\n    if (match) {\n      match.push(field)\n    } else {\n      result.match[resolvedDerivedTerm] = [field]\n    }\n  } else {\n    results.set(docId, {\n      score: weightedScore,\n      terms: [sourceTerm],\n      match: { [resolvedDerivedTerm]: [field] },\n    })\n  }\n}\n\n"""

if source.count(marker) != 1:
    raise SystemExit(f'expected one scorePostingDoc marker, got {source.count(marker)}')
source = source.replace(marker, helper + marker, 1)

path.write_text(source)
