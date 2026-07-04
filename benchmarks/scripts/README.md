# Performance tracking scripts

Versioned history: [`../perf-history.jsonl`](../perf-history.jsonl) (one JSON line per recorded commit).

## After each significant commit

```bash
# 1. Commit first (clean tree on tracked files)
git commit -m "..."

# 2. Record (default 3 runs × 50 search iterations)
benchmarks/scripts/record-history.sh

# 3. Analyse
benchmarks/scripts/analyze-history.sh --vs-mutable
benchmarks/scripts/analyze-history.sh --changelog

# 4. If the delta is significant: copy the bullets into CHANGELOG.md
# 5. Version the history
git add benchmarks/perf-history.jsonl CHANGELOG.md
git commit -m "Record benchmark history at $(git rev-parse --short HEAD)."
```

`baselines/reference.json` (for `benchmark:diff`): update **after** the release
commit, on a clean tree — not in the same commit as the version bump:

```bash
make benchmark-record            # capture into latest.json
make bench-reference-update      # capture/promote reference.json + VS_REFERENCE.md + README pointer
git add benchmarks/baselines/reference.json
git commit -m "Refresh benchmark reference for 8.1.0."
```

> See [`../SCRIPTS.md`](../SCRIPTS.md) for the `bench:*` (profiled)
> vs `benchmark:*` (expert) boundary and the environment variable inventory.

Only modified **tracked** files block recording; `benchmarks/scripts/` may remain uncommitted.

## Commands

| Script | Role |
|--------|------|
| `record-history.sh` | Append a line to `perf-history.jsonl` (HEAD, clean tree) |
| `backfill-history.sh` | Replay missing commits since `db3707b` |
| `show-history.sh` | Quick table |
| `analyze-history.sh` | Extraction, comparison, CHANGELOG bullets, **frozen vs mutable** |

### Analysis

```bash
benchmarks/scripts/analyze-history.sh                    # timeline
benchmarks/scripts/analyze-history.sh --vs-mutable       # Frozen vs mutable MiniSearch
benchmarks/scripts/analyze-history.sh --compare db3707b 5305918
benchmarks/scripts/analyze-history.sh --changelog        # bullets vs previous commit in history
benchmarks/scripts/analyze-history.sh --changelog --commit 5305918
benchmarks/scripts/analyze-history.sh --retro            # milestones for retroactive CHANGELOG
```

## Post-commit hook (optional)

Copy [`post-commit.sample`](post-commit.sample) to `.git/hooks/post-commit` and adjust `RUNS`.

The hook **does not** fail the commit if the benchmark fails; it only logs.

## Frozen vs mutable metrics

Each scenario already measures both indexes on the same corpus:

- **Heap**: `totalResident` (`heapMb.mutableTotalResident` vs `heapMb.frozenTotalResident`, + `frozenVsMutableSavingPct`; heap-only detail in `heapMb.mutable` / `heapMb.frozen`)
- **Search**: `search[].mutableP50` vs `search[].frozenP50` (+ `frozenP50VsMutablePct`)
- **Score**: `scoreDrift` on `extreme-overflowFrequency` (tf > 255) — **0%** expected with adaptive freqs; legacy u8 may still drift

`analyze-history.sh --vs-mutable` summarises these columns on the latest recording.

## "Significant change" thresholds (CHANGELOG)

| Metric | Threshold |
|----------|--------|
| Frozen totalResident | ±5% |
| Total resident saving vs mutable | ±3 points |
| loadBinary | ±10% |
| freeze | ±15% |
| Search frozen vs mutable p50 | ±5 points |

Displayed with `--changelog`; adjust in `analyze-history.mjs` (`THRESHOLDS`).

## Starting point

First commit of the JSON suite: `db3707b` (*Flatten frozen postings and add benchmark baselines*).
