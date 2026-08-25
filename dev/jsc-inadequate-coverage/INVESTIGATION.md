# Investigation: JSC `InadequateCoverage` reoptimization policy

**Status:** heuristic suboptimal (not a clear correctness bug)  
**Date:** 2026-08-25  
**Bun under test:** `1.4.1-canary.1+11fb73032`  
**Embedded WebKit:** `cb61607f1a4bae79d7701965062634dee9efb349` (oven-sh/WebKit merge of upstream `8c4fd56347`)  
**Standalone `jsc` baseline binary:** Bun WebKit release tarball `autobuild-cb61607f1a4bae79d7701965062634dee9efb349`  
**Upstream WebKit HEAD consulted:** `396f000caabcc215d7cce0ffc5f5663352812a38`

Downstream Bun report: https://github.com/oven-sh/bun/issues/40477

---

## 1. Verdict (short)

Observation of ~100 identical `InadequateCoverage` exits before reoptimization is **real JavaScriptCore behavior**, reproducible with standalone `jsc` (same WebKit SHA as Bun) once the reproducer avoids a jsc-shell-specific global `UnprofiledWatchpoint` confound.

`InadequateCoverage` / `ForceOSRExit` themselves are **intentional**. Treating those exits with the **generic** `osrExitCountForReoptimization` (100) budget is **underspecified / suboptimal** for deterministic late-coverage phase changes: every subsequent execution of the uncovered path exits until recompile, so waiting for ~100 identical failures is pure delay.

**Classification:** `heuristic suboptimal` (not `clear JSC bug`, not `no bug / expected` as ideal policy).

Candidate patch: reuse `osrExitCountForReoptimizationFromLoop` (default **5**) for `InadequateCoverage` in `handleExitCounts` + `operationTriggerReoptimizationNow`.

---

## 2. Independent reproduction

### 2.1 Bun (diagnostic DFG isolation)

With `BUN_JSC_useFTLJIT=false`, `BUN_JSC_useConcurrentJIT=false`, OSR tracing on:

| `osrExitCountForReoptimization` | `scorePostingDoc` InadequateCoverage failures | max `osrExitCounter` | phase-2 ms (example) |
| --- | ---: | ---: | ---: |
| 100 | 101 | 100 | ~12–27 |
| 1 | 2 | 1 | ~5–7 |
| 1000 | 1001 | 1000 | ~70–197 |

Exit count tracks the configured threshold almost exactly. Jettison reason when it finally fires: `OSRExit`.

### 2.2 Standalone `jsc` (same WebKit SHA) — critical pitfall

Naïve port of the Bun reproducer to `jsc` **does not** show the 100-exit churn. Root cause of the false negative:

```
Jettisoning … due to UnprofiledWatchpoint, Write to sink in Object: … global …
```

Writing the global `sink` in the update branch fires a structure watchpoint on the jsc shell global object and jettisons DFG after **one** exit — masking the reoptimization-threshold issue.

### 2.3 Fixed standalone reproducer

Keep mutable state off the global object (closure/`state` object). Then pure `jsc` matches Bun:

| threshold | failures | max counter | phase-2 ms | jettison |
| ---: | ---: | ---: | ---: | --- |
| 100 | 101 | 100 | 12.97 | `OSRExit` |
| 1 | 2 | 1 | 5.84 | `OSRExit` |
| 1000 | 1001 | 1000 | 70.84 | `OSRExit` |

Files: `benchmarks/01-phase-change.js` (and Bun twin `*.bun.js`).

**Conclusion:** this is **JSC**, not a Bun-only artifact. Bun merely makes the global-watchpoint confound less likely (module scope / different global object shape).

---

## 3. Exact JSC code path

### 3.1 Why `ForceOSRExit` / `InadequateCoverage` exist

| Step | File | Symbol |
| --- | --- | --- |
| Empty value profile → give up compiling that bytecode | `Source/JavaScriptCore/dfg/DFGByteCodeParser.cpp` | `ByteCodeParser::getPrediction()` — if `getPredictionWithoutOSRExit() == SpecNone`, `addToGraph(ForceOSRExit)` |
| Comment on intent | same | “We have no information about what values this node generates. Give up on executing this code, since we're likely to do more damage than good.” |
| Prune after ForceOSRExit | same | `ByteCodeParser::pruneUnreachableNodes()` |
| DFG lowers ForceOSRExit | `dfg/DFGSpeculativeJIT64.cpp` | `case ForceOSRExit: terminateSpeculativeExecution(InadequateCoverage, …)` |
| FTL lowers ForceOSRExit | `ftl/FTLLowerDFGToB3.cpp` | `compileForceOSRExit()` → `terminate(InadequateCoverage)` |
| Exit kind enum | `bytecode/ExitKind.h` | `InadequateCoverage` — “ended up in code that didn't have profiling coverage” |
| Node docs | `dfg/DFGNodeType.h` | `ForceOSRExit` — “pseudo-terminal… execution should fall out of DFG… but continue in a different compiler” |

So emitting `ForceOSRExit` for uncovered bytecode is **deliberate and sound**.

### 3.2 How exits are counted and when reoptimization happens

| Step | File | Symbol |
| --- | --- | --- |
| Exit stub bookkeeping | `dfg/DFGOSRExit.cpp` | calls `handleExitCounts` |
| Increment + threshold check | `dfg/DFGOSRExitCompilerCommon.cpp` | `handleExitCounts()` |
| May-jettison gate | `bytecode/ExitKind.cpp` | `exitKindMayJettison` — `InadequateCoverage` **is** countable (only `ExceptionCheck` / `GenericUnwind` are not) |
| Default thresholds | `runtime/OptionsList.h` | `osrExitCountForReoptimization = 100`, `osrExitCountForReoptimizationFromLoop = 5` |
| Threshold helpers | `bytecode/CodeBlock.cpp` | `exitCountThresholdForReoptimization()`, `…FromLoop()`, `shouldReoptimizeNow()`, `shouldReoptimizeFromLoopNow()` |
| Actual jettison decision | `dfg/DFGOperations.cpp` | `operationTriggerReoptimizationNow()` — requires `shouldReoptimizeNow()` **or** stuck-in-loop (`shouldReoptimizeFromLoopNow()` plus loop heuristics) |
| Retry backoff | `bytecode/CodeBlock.cpp` | `adjustedExitCountThreshold()` doubles thresholds per `reoptimizationRetryCounter` |

**Important:** `DidTryToEnterInLoop` on the **outermost** CodeBlock does **not** select the FromLoop threshold inside `handleExitCounts`. That flag is only consulted for **inlined** frames’ executables. Outermost call-entry exits (our pattern: every call re-enters DFG, hits `ForceOSRExit`, exits) therefore use the **100** budget even when the function was OSR-entered from a loop.

### 3.3 Why “100” appears

There is **no** InadequateCoverage-specific threshold. `InadequateCoverage` shares the generic countable-exit path. The constant 100 is the long-standing default for `osrExitCountForReoptimization` (OptionsList), chosen as a general speculation-failure hysteresis — not documented as specific to incomplete profiling.

`osrExitCountForReoptimizationFromLoop = 5` already encodes “we keep failing while hot in a loop → adapt faster.”

---

## 4. Is the current policy intentional / reasonable?

### Intentional parts

- Not compiling unprofiled bytecode into speculative DFG (`ForceOSRExit`) — yes, intentional and desirable.
- Counting exits and requiring hysteresis before jettison — yes, intentional to avoid compile storms / oscillation.

### Questionable part

Once `InadequateCoverage` fires on a path that stays hot, failure is **deterministic** until recompile. Paying ~100 full OSR exits is not “waiting to see if the speculation was transient”; it is delaying the only correct response (baseline profiling + reoptimize).

Risks of more aggressive reopt (evaluated):

| Risk | Assessment |
| --- | --- |
| Cold branch hit once | Still need several exits (FromLoop default 5 → effectively 6 with `BelowOrEqual`) before jettison; single cold hit should not storm. |
| Phase oscillation A↔B | Proxied by lowering global threshold to 5 on `03-oscillate.js`: still benefits (~15 ms → ~8.4 ms median), exit count stays at 6 — no compile storm observed in this harness. |
| Multiple uncovered blocks | `04-multi-uncovered.js`: thr=100 → 703 exits / ~50 ms; thr=5 → 38 exits / ~8–21 ms. Better overall; some variance. |
| Cold insert-only | No InadequateCoverage exits; thr=100 vs 5 indistinguishable (~20 ms). |
| FTL masking | `06-phase-change-ftl.js` with FTL **on**: thr=100 ~20.2 ms vs thr=5 ~13.9 ms — still material. |

---

## 5. Alternatives (A–E)

| Option | Idea | Pros | Cons | Choice |
| --- | --- | --- | --- | --- |
| A | Immediate reopt on first InadequateCoverage | Fastest phase adapt | Cold hit / storm risk higher | Rejected as default |
| B | New option `osrExitCountForReoptimizationFromInadequateCoverage` | Explicit knob | New surface; not required if FromLoop fits | Optional later |
| **C / B-lite** | **Reuse FromLoop threshold (5) for InadequateCoverage** | Minimal; reuses existing policy; matches “deterministic repeated failure” | Couples to FromLoop default | **Selected** |
| C weight | Add N to counter per InadequateCoverage | Single site possible | Magic weight; less readable | Viable alt |
| D | Explicit “needs reprofile” CodeBlock flag | Clearest semantics | Larger change | Future |
| E | Delay tier-up when ForceOSRExit present | Prevents problem | Punishes all partially covered functions | Too broad |

---

## 6. Candidate patch

Files (same on Bun WebKit `cb61607f…` and upstream HEAD `396f000c…`):

1. `Source/JavaScriptCore/dfg/DFGOSRExitCompilerCommon.cpp` — `handleExitCounts`: if `exit.m_kind == InadequateCoverage`, load `exitCountThresholdForReoptimizationFromLoop()` into the comparison register.
2. `Source/JavaScriptCore/dfg/DFGOperations.cpp` — `operationTriggerReoptimizationNow`: also jettison when `exit->m_kind == InadequateCoverage && shouldReoptimizeFromLoopNow()`.

Both sites must change: the JIT stub decides when to **call** the operation; the operation decides whether to **jettison**.

Patch file: `patches/0001-Reoptimize-sooner-on-InadequateCoverage-OSR-exits.patch`  
Stress sketch: `patches/inadequate-coverage-phase-change.js`

**Note:** Building oven-sh/WebKit with `-DUSE_BUN_JSC_ADDITIONS=OFF` fails on ungated Bun symbols in `ErrorInstance.cpp`. Patched rebuild uses `USE_BUN_JSC_ADDITIONS=ON`. Upstream Apple WebKit HEAD accepts the same two-hunk change cleanly.

---

## 7. Benchmark methodology & results

### 7.1 Fair A/B (same local toolchain)

Built `jsc` from oven-sh/WebKit `cb61607f…` with `PORT=JSCOnly`, `Release`, `USE_BUN_JSC_ADDITIONS=ON`. Compared unpatched vs patched binaries by rebuilding only the two touched translation units. `useConcurrentJIT=false`, 7 fresh-process reps, medians.

| Case | FTL | unpatched median | patched median | exits | Δ time |
| --- | --- | ---: | ---: | --- | ---: |
| 01 phase-change | off | 13.749 ms | **6.383 ms** | 101→6 | **−53.6%** |
| 06 phase-change | on | 21.379 ms | **14.364 ms** | 101→6 | **−32.8%** |
| 03 oscillate | off | 18.265 ms | **8.939 ms** | 101→6 | **−51.1%** |
| 04 multi-uncovered | off | 54.236 ms | **6.927 ms** | 703→38 | **−87.2%** |
| 05 cold insert | off | 22.317 ms | 25.589 ms | 0→0 | noise* |

\*Cold path has **zero** InadequateCoverage exits; 15-rep follow-up on the same toolchain: unpatched median 20.125 ms vs patched 21.975 ms (ranges heavily overlap: unpatched max 34.4, patched max 29.7). No evidence of a real cold regression from the patch.

Smoke confirmation on patched binary at **default** `osrExitCountForReoptimization=100`: phase-change jettisons after counter reaches **5** (`due to OSRExit`), matching FromLoop policy.

### 7.2 Proxy on Bun prebuilt `jsc` (threshold sweep)

Same benches on `autobuild-cb61607f…` prebuilt, varying global `osrExitCountForReoptimization` (proxy; patch is InadequateCoverage-only):

| Case | FTL | thr=100 | thr=5 | exits |
| --- | --- | ---: | ---: | --- |
| 01 phase-change | off | 22.739 ms | 5.903 ms | 101→6 |
| 06 phase-change | on | 20.175 ms | 13.894 ms | 101→6 |
| 03 oscillate | off | 14.794 ms | 8.427 ms | 101→6 |
| 05 cold insert | off | 19.976 ms | 19.917 ms | 0→0 |
| 04 multi-uncovered | off | 50.173 ms | 16.198 ms | 703→38 |

Raw logs under `results/`.

---

## 8. Risks / residual uncertainty

- Coupling to `osrExitCountForReoptimizationFromLoop` means changing that option also changes InadequateCoverage policy (likely desirable).
- No dedicated pre-existing WebKit bug found for this exact issue (bugs.webkit.org quicksearch + shallow history).
- Real FrozenMiniSearch win under normal Bun (~14.5% isolated multi-term with `reopt=1`) is **consistent** with this mechanism but is an application-level control, not a substitute for the engine fix.
- Upstream WebKit PR should still get a formal ChangeLog bug id and Apple-style review; this investigation ships the patch for that purpose without auto-opening WebKit's tracker.

---

## 9. Deliverables map

| Artifact | Path |
| --- | --- |
| This report | `dev/jsc-inadequate-coverage/INVESTIGATION.md` |
| Benches 1–6 | `dev/jsc-inadequate-coverage/benchmarks/` |
| Patch | `dev/jsc-inadequate-coverage/patches/0001-…patch` |
| Stress test sketch | `dev/jsc-inadequate-coverage/patches/inadequate-coverage-phase-change.js` |
| Baseline results | `dev/jsc-inadequate-coverage/results/` |

---

## 10. Recommended next steps for WebKit review

1. Land the two-hunk patch on a WebKit branch with ChangeLog.
2. Add `JSTests/stress/inadequate-coverage-phase-change.js` (no Bun dependency).
3. Run DFG/FTL stress + relevant layout tests.
4. Optional follow-up: dedicated option if FromLoop coupling is disliked.
5. Do **not** open an upstream PR automatically until patched-binary medians are attached; this repo PR carries the investigation + patch for review.
