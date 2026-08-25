// Case 2: almost never takes the "update" branch — only once mid-run.
// Aggressive InadequateCoverage reopt could still jettison; measure compile churn.
var N = 100000;
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
for (var i = 0; i < N; i++) {
  // Nearly always insert-new; only one update at the midpoint.
  var id = (i === (N >> 1)) ? 0 : (i + 1);
  score(results, id, 1 + (i & 3));
}
console.log("RARE_ONCE sink=" + score.state.sink + " size=" + results.size);
