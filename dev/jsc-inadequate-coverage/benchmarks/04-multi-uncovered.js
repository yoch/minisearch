// Case 4: several independent ForceOSRExit sites become hot in sequence.
var N = 30000;
function makeFn() {
  var state = { sink: 0 };
  function multi(mode, x) {
    // Each mode arm does different work; profile covers only mode==0 at tier-up.
    if (mode === 0) {
      state.sink ^= (x + 1) | 0;
      return x + 1;
    } else if (mode === 1) {
      state.sink ^= (x * 3) | 0;
      return x * 3;
    } else if (mode === 2) {
      state.sink ^= (x ^ 0x55) | 0;
      return x ^ 0x55;
    } else {
      state.sink ^= (x - 7) | 0;
      return x - 7;
    }
  }
  multi.state = state;
  return multi;
}
var multi = makeFn();
for (var i = 0; i < N; i++) multi(0, i);
var start = preciseTime();
for (var i = 0; i < N; i++) multi(1, i);
for (var i = 0; i < N; i++) multi(2, i);
for (var i = 0; i < N; i++) multi(3, i);
var ms = (preciseTime() - start) * 1000;
print("MULTI_UNCOVERED elapsed_ms=" + ms.toFixed(6) + " sink=" + multi.state.sink);
