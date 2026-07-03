# Plan de rationalisation du bench tooling

Date d'adoption : 2026-06-30  
Statut : **actif** — moratoire en vigueur jusqu'à clôture de la phase 2

## Résumé

Le cœur produit (`src/`) est mature, testé et prêt pour la production. La dette de maintenance la plus coûteuse n'est plus dans le moteur de recherche, mais dans **l'outillage de benchmark** : `benchmarks/` pèse environ trois fois `src/`, et `package.json` expose **44 commandes** `bench:*` / `benchmark:*` au premier niveau.

Ce plan remplace l'audit du 2026-06-28. Il fixe une priorité unique : **déclarer un moratoire de croissance sur le bench tooling**, puis le réduire à une surface officielle de **6 à 8 commandes** documentées. Tout le reste passe en accès expert ou lab, sans alias npm de premier niveau.

---

## Diagnostic

| Zone | Taille approx. | Observation |
|------|--------------|-------------|
| `src/` | ~100 fichiers, ~14k lignes | Cœur stable ; frontière interne explicite (`frozenInternals`, `assert-internal-boundary`) |
| `benchmarks/` | ~107 fichiers, ~41k lignes | Plus gros que le produit ; risque cognitif disproportionné |
| `benchmarks/scripts/` | 31 fichiers | Calibration, profilage, investigation — souvent ponctuels |
| `package.json` scripts bench | 44 alias | Deux familles (`bench:*` profiled, `benchmark:*` expert) + sous-systèmes orthogonaux (packed-radix, medicaments, binary-format) |

**Ce qui fonctionne déjà :**

- [`benchmarks/SCRIPTS.md`](benchmarks/SCRIPTS.md) distingue `bench:*` (profiled via `cli.mjs`) et `benchmark:*` (expert, flags libres).
- [`benchmarks/scripts/README.md`](benchmarks/scripts/README.md) documente l'historique perf (`perf-history.jsonl`).
- CI Node 20/22/24, `verify-npm-pack`, garde-fous bundle public — **faits**, hors périmètre de ce plan.

**Ce qui reste ouvert :**

- La doc de frontière existe, mais **la surface exposée n'a pas diminué**.
- Chaque nouveau script ajoute un alias `package.json` + une cible `Makefile` + parfois une entrée README — coût cumulatif silencieux.
- Les scripts lab et les workflows quotidiens coexistent au même niveau d'API.

---

## Décision : moratoire de croissance

### En vigueur immédiatement

**Interdit sans exception préalable documentée dans une PR :**

1. Nouveau script dans `benchmarks/scripts/` ou nouveau `*.js` / `*.mjs` bench autonome.
2. Nouvel alias `bench:*` ou `benchmark:*` dans `package.json`.
3. Nouvelle cible `.PHONY` bench dans le `Makefile` (hors correction de bug sur l'existant).
4. Nouveau fichier baseline versionné dans `benchmarks/baselines/` (sauf promotion officielle de `latest.json` → `reference.json`).
5. Duplication d'un workflow déjà couvert par `cli.mjs` ou un script existant.

### Exceptions autorisées (une seule suffit)

| Motif | Procédure |
|-------|-----------|
| Régression bloquante en CI | Script minimal, **sans** alias npm ; invocation directe `node benchmarks/...` documentée dans la PR |
| Bug dans un script supported | Correctif ciblé, pas d'extension de périmètre |
| Rationalisation (phase 2) | Suppression ou fusion nette ; le diff doit **réduire** le nombre de commandes ou de fichiers |
| Sous-système packed-radix | Uniquement si le changement remplace un script existant à périmètre équivalent |

### Principe directeur

> **Aucune croissance de surface tant que la rationalisation n'a pas atteint la cible de 6–8 commandes officielles.**

Les optimisations produit (`src/`), les tests de parité et les correctifs MSv5 **ne sont pas** concernés par ce moratoire.

---

## Surface officielle cible (niveau `supported`)

**8 commandes maximum** — seules à rester dans `package.json`, `make help`, et le README principal.

| # | Commande | Rôle | Sous-jacent |
|---|----------|------|-------------|
| 1 | `pnpm bench` | Contrôle rapide local (dev profile) | `cli.mjs run --profile=dev --quick` |
| 2 | `pnpm bench:record` | Capture baseline courante | `cli.mjs record` (profile regression) |
| 3 | `pnpm bench:diff` | Comparer `latest.json` vs `reference.json` | `cli.mjs diff` |
| 4 | `pnpm bench:memory` | Mesure heap (suite isolée) | `runHeapSuite.mjs` |
| 5 | `pnpm bench:reference:update` | Rafraîchir référence + README perf | `record` + `promote-latest-to-reference` + `generate-readme-comparison` |
| 6 | `pnpm bench:history` | Enregistrer un point dans `perf-history.jsonl` | `record-history.sh` |
| 7 | `pnpm bench:micro` | Micro-bench CPU (Benchmark.js) | `micro/run.mjs` |
| 8 | `pnpm bench:build-peak` | Pic mémoire au build (go/no-go structurel) | `build-peak-heap.mjs` |

**Hors liste officielle mais conservées en Makefile sans alias npm** (invocation `make …` ou `node …` documentée dans [`benchmarks/SCRIPTS.md`](benchmarks/SCRIPTS.md) section *Advanced*) :

- `bench:medicaments-build-peak`, `bench:build-heap-profile`, `bench:readme` — utiles ponctuellement, pas quotidiennes.
- Toute la famille `benchmark:packed-radix*` — sous-système orthogonale, build rollup dédié.
- `benchmark:binary-format`, `benchmark:medicaments-indexes` — comparaisons spécialisées.

---

## Classification à trois niveaux

Chaque script bench existant doit être étiqueté **une fois** dans [`benchmarks/scripts/README.md`](benchmarks/scripts/README.md) (table de classification à ajouter en phase 2).

| Niveau | Définition | Exposition | Exemples |
|--------|------------|------------|----------|
| **supported** | Workflow quotidien, CI, ou release | Alias `pnpm bench:*` + `make help` | `cli.mjs`, `captureBaseline`, `diffBaseline`, `runHeapSuite`, `build-peak-heap`, `record-history` |
| **advanced** | Expert debug ; conservé, non encouragé | Makefile seulement, doc `SCRIPTS.md` | `compare.js` flags libres, `freq-adaptive-validate`, `calibrate-search-batches`, `targeted-failures`, packed-radix diff/record |
| **lab** | Investigation ponctuelle ; candidat suppression | Doc + chemin `node benchmarks/scripts/…` | `profile-freeze`, `profile-load-binary`, `regression-investigation`, `capture-freeze-compare`, `heap-snapshot-pair`, `analyze-freeze-pathological`, `and-gate-tuning`, `gate-posting-ratio` |

**Règle de promotion :** un script ne monte de `lab` → `advanced` → `supported` que s'il remplace un autre ou devient un gate CI explicite. Jamais l'inverse sans dépréciation.

---

## Inventaire actuel → actions

### Alias `package.json` à **retirer** (phase 2)

Doublons ou dé-promotion vers Makefile / doc uniquement :

```
benchmark:compare          → make benchmark-compare (advanced)
benchmark:record           → couvert par bench:record
benchmark:record:quick     → retiré ; RUNS=1 SEARCH_ITERATIONS=10 BENCH_WARMUP=20 benchmark:record
benchmark:record:search    → retiré ; BENCH_SEARCH_ONLY=1 benchmark:record
benchmark:record:memory    → retiré ; doublon bench:memory
benchmark:diff             → couvert par bench:diff
benchmark:diff:run           → advanced
benchmark:diff:search:run    → advanced
benchmark:baseline:update  → retiré ; remplacé par bench:reference:update
benchmark:history:analyze  → make benchmark-history-analyze
benchmark:history:vs-mutable → idem
benchmark:calibrate-batches
benchmark:validate:freq-adaptive
benchmark:and-gate-tuning
benchmark:gate-posting-ratio
benchmark:targeted
benchmark:targeted:compare
benchmark:profile-giant-prefix
benchmark:measure-scoring-steps
benchmark:finalize
benchmark:autosuggest
bench:run                  → doublon sémantique de bench
bench:readme               → chaîné dans bench:reference:update
bench:medicaments-build-peak
bench:build-heap-profile
```

Les `benchmark:packed-radix*` et `benchmark:binary-format` / `benchmark:medicaments-indexes` : **pas d'alias npm** ; cibles Makefile + section dédiée dans `SCRIPTS.md`.

### Scripts `benchmarks/scripts/` — tri lab

| Script | Niveau cible | Action |
|--------|--------------|--------|
| `build-peak-heap.mjs` | supported | Garder |
| `record-history.mjs` / `.sh` | supported | Garder |
| `promote-latest-to-reference.mjs` | supported | Garder (chaîné) |
| `generate-readme-comparison.mjs` | supported | Garder (chaîné) |
| `analyze-history.mjs` / `.sh` | advanced | Garder, pas d'alias npm |
| `freq-adaptive-validate.mjs` | advanced | Garder |
| `calibrate-search-batches.mjs` | advanced | Garder |
| `targeted-failures.mjs` | advanced | Garder |
| `medicaments-build-peak-heap.mjs` | advanced | Garder |
| `build-heap-profile.mjs` | advanced | Garder |
| `cpuBenchUtils.mjs` | (lib interne) | Garder — importé par d'autres scripts |
| `profile-freeze.mjs` | lab | Conserver fichier ; pas de Makefile sauf doc |
| `profile-load-binary.mjs` | lab | Idem |
| `profile-freeze-memory.mjs` | lab | Idem |
| `regression-investigation.mjs` | lab | Idem |
| `capture-freeze-compare.mjs` | lab | Idem |
| `heap-snapshot-pair.mjs` | lab | Idem |
| `analyze-freeze-pathological.mjs` | lab | Idem |
| `calibrate-gate-posting-ratio.mjs` | lab | Idem |
| `finalize-search.mjs` | lab | Idem |
| `autosuggest-search.mjs` | lab | Idem |
| `measure-scoring-steps.mjs` | lab | Idem |
| `profile-giant-prefix.mjs` | lab | Idem |
| `analyze-packed-radix-history.mjs` | advanced | Garder (packed-radix) |
| `seed-packed-radix-history.mjs` | advanced | Garder |
| `backfill-history.sh` / `show-history.sh` | advanced | Garder |
| `post-commit.sample` | doc | Garder (hook optionnel) |

### Baselines versionnées

- **Garder :** `reference.json`, fichiers packed-radix référencés par les scripts d'historique, `and-gate-tuning.json` (output lab).
- **Ne plus ajouter :** snapshots ponctuels type `p0-lite-*` (supprimés le 2026-06-30).
- **Gitignored (inchangé) :** `latest.json`, `latest-heap.json`, `packed-radix-latest.json`.

---

## Phases d'exécution

### Phase 1 — Moratoire (en cours)

- [x] Documenter la décision (ce fichier).
- [x] Ajouter une ligne dans [`CONTRIBUTING.md`](CONTRIBUTING.md) renvoyant vers ce plan pour toute PR touchant `benchmarks/`.
- [ ] Refuser en review tout nouvel alias bench sans dérogation.

**Durée :** jusqu'à fin phase 2.

### Phase 2 — Dé-promotion des alias (1–2 PRs)

1. Retirer de `package.json` tous les alias listés ci-dessus sauf les 8 `supported`.
2. Conserver les cibles `Makefile` pour `advanced` ; retirer les `.PHONY` des scripts `lab` devenus doc-only.
3. Mettre à jour `make help` pour n'afficher que les commandes supported + une section « Advanced (see SCRIPTS.md) ».
4. Ajouter la table de classification dans `benchmarks/scripts/README.md`.
5. Mettre à jour [`README.md`](README.md) (section perf) pour ne citer que les 8 commandes.

**Critère de clôture :** ≤ 8 scripts `bench:*` dans `package.json` ; 0 nouvelle commande `benchmark:*` au top level.

### Phase 3 — Consolidation lab (optionnelle, post-moratoire)

- Fusionner les scripts lab qui partagent `cpuBenchUtils.mjs` et le même corpus Divina.
- Archiver (supprimer) les scripts lab sans invocation depuis la doc ni l'historique git depuis 6 mois.
- Évaluer si `benchmarks/fuzzyQueryMutations.js` (re-export) peut disparaître au profit d'imports directs `testSupport/`.

**Ne pas lancer** avant clôture phase 2.

---

## Gouvernance PR

Checklist pour tout changement sous `benchmarks/` :

- [ ] Le moratoire est-il respecté (pas de nouvelle surface sans dérogation) ?
- [ ] Le script remplace-t-il ou fusionne-t-il l'existant ?
- [ ] Le niveau supported/advanced/lab est-il explicité ?
- [ ] Les tests bench (`pnpm test:benchmarks`) passent-ils ?
- [ ] `pnpm bench:diff` reste-t-il utilisable sans les alias retirés ?

---

## Critères de succès

| Métrique | Aujourd'hui | Cible |
|----------|-------------|-------|
| Alias `bench:*` + `benchmark:*` dans `package.json` | 44 | ≤ 8 |
| Nouveaux scripts bench / trimestre | non contrôlé | 0 (hors dérogation) |
| Temps pour un nouveau contributeur à trouver « la commande perf du jour » | élevé | ≤ 2 min (`pnpm bench`, `pnpm bench:diff`) |
| Scripts lab avec cible Makefile dédiée | ~12 | 0 (doc + `node …` seulement) |

---

## Pistes connexes (hors moratoire, non bloquantes)

Issues produit/maintenabilité identifiées lors de l'audit initial — **pas de chantier parallèle** tant que la phase 2 n'est pas close :

| Sujet | Statut | Note |
|-------|--------|------|
| Frontière API / internals | fait | `frozenInternals` + `assert-internal-boundary` |
| CI Node 20/22/24 | fait | |
| `verify-npm-pack` en CI | fait | |
| API héritée MiniSearch (`autoVacuum`, `logger`, etc.) | fait | `fromJson`, `autoVacuum`, et `logger` retirés ; diagnostics via exceptions |
| Adaptateur `fromMiniSearch` / `fromJSON` | partiel | Cadrage doc OK ; pas de sous-module dédié |
| Pic mémoire build (`fieldLengthData`) | évalué, non prioritaire | Mesure via `bench:build-peak` ; ROI jugé faible |
| Redécoupage `queryEngine.ts` / `scoring.ts` | reporté | Extraire seulement lors d'un changement fonctionnel |

---

## Ce qu'on ne fera pas

- Ajouter des scripts de calibration ou de profilage avant la fin de la phase 2.
- Introduire une couche d'abstraction générique (planner, registry, orchestrateur) au-dessus des scripts existants.
- Toucher au format binaire MSv5 ou aux invariants de parité pour « simplifier » le bench.
- Supprimer l'historique `perf-history.jsonl` ou les baselines de référence utilisées par CI / README.

---

## Conclusion

Le produit est prêt. Le risque principal est que l'outillage devienne plus large que le moteur. **Le moratoire est la priorité absolue** : geler la croissance, puis ramener l'API publique bench à huit commandes. Tout le reste — optimisations build, API compat MiniSearch, micro-tuning CPU — attend la clôture de cette rationalisation.
