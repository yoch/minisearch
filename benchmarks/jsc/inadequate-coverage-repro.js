const env = typeof process !== 'undefined' && process.env ? process.env : {}
const INSERTS = Number(env.REPRO_INSERTS || 20000)
const UPDATES = Number(env.REPRO_UPDATES || 200000)
const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? () => performance.now()
  : () => Date.now()
const emit = typeof print === 'function' ? print : (...args) => console.log(...args)

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

// In the jsc shell, use one already-covered caller loop for both phases. This
// avoids a separate late-covered driver block while allowing the caller itself
// to tier up, matching an application host more closely. Keep scorePostingDoc
// out-of-line so its own DFG CodeBlock and exit counter remain observable.
function drive(count) {
  for (let i = 0; i < count; i++)
    scorePostingDoc(results, i % INSERTS, 1 + (i & 3))
}

let elapsedMs
if (typeof noInline === 'function') {
  noInline(scorePostingDoc)
  drive(INSERTS)
  const start = now()
  drive(UPDATES)
  elapsedMs = now() - start
} else {
  // Bun path: preserve the original two top-level phases exactly.
  for (let i = 0; i < INSERTS; i++)
    scorePostingDoc(results, i, 1 + (i & 3))

  const start = now()
  for (let i = 0; i < UPDATES; i++)
    scorePostingDoc(results, i % INSERTS, 1 + (i & 3))
  elapsedMs = now() - start
}

if (results.size !== INSERTS)
  throw new Error(`unexpected result size: ${results.size}`)

emit(`REPRO elapsed_ms=${elapsedMs.toFixed(3)} inserts=${INSERTS} updates=${UPDATES} sink=${sink}`)
