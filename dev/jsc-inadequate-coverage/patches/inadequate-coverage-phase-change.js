//@ requireOptions("--useFTLJIT=false", "--useConcurrentJIT=false")
//@ skip if $memoryLimited
// Regression: phase-changing Map upsert must not wait for the generic
// osrExitCountForReoptimization (~100) InadequateCoverage budget before
// reoptimizing. After insert-only tier-up, update-heavy phase should recover
// once the loop reoptimization threshold is crossed.

function makeScorer() {
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
noInline(scorePostingDoc);

var results = new Map();
var inserts = 20000;
for (var i = 0; i < inserts; ++i)
    scorePostingDoc(results, i, 1 + (i & 3));

for (var i = 0; i < 50000; ++i)
    scorePostingDoc(results, i % inserts, 1 + (i & 3));

if (results.size !== inserts)
    throw new Error("bad size");
if (typeof scorePostingDoc.state.sink !== "number")
    throw new Error("bad sink");
