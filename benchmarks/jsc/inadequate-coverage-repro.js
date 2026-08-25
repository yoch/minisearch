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

// The standalone jsc shell can optimize the top-level driver loops themselves.
// That adds an unrelated loop-OSR reoptimization signal and masks the generic
// InadequateCoverage threshold used by scorePostingDoc. JSC's test shell exposes
// noDFG(), so keep only the driver in Baseline/LLInt there. Bun does not expose
// noDFG(), and therefore continues to execute the original top-level-loop shape.
function insertPhase() {
  for (let i = 0; i < INSERTS; i++)
    scorePostingDoc(results, i, 1 + (i & 3))
}

function updatePhase() {
  for (let i = 0; i < UPDATES; i++)
    scorePostingDoc(results, i % INSERTS, 1 + (i & 3))
}

let elapsedMs
if (typeof noDFG === 'function') {
  noDFG(insertPhase)
  noDFG(updatePhase)
  insertPhase()
  const start = now()
  updatePhase()
  elapsedMs = now() - start
} else {
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
