var N = 200000;
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
for (var i = 0; i < N; i++)
  score(results, i, 1 + (i & 3));
var ms = performance.now() - start;
console.log("COLD_INSERT elapsed_ms=" + ms.toFixed(6) + " sink=" + score.state.sink + " size=" + results.size);
