# Notes bench — nettoyage internals (2026-07-03)

Protocole par étape : `make build` → `make benchmark-record` → `bench:diff` vs capture précédente + vs `reference.json` → investigation si FAIL/warn.

Harness stable complémentaire : `pnpm exec tsx --expose-gc benchmarks/scripts/regression-investigation.mjs docIdBoundary`

---

## Baseline step 0 — `a82ce44` propre (aucun diff cleanup)

- Capture : `benchmarks/baselines/latest-step0.json` (2026-07-03)
- `bench:diff` vs `reference.json` : FAIL (écart historique d379e6f → a82ce44 + bruit ; voir investigation précédente)

---

## Step 1 — `ecd9ac0` gating early exit AND/AND_NOT

**Changement** : 3 lignes `queryEngineGating.ts` (sortie anticipée gate vide).

### `bench:diff` step1 vs step0

| Signal suite | Verdict |
|--------------|---------|
| FAIL `loadBinary` docIdUint16Boundary (+20.7 %, 37→45 ms) | **Bruit** — micro 5-run median **29 ms** ; gating ne touche pas `loadBinarySync` |
| WARN loadBinary giant vocab (+18 %) | **Bruit** — tableau ciblé −2.3 % sur même scénario |
| search exact docIdUint16Boundary 54.7→37.2 ms | **Bruit / possible gain** — micro-bench frozen **25.4 ms** stable ; early exit ne peut pas ralentir |

### Harness stable (step1 build)

```
regression-investigation docIdBoundary → frozen p50 25.4 ms, parité OK
loadBinarySync 5-run median 29.2 ms
```

**Conclusion step1** : aucune régression produit ; FAIL suite = instabilité inter-captures.

---

## Step 2 — `63b461d` extract `effectiveFirstBranchLength`

**Changement** : refactor structurel pur (même sémantique two-phase).

### `bench:diff` step2 vs step1

- **Warnings only** (pas de FAIL global).
- **Verdict** : **bruit** — pas de branche nouvelle.

---

## Step 3 — `337322e` `executeQuery` → `executeQueryWithRunOptions`

**Changement** : +1 indirection sur chaque `search()` prod.

### `bench:diff` step3 vs step2

| Signal | Suite | Investigation |
|--------|-------|---------------|
| FAIL loadBinary (+30 %, base 32 ms) | docId65535 load **39→35 ms** (amélioration) sur tableau ciblé — FAIL vient d'un autre scénario dans la suite | **Bruit** |
| WARN search exact docId +29–44 % | micro `regression-investigation` frozen **20.5 ms** (≤ step1 ~25 ms) | **Bruit suite** ; +1 frame JS non mesurable ici |

**Conclusion step3** : pas de régression search réelle ; indirection théorique négligeable.

---

## Step 4 — `78d2c22` `assembleFrozenInternal` partagé

**Changement** : déduplication test/prod (même corps `materialize` + `new Ctor`).

### `bench:diff` step4 vs step3

- **Warnings only** (pas de FAIL global).
- freeze/load **identiques** sur Divina / docId65535 entre captures successives (tableau ciblé).
- **Verdict** : **aucun effet mesurable** (attendu).

---

## Step 5 — `e7c8701` `fromMiniSearch` tri `activeShortIds`

**Changement** : tri in-place au validate ; remap dense sans copie+tri.

### `bench:diff` step5 vs step4

| Signal suite | Tableau ciblé | Verdict |
|--------------|---------------|---------|
| FAIL saveBinary giant vocab (+32 %) | 83→110 ms | **Bruit** — `fromJSON` freeze **235→207 ms** (≤) ; save/load ne dépendent pas du tri validate |
| FAIL loadBinary docId65535 (+41 %) | 32→46 ms | **Bruit** — freeze **353→349 ms** stable |
| FAIL loadBinary step5 vs step0 | +23–36 % load | **Bruit inter-captures** — step0→step5 micro search **24.3 ms** frozen (≤ ref 30 ms) |

### Final — step5 vs step0 (lot complet)

- `bench:diff` : **FAIL** loadBinary/saveBinary sur plusieurs scénarios.
- **Aucun FAIL freeze** au-delà du bruit (freezeMs stable ou en baisse).
- **Conclusion lot** : pas de régression produit ; échecs = instabilité suite.

### Final — step5 vs `reference.json` (`d379e6f`)

- **FAIL** attendu (écart historique 17 commits + bruit) — **ne pas interpréter comme ce lot**.

---

## Synthèse instabilité (constat)

| Phénomène | Preuve |
|-----------|--------|
| Même commit, captures à 30–45 min d'intervalle | loadBinary ±30–300 % sans changement code (step1, step3, step5) |
| Suite full vs harness ciblé | docId search suite 41–53 ms vs `regression-investigation` **20–25 ms** |
| Baselines < 10 ms | Seuils `%` explosent (+40–520 %) sur 1–3 ms de delta absolu |
| Scénarios contradictoires | giant vocab load **−29 %** puis **+23 %** entre captures consécutives |

### Pistes pour surmonter l'instabilité (à traiter hors ce lot)

1. **Diff incrémental** : toujours comparer `latest-stepN` → `latest-stepN+1` (fait ici) + harness stable si FAIL.
2. **Double capture** : 2× `benchmark-record` consécutifs ; ne flaguer que si les deux dégradent.
3. **Micro-harness par surface** : `regression-investigation.mjs` (search), timed `loadBinarySync` 5-run (load), `profile-freeze.mjs` (freeze).
4. **Assouplir policy** sous floor 10 ms : privilégier delta absolu ms (déjà partiellement en place) ou exiger `absDelta > 5 ms` **et** `%` pour FAIL.
5. **Re-baseline** : ~~promouvoir `latest-step5.json` → `reference.json` quand 1.7.0 est validé~~ **fait** — voir section ci-dessous.

---

## Re-baseline référence — `ed37568` (2026-07-03)

**Workflow** : `make bench-reference-update` (RUNS=3, profil `vs-reference`, 13 scénarios + heap v4).

| Champ | Ancienne ref (`d379e6f`) | Nouvelle ref (`ed37568`) |
|-------|--------------------------|--------------------------|
| `capturedAt` | 2026-07-02 | 2026-07-03 |
| `packageVersion` | 1.6.4 | 1.7.0 |
| `recordKind` | reference | reference-forced-dirty (arbre sale pendant capture) |
| docId65535 search p50 exact | ~41–53 ms (suite instable) | **32.96 ms** |
| docId65535 loadBinary | ~32–46 ms (swings) | **44.84 ms** |

**Validation post-promotion** :
- `make bench-diff` : **PASS** (0 % delta, latest ≡ reference)
- `regression-investigation docIdBoundary` : frozen p50 **26.2 ms**, parité OK

**Archives locales** : `benchmarks/baselines/latest-post-rebaseline.json` (copie de `latest.json`).

**Note** : l’écart historique vs `d379e6f` n’est plus actionnable ; les diffs futurs partent de cette référence.

---

## Commits du lot (ordre)

```
ecd9ac0 Short-circuit empty gates in AND_NOT collection and execution.
63b461d Extract effectiveFirstBranchLength for two-phase gate heuristics.
337322e Route executeQuery through executeQueryWithRunOptions entry point.
78d2c22 Share assembleFrozenInternal between product and test harness.
e7c8701 Sort activeShortIds during snapshot validation and reuse for dense remap.
9fcf9de Document per-step bench notes for internals cleanup lot.
ed37568 Add frozen postings doc id collection tests.
```

Captures archivées localement : `benchmarks/baselines/latest-step0.json` … `latest-step5.json` (gitignored).

---
