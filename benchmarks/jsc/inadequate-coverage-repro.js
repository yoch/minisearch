const INSERTS = Number(process.env.REPRO_INSERTS || 20000)
const UPDATES = Number(process.env.REPRO_UPDATES || 200000)

let sink = 0

function scorePostingDoc(results, docId, termFreq) {
  const fieldLength = 1 + (docId & 7)
  const rawScore = termFreq * 2.2 / (termFreq + 1.2 * (0.3 + 0.7 * fieldLength))
  const weightedScore = 1.7 * rawScore

  const result = results.get(docId)
  if (result) {
    result.score += weightedScore
    sink ^= result.score | 0
  } else {
    results.set(docId, { score: weightedScore })
  }
}

const results = new Map()

// Phase 1: train/tier-up scorePostingDoc while the existing-result branch is never taken.
for (let i = 0; i < INSERTS; i++) {
  scorePostingDoc(results, i, 1 + (i & 3))
}

// Phase 2: immediately flip to the previously uncovered branch.
const start = performance.now()
for (let i = 0; i < UPDATES; i++) {
  scorePostingDoc(results, i % INSERTS, 1 + (i & 3))
}
const elapsedMs = performance.now() - start

if (results.size !== INSERTS) throw new Error(`unexpected result size: ${results.size}`)
console.log(`REPRO elapsed_ms=${elapsedMs.toFixed(6)} sink=${sink} size=${results.size}`)
