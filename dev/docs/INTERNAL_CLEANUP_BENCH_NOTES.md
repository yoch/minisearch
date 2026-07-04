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

## Session optimisation freeze — `acdefc9` (2026-07-03)

**Objectif** : optimiser `parseSnapshotIndex` / shell freeze sans régression compatibilité.  
**Harness** : `benchmarks/scripts/freeze-ab-compare.mjs` (`--mode=baseline|paired|compare`), `profile-freeze.mjs`, `capture-freeze-compare.mjs`.

### Baseline step0 (15 runs, ordre séquentiel)

| Scénario | Médiane freeze |
|----------|----------------|
| extreme-giantVocabulary | 343.85 ms |
| denseNumericIds-100k | 714.95 ms |
| docIdUint16Boundary-65536 | 527.85 ms |

Capture : `benchmarks/baselines/latest-freeze-step0.json`.

### Profil hotspot (step0, 25 iter)

| Scénario | parseSnapshotIndex | freezeImport | part parse |
|----------|-------------------|--------------|------------|
| giant | 160 ms | 245 ms | 78.6 % |
| dense | 504 ms | 709 ms | 78.6 % (shell ~165 ms) |
| docId65536 | 239 ms | 286 ms | 74.7 % |

**Conclusion profil** : `parseSnapshotIndex` domine ; shell `fieldLength` visible sur dense mais secondaire vs parse.

### Piste A — présizing accumulateur (`estimateSnapshotPostingCount`)

Pré-scan `Object.keys` sur l’index pour passer `estimatedTotalPostings` à `IncrementalPostingsAccumulator`.

| Mesure | giant | dense | docId |
|--------|-------|-------|-------|
| A/B apparié 15 runs (traitement vs `.worktrees/freeze-control`) | **+18.3 %** | **+24.4 %** | **+25.1 %** |

Capture : `benchmarks/baselines/latest-freeze-capacity-paired.json`.

**Verdict piste A** : **NOT VERIFIED** — le pré-scan coûte plus que les réallocations évitées ; régression nette en paired.

### Piste B — shell `fieldLength` via `activeShortIds`

Itération sur `activeShortIds` + passe validation clés orphelines (messages d’erreur inchangés).

| Mesure | giant | dense | docId |
|--------|-------|-------|-------|
| A/B apparié 15 runs | −0.0 % | +0.4 % | −3.2 % |

Capture : `benchmarks/baselines/latest-freeze-shell-paired.json`.

**Verdict piste B** : **NOT VERIFIED** — neutre ; pas de gain ≥5 % sur deux scénarios.

### Validation finale

- `capture-freeze-compare.mjs --runs=7` : OK (pas de contradiction harness migrate).
- Tests : `fromMiniSearch.test.js`, `incrementalPostings.test.js` — 65/65 OK.
- **Aucun changement code retenu** (revert `fromMiniSearch.ts`).

### Verdict session

**NOT VERIFIED** — aucune piste ne satisfait les critères d’acceptation (≥8–10 % sur un scénario majeur ou ≥5 % sur deux, sans régression >5 %).

**Pistes reportées** (hors scope mesuré ici) : fast path `trustedSource`, fusion passes shell `documentIds`/`storedFields`, réduction allocations dans la triple boucle term/field/docId sans affaiblir validations `fromJSON`.

---

## Non-adoptions natives — primitives JS modernes (2026-07-04)

Ces primitives restent hors produit tant qu'un benchmark dédié ne prouve pas un gain net sans perte de compatibilité :

- `ResizableArrayBuffer` / `ArrayBuffer.resize()` : intéressant pour les colonnes growables, mais non retenu sans spike isolé. Le produit garde les `TypedArray` classiques + réallocation explicite pour préserver `node >=20`, browser build et comportement mémoire prévisible.
- `Intl.Segmenter` : non équivalent au tokenizer MiniSearch (`SPACE_OR_PUNCTUATION` + `processTerm`) ; ne pas l'utiliser comme remplacement du tokenizer par défaut sans contrat de parité explicite.
- `scheduler.yield()` : ne remplace pas `setTimeout(0)` dans `addAllAsync` sans fallback, car la disponibilité browser reste moins large que le reste de l'API publique.

Un spike éventuel doit rester côté `benchmarks/` ou `dev/`, interdit dans le graphe produit tant que les critères suivants ne sont pas satisfaits : gain freeze/import Divina et dense, pas de hausse bundle, pas de hausse peak RAM, compat runtime documentée.

---

## Session optimisation freeze 2 — `acdefc9` (2026-07-03)

**Politique** : validation relaxée (sûreté minimale hostiles, contrat MiniSearch courant sur le hot path).

**Changements retenus** :
- `parseIntegerKeyFast` + `readPostingFrequency` sur la triple boucle index.
- Séparation `accumulateSnapshotIndexV1` / `V2` (plus de test `serializationVersion` par field en v2).
- Suppression checks producteur chauds : `seenTerms`, `assertRecord` par terme/field, messages contextuels détaillés.
- Harness `freeze-ab-compare.mjs` : deltas pairés par run, défaut contrôle `.worktrees/freeze-control`.
- `profile-freeze.mjs` : sous-phases `accumulateIndex`, `assembleTrusted/Untrusted`.
- `profile-accumulator-growth.mjs` : instrumentation realloc colonnes growables.

### Harness A/A (15 runs, même commit)

| Scénario | Δ médian paired |
|----------|-----------------|
| giant | +4.2 % |
| dense | +3.1 % |
| docId | +3.8 % |

Bruit harness ~3–4 % ; acceptable pour expérimentation.

### A/B apparié optimisé vs contrôle (15 runs × 2 captures)

| Scénario | Δ médian run 1 | Δ médian run 2 |
|----------|----------------|----------------|
| giant | **−14.3 %** (−40 ms) | **−15.6 %** |
| dense | **−20.7 %** (−110 ms) | **−21.9 %** |
| docId | **−18.1 %** (−67 ms) | **−14.1 %** |

Captures : `latest-freeze2-paired.json`, `latest-freeze2-paired-confirm.json`.

### Profil post-optim (p50, 25 iter)

| Scénario | accumulate | packTerms | freezeImport | part accumulate+pack |
|----------|------------|-----------|--------------|----------------------|
| giant | ~82 ms | ~51 ms | ~195 ms | ~81 % |
| dense | ~146 ms | ~84 ms | ~331 ms | ~71 % |
| docId | ~95 ms | ~58 ms | ~212 ms | ~70 % |

Gain concentré dans `accumulateIndex` (walk parse relaxé).

### Accumulateur — croissance sans pré-scan

| Scénario | postings | growEvents | bytesCopied/posting |
|----------|----------|------------|---------------------|
| giant | 200k | 42 | 9.2 |
| dense | 300k | 46 | 15.7 |
| docId | 262k | 42 | 7.0 |

**Verdict accumulateur** : copies non négligeables mais pré-scan rejeté en session 1 ; pas de prototype chunked retenu.

### Plafond trusted assemble

Overhead validation `assembleUntrusted − assembleTrusted` : **~1.4–2.7 ms** seulement. Le gain ne vient pas du trusted assemble.

### Validation

- `capture-freeze-compare.mjs --runs=7` : OK
- Tests : `fromMiniSearch`, `incrementalPostings`, `toMiniSearch`, `indexing-parity` — OK
- `make lint` : OK
- Tests hostiles index : messages assouplis (politique documentée)

### Verdict session 2

**VERIFIED** — gain reproductible ≥14 % sur les trois scénarios majeurs, confirmé en double capture paired, gain visible dans `accumulateIndex`, parité et layouts stables.

### Pistes post-commit (`2d7204f`)

| Piste | Résultat |
|-------|----------|
| `DEFAULT_CAPACITY=128` (sans pré-scan) | **NOT VERIFIED** — dense +4.1 %, giant/docId ~−2 % |
| Shell `parseIntegerKeyFast` | **NOT VERIFIED** — neutre (−0.4 % à +0.7 %) |
| Trusted assemble (famille 4) | **NOT VERIFIED** — ~2 ms seulement |
| Chunked growables | **Non poursuivi** — copies élevées mais pré-scan toujours exclu |

**Conclusion** : session close ; le levier principal était le parse index relaxé. Worktree contrôle `.worktrees/freeze-control` pointé sur `2d7204f` pour futures expériences.

---
