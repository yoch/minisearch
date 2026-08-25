// Case 3: alternate insert-heavy and update-heavy windows.
var WINDOW = 5000;
var ROUNDS = 20;
function makeScorer() {
  var state = { sink: 0 };
  function score(results, docId, termFreq) {
    var weightedScore = 1.7 * termFreq;
    var result = results.get(docId);
    if (result) {
      result.score += weightedScore;
      state.sink ^= result.score | 0;
    } else {
      results.set(docId, { score: weightedScore });
    }
  }
  score.state = state;
  return score;
}
var score = makeScorer();
var results = new Map();
var start = performance.now();
for (var r = 0; r < ROUNDS; r++) {
  if ((r & 1) === 0) {
    // insert-ish: unique ids
    for (var i = 0; i < WINDOW; i++)
      score(results, r * WINDOW + i, 1);
  } else {
    // update-ish: reuse previous window
    for (var i = 0; i < WINDOW; i++)
      score(results, (r - 1) * WINDOW + (i % WINDOW), 2);
  }
}
var ms = performance.now() - start;
console.log("OSCILLATE elapsed_ms=" + ms.toFixed(6) + " sink=" + score.state.sink + " size=" + results.size);
