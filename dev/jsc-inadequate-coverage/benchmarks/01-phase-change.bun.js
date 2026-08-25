var INSERTS = 20000;
var UPDATES = 200000;

function makeScorer() {
  // Keep mutable state in a closure / heap object that is not the global object,
  // so phase-2 updates do not invalidate DFG via global UnprofiledWatchpoint.
  var state = { sink: 0 };
  function scorePostingDoc(results, docId, termFreq) {
    var fieldLength = 1 + (docId & 7);
    var rawScore = termFreq * 2.2 / (termFreq + 1.2 * (0.3 + 0.7 * fieldLength));
    var weightedScore = 1.7 * rawScore;
    var result = results.get(docId);
    if (result) {
      result.score += weightedScore;
      state.sink ^= result.score | 0;
    } else {
      results.set(docId, { score: weightedScore });
    }
  }
  scorePostingDoc.state = state;
  return scorePostingDoc;
}

var scorePostingDoc = makeScorer();
var results = new Map();
for (var i = 0; i < INSERTS; i++)
  scorePostingDoc(results, i, 1 + (i & 3));
var start = performance.now();
for (var i = 0; i < UPDATES; i++)
  scorePostingDoc(results, i % INSERTS, 1 + (i & 3));
var elapsedMs = performance.now() - start;
if (results.size !== INSERTS)
  throw new Error("unexpected result size: " + results.size);
console.log("REPRO elapsed_ms=" + elapsedMs.toFixed(6) + " sink=" + scorePostingDoc.state.sink + " size=" + results.size);
