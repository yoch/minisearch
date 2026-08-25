# JSC InadequateCoverage investigation

Investigation and candidate WebKit/JSC patch for deterministic
`InadequateCoverage` OSR-exit churn on phase-changing hot paths.

See [INVESTIGATION.md](./INVESTIGATION.md) for the full write-up.

## Quick facts

- Confirmed on standalone `jsc` (WebKit `cb61607f…`), not Bun-only.
- Naive `jsc` ports can be masked by global `UnprofiledWatchpoint` on `sink`.
- Candidate fix: use `osrExitCountForReoptimizationFromLoop` (default 5) for `InadequateCoverage`.
- Fair local A/B: phase-change DFG **−53.6%**, FTL **−32.8%**, cold path unchanged within noise.

## Layout

- `benchmarks/` — adversarial microbenchmarks (jsc + `.bun.js` twins)
- `patches/` — WebKit patch + stress-test sketch + ChangeLog fragment
- `results/` — raw logs and median tables
