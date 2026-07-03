import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../dist/es/index.js'
import {
  frozenFromMiniSearch,
  frozenFromMiniSearchSnapshot,
} from './harness/frozenSourceInternals.ts'
import { median, medianRound } from './benchStats.js'
import {
  gc,
  mbRound,
  frozenVsMutablePct,
  benchSearchPaired,
  searchIterationsForBatchEntry,
  timedMs,
  defaultBenchmarkRuns,
} from './benchmarkUtils.js'
import { applySearchBenchBatchesToScenarios, getSearchBenchBatchEntry } from './loadSearchBenchBatches.js'
import { benchSearchLevels, primaryLookupTerm } from './searchLevels.js'
import { ALL_SURFACES, computeSurfaceNeeds } from './framework/surfaces.mjs'
import { buildScenarioList, getScenarioById } from './scenarioRegistry.mjs'

export { buildScenarioList, getScenarioById }

const EXPENSIVE_SEARCH_PROBE_MS = 20
const VERY_EXPENSIVE_SEARCH_PROBE_MS = 50

function avgFrozenP50GainPct (search) {
  return search.length > 0
    ? Number((search.reduce((s, r) => s + (1 - r.frozenP50 / r.mutableP50), 0) / search.length * 100).toFixed(1))
    : 0
}

function prepareScenarioSearchIndexes (corpus, options) {
  gc()
  const mutableSearchIndex = new MiniSearch(options)
  mutableSearchIndex.addAll(corpus)
  gc()
  const frozenBuild = new MiniSearch(options)
  frozenBuild.addAll(corpus)
  const frozenSearchIndex = frozenFromMiniSearch(FrozenMiniSearch, frozenBuild, options)
  gc()
  return { mutableSearchIndex, frozenSearchIndex }
}

function benchScenarioSearch (mutableSearchIndex, frozenSearchIndex, queries, scenarioId, { searchLevels = false } = {}) {
  const search = []
  const levels = searchLevels ? {} : undefined

  for (const { label, q, opts, benchBatch } of queries) {
    if (!benchBatch) {
      throw new Error(`Missing benchBatch for search "${label}" (run benchmark:calibrate-batches)`)
    }
    const batchEntry = getSearchBenchBatchEntry(scenarioId, label)
    const iterations = searchIterationsForBatchEntry(batchEntry)
    const benchOpts = { batchSize: benchBatch }
    const paired = benchSearchPaired(
      mutableSearchIndex,
      frozenSearchIndex,
      q,
      opts,
      iterations,
      benchOpts,
    )
    search.push({
      label,
      query: q,
      batchSize: benchBatch,
      searchIterations: iterations,
      mutableP50: Number(paired.mutableP50.toFixed(4)),
      frozenP50: Number(paired.frozenP50.toFixed(4)),
      mutableP95: Number(paired.mutableP95.toFixed(4)),
      frozenP95: Number(paired.frozenP95.toFixed(4)),
      pairedRatioP50: paired.pairedRatioP50 == null
        ? null
        : Number(paired.pairedRatioP50.toFixed(4)),
      frozenP50VsMutablePct: frozenVsMutablePct(paired.mutableP50, paired.frozenP50),
      belowSearchFloor: paired.mutableP50 < 0.1,
    })

    if (searchLevels) {
      const term = primaryLookupTerm(mutableSearchIndex, q, opts)
      levels[label] = benchSearchLevels(
        mutableSearchIndex,
        frozenSearchIndex,
        q,
        opts,
        term,
        iterations,
        benchBatch,
      )
    }
  }
  gc()
  return {
    search,
    searchLevels: levels,
    avgFrozenP50GainPct: avgFrozenP50GainPct(search),
  }
}

function aggregatePairedLevel (levels) {
  const pairedRatioSamples = levels
    .map((l) => l.pairedRatioP50)
    .filter((v) => v != null)
  const mutableP50 = medianRound(levels.map((l) => l.mutableP50), 4)
  const frozenP50 = medianRound(levels.map((l) => l.frozenP50), 4)
  return {
    mutableP50,
    mutableP95: medianRound(levels.map((l) => l.mutableP95), 4),
    frozenP50,
    frozenP95: medianRound(levels.map((l) => l.frozenP95), 4),
    pairedRatioP50: pairedRatioSamples.length
      ? medianRound(pairedRatioSamples, 4)
      : null,
    frozenP50VsMutablePct: frozenVsMutablePct(mutableP50, frozenP50),
    batchSize: levels[0].batchSize,
  }
}

function aggregateFrozenLevel (levels) {
  return {
    frozenP50: medianRound(levels.map((l) => l.frozenP50), 4),
    frozenP95: medianRound(levels.map((l) => l.frozenP95), 4),
    batchSize: levels[0].batchSize,
  }
}

function aggregateSearch (runs) {
  const base = runs[0].search
  return base.map((row) => {
    const matches = runs.map((r) => r.search.find((x) => x.label === row.label)).filter(Boolean)
    const mutableP50 = medianRound(matches.map((m) => m.mutableP50), 4)
    const frozenP50 = medianRound(matches.map((m) => m.frozenP50), 4)
    const mutableP95 = medianRound(matches.map((m) => m.mutableP95), 4)
    const frozenP95 = medianRound(matches.map((m) => m.frozenP95), 4)
    const pairedRatioP50 = medianRound(
      matches.map((m) => m.pairedRatioP50).filter((v) => v != null),
      4,
    )
    return {
      label: row.label,
      query: row.query,
      batchSize: row.batchSize,
      searchIterations: row.searchIterations,
      mutableP50,
      frozenP50,
      mutableP95,
      frozenP95,
      pairedRatioP50: Number.isFinite(pairedRatioP50) ? pairedRatioP50 : null,
      frozenP50VsMutablePct: frozenVsMutablePct(mutableP50, frozenP50),
      belowSearchFloor: mutableP50 < 0.1,
    }
  })
}

function aggregateSearchLevels (runs) {
  const first = runs[0].searchLevels
  if (!first) return undefined
  const out = {}
  for (const label of Object.keys(first)) {
    const matches = runs.map((r) => r.searchLevels?.[label]).filter(Boolean)
    if (matches.length === 0) continue
    out[label] = {
      term: matches[0].term,
      L0: aggregatePairedLevel(matches.map((m) => m.L0)),
      L1: aggregateFrozenLevel(matches.map((m) => m.L1)),
      L2: aggregatePairedLevel(matches.map((m) => m.L2)),
    }
  }
  return out
}

function aggregateScoreDrift (runs) {
  const first = runs[0].scoreDrift
  if (!first) return undefined
  return first.map((row) => {
    const matches = runs.map((r) => (r.scoreDrift || []).find((x) => x.query === row.query)).filter(Boolean)
    const maxAbsScoreDelta = medianRound(matches.map((m) => m.maxAbsScoreDelta), 6)
    const maxRelScoreDeltaPct = medianRound(matches.map((m) => m.maxRelScoreDeltaPct), 2)
    const missingInFrozenTopK = Math.round(median(matches.map((m) => m.missingInFrozenTopK)))
    const topKOrderChanged = matches.some((m) => m.topKOrderChanged)
    return {
      query: row.query,
      topK: row.topK,
      maxAbsScoreDelta,
      maxRelScoreDeltaPct,
      missingInFrozenTopK,
      topKOrderChanged
    }
  })
}

function medianMetric (runs, pick, digits) {
  const values = runs.map(pick).filter((v) => v != null)
  return values.length ? medianRound(values, digits) : undefined
}

function medianIntMetric (runs, pick) {
  const value = medianMetric(runs, pick, 0)
  return value == null ? undefined : Math.round(value)
}

function savingPct (base, value) {
  return base != null && value != null && base > 0
    ? Number((100 * (1 - value / base)).toFixed(1))
    : undefined
}

function aggregateScenarioRuns (runs) {
  const base = runs[0]
  if (base.benchProfile === 'search' || (base.benchSurfaces?.length === 1 && base.benchSurfaces[0] === 'search')) {
    const search = aggregateSearch(runs)
    const searchLevels = aggregateSearchLevels(runs)
    return {
      id: base.id,
      name: base.name,
      documentCount: base.documentCount,
      fields: base.fields,
      storeFields: base.storeFields,
      benchProfile: 'search',
      benchSurfaces: base.benchSurfaces ?? ['search'],
      search,
      ...(searchLevels ? { searchLevels } : {}),
      summary: { searchFrozenP50AvgGainPct: avgFrozenP50GainPct(search) },
    }
  }

  if (!base.indexing) {
    return { ...base, search: aggregateSearch(runs), scoreDrift: aggregateScoreDrift(runs) }
  }

  const indexing = {
    addAllMs: medianMetric(runs, (r) => r.indexing.addAllMs, 2),
    toJSONMs: medianMetric(runs, (r) => r.indexing.toJSONMs, 2),
    freezeMs: medianMetric(runs, (r) => r.indexing.freezeMs, 2),
    fromDocumentsMs: medianMetric(runs, (r) => r.indexing.fromDocumentsMs, 2),
    jsonSerializeMs: medianMetric(runs, (r) => r.indexing.jsonSerializeMs, 2),
    saveBinaryMs: medianMetric(runs, (r) => r.indexing.saveBinaryMs, 2),
    binaryMagic: base.indexing.binaryMagic
  }

  const heapMutable = medianMetric(runs, (r) => r.heapMb?.mutable, 3)
  const heapFrozen = medianMetric(runs, (r) => r.heapMb?.frozen, 3)
  const heapMutableTotal = medianMetric(runs, (r) => r.heapMb?.mutableTotalResident, 3)
  const heapFrozenTotal = medianMetric(runs, (r) => r.heapMb?.frozenTotalResident, 3)
  const heapBuildMutableFreeze = medianMetric(runs, (r) => r.heapMb?.buildMutableFreeze, 3)
  const heapBuildFromDocuments = medianMetric(runs, (r) => r.heapMb?.buildFromDocuments, 3)
  const heapLoadJson = medianMetric(runs, (r) => r.heapMb?.loadJson, 3)
  const heapLoadBinary = medianMetric(runs, (r) => r.heapMb?.loadBinary, 3)
  const heapSavingPct = savingPct(heapMutableTotal, heapFrozenTotal)
  const heapOnlySavingPct = savingPct(heapMutable, heapFrozen)
  const buildHeapSavingPct = savingPct(heapBuildMutableFreeze, heapBuildFromDocuments)

  const diskJson = medianMetric(runs, (r) => r.diskMb?.json, 3)
  const diskBinary = medianMetric(runs, (r) => r.diskMb?.binary, 3)
  const diskSavingPct = savingPct(diskJson, diskBinary) ?? 0

  const loadJson = medianMetric(runs, (r) => r.loadMs?.json, 2)
  const loadBinary = medianMetric(runs, (r) => r.loadMs?.binary, 2)
  const loadSavingPct = savingPct(loadJson, loadBinary) ?? 0

  const memoryBreakdown = base.memoryBreakdown
    ? {
        termCount: base.memoryBreakdown.termCount,
        documentCount: base.memoryBreakdown.documentCount,
        nextId: base.memoryBreakdown.nextId,
        postings: {
          slotCount: base.memoryBreakdown.postings.slotCount,
          allDocIdsBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.postings.allDocIdsBytes),
          allFreqsBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.postings.allFreqsBytes),
          offsetsBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.postings.offsetsBytes),
          lengthsBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.postings.lengthsBytes),
          totalTypedBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.postings.totalTypedBytes)
        },
        termIndex: {
          nodeCount: base.memoryBreakdown.termIndex.nodeCount,
          edgeCount: base.memoryBreakdown.termIndex.edgeCount,
          estimatedBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.termIndex.estimatedBytes)
        },
        documents: {
          externalIdsSlots: base.memoryBreakdown.documents.externalIdsSlots,
          storedFieldsSlots: base.memoryBreakdown.documents.storedFieldsSlots,
          idToShortIdEntries: base.memoryBreakdown.documents.idToShortIdEntries,
          fieldLengthMatrixBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.documents.fieldLengthMatrixBytes),
          avgFieldLengthBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.documents.avgFieldLengthBytes),
          storedFieldsJsonBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.documents.storedFieldsJsonBytes)
        },
        estimatedStructuredBytes: medianIntMetric(runs, (r) => r.memoryBreakdown.estimatedStructuredBytes)
      }
    : undefined

  const search = base.search ? aggregateSearch(runs) : undefined
  const scoreDrift = base.scoreDrift ? aggregateScoreDrift(runs) : undefined
  const searchLevels = base.searchLevels ? aggregateSearchLevels(runs) : undefined

  return {
    id: base.id,
    name: base.name,
    documentCount: base.documentCount,
    fields: base.fields,
    storeFields: base.storeFields,
    benchSurfaces: base.benchSurfaces,
    indexing,
    ...(heapMutable != null && heapFrozen != null ? {
      heapMb: {
        mutable: heapMutable,
        frozen: heapFrozen,
        ...(heapMutableTotal != null && heapFrozenTotal != null ? {
          mutableTotalResident: heapMutableTotal,
          frozenTotalResident: heapFrozenTotal,
        } : {}),
        ...(heapBuildMutableFreeze != null && heapBuildFromDocuments != null ? {
          buildMutableFreeze: heapBuildMutableFreeze,
          buildFromDocuments: heapBuildFromDocuments,
          buildFromDocumentsVsMutableFreezeSavingPct: buildHeapSavingPct,
        } : {}),
        ...(heapLoadJson != null && heapLoadBinary != null ? {
          loadJson: heapLoadJson,
          loadBinary: heapLoadBinary,
        } : {}),
        ...(heapSavingPct != null ? { frozenVsMutableSavingPct: heapSavingPct } : {}),
        ...(heapOnlySavingPct != null ? { frozenVsMutableHeapOnlySavingPct: heapOnlySavingPct } : {}),
      },
    } : {}),
    ...(diskJson != null && diskBinary != null ? {
      diskMb: {
        json: diskJson,
        binary: diskBinary,
        binaryVsJsonSavingPct: diskSavingPct
      },
    } : {}),
    ...(loadJson != null && loadBinary != null ? {
      loadMs: {
        json: loadJson,
        binary: loadBinary,
        binaryVsJsonSavingPct: loadSavingPct
      },
    } : {}),
    memoryBreakdown,
    ...(search ? { search } : {}),
    ...(searchLevels ? { searchLevels } : {}),
    ...(scoreDrift ? { scoreDrift } : {}),
    summary: {
      ...(heapSavingPct != null ? { heapFrozenVsMutableSavingPct: heapSavingPct } : {}),
      ...(diskJson != null && diskBinary != null ? { diskBinaryVsJsonSavingPct: diskSavingPct } : {}),
      ...(loadJson != null && loadBinary != null ? { loadBinaryVsJsonSavingPct: loadSavingPct } : {}),
      ...(search ? { searchFrozenP50AvgGainPct: avgFrozenP50GainPct(search) } : {}),
    }
  }
}

function runCapsDisabled () {
  const env = process.env.BENCH_NO_RUN_CAPS
  return env === '1' || env === 'true' || env === 'yes' || process.argv.includes('--no-run-caps')
}

function maxCalibratedSearchProbeMs (scenario) {
  let max = 0
  for (const { label } of scenario.queries ?? []) {
    const entry = getSearchBenchBatchEntry(scenario.id, label)
    const probe = entry.calibratedProbeP50Ms
    if (!probe) continue
    max = Math.max(max, probe.mutable ?? 0, probe.frozen ?? 0)
  }
  return max
}

function resolveScenarioRuns (scenario, requestedRuns, surfaces) {
  if (requestedRuns <= 1 || runCapsDisabled()) {
    return { runs: requestedRuns, reason: null }
  }

  const need = computeSurfaceNeeds(surfaces)
  if (!need.search) return { runs: requestedRuns, reason: null }

  const maxProbeMs = maxCalibratedSearchProbeMs(scenario)
  if (maxProbeMs >= VERY_EXPENSIVE_SEARCH_PROBE_MS) {
    return {
      runs: 1,
      reason: `very expensive calibrated search (${maxProbeMs.toFixed(1)} ms >= ${VERY_EXPENSIVE_SEARCH_PROBE_MS} ms)`,
    }
  }
  if (need.searchLevels && maxProbeMs >= EXPENSIVE_SEARCH_PROBE_MS) {
    return {
      runs: 1,
      reason: `expensive search-levels scenario (${maxProbeMs.toFixed(1)} ms >= ${EXPENSIVE_SEARCH_PROBE_MS} ms)`,
    }
  }
  if (need.searchOnly && maxProbeMs >= EXPENSIVE_SEARCH_PROBE_MS) {
    return {
      runs: Math.min(requestedRuns, 2),
      reason: `expensive search-only scenario (${maxProbeMs.toFixed(1)} ms >= ${EXPENSIVE_SEARCH_PROBE_MS} ms)`,
    }
  }
  return { runs: requestedRuns, reason: null }
}

function withRunPolicy (result, requestedRuns, effectiveRuns, reason) {
  if (requestedRuns === effectiveRuns && reason == null) return result
  return {
    ...result,
    benchmarkRuns: {
      requested: requestedRuns,
      effective: effectiveRuns,
      ...(reason == null ? {} : { reason }),
    },
  }
}

/** Scenarios with fixed `benchBatch` per query (from searchBenchBatches.json). */
export function buildBenchmarkScenarios () {
  return applySearchBenchBatchesToScenarios(buildScenarioList())
}

function computeScoreDrift (mutable, frozen, query, limit = 20) {
  const a = mutable.search(query).slice(0, limit)
  const b = frozen.search(query).slice(0, limit)
  const bMap = new Map(b.map((r) => [r.id, r.score]))
  let maxAbs = 0
  let maxRel = 0
  let missing = 0
  for (const row of a) {
    const score = bMap.get(row.id)
    if (score == null) {
      missing++
      continue
    }
    const abs = Math.abs(score - row.score)
    const rel = row.score ? abs / row.score : 0
    if (abs > maxAbs) maxAbs = abs
    if (rel > maxRel) maxRel = rel
  }
  const aIds = a.map((r) => r.id).join('|')
  const bIds = b.map((r) => r.id).join('|')
  return {
    query,
    topK: limit,
    maxAbsScoreDelta: Number(maxAbs.toFixed(6)),
    maxRelScoreDeltaPct: Number((maxRel * 100).toFixed(2)),
    missingInFrozenTopK: missing,
    topKOrderChanged: aIds !== bIds
  }
}

/**
 * Run one benchmark scenario and return JSON-serializable metrics.
 * Search iteration counts come from `SEARCH_ITERATIONS` (env/CLI) and per-query calibration
 * (`searchIterationsForBatchEntry`); there is no per-call override.
 * @param {{ surfaces?: string[] }} [benchOptions]
 */
export function runScenario (scenario, benchOptions = {}) {
  const surfaces = benchOptions.surfaces ?? [...ALL_SURFACES]
  const need = computeSurfaceNeeds(surfaces)
  if (need.memory || need.breakdown) {
    throw new Error(
      'Surfaces memory/breakdown require the isolated heap phase (captureBaseline or pnpm bench:memory), not runScenario.',
    )
  }
  const levelOpts = { searchLevels: need.searchLevels }

  if (need.searchOnly) {
    const { id, name, corpus, options, queries } = scenario
    const { mutableSearchIndex, frozenSearchIndex } = prepareScenarioSearchIndexes(corpus, options)
    const bench = benchScenarioSearch(
      mutableSearchIndex,
      frozenSearchIndex,
      queries,
      id,
      levelOpts,
    )
    return {
      id,
      name,
      documentCount: corpus.length,
      fields: options.fields,
      storeFields: options.storeFields || [],
      benchProfile: 'search',
      benchSurfaces: surfaces,
      search: bench.search,
      ...(bench.searchLevels ? { searchLevels: bench.searchLevels } : {}),
      summary: { searchFrozenP50AvgGainPct: bench.avgFrozenP50GainPct },
    }
  }

  const { id, name, corpus, options, queries, driftQueries } = scenario
  const needsArtifacts = need.build || need.save || need.load || need.migrate || need.drift

  let search
  let searchGain
  let searchLevels
  if (need.search) {
    const { mutableSearchIndex, frozenSearchIndex } = prepareScenarioSearchIndexes(corpus, options)
    const bench = benchScenarioSearch(
      mutableSearchIndex,
      frozenSearchIndex,
      queries,
      id,
      levelOpts,
    )
    search = bench.search
    searchGain = bench.avgFrozenP50GainPct
    searchLevels = bench.searchLevels
  }

  let json
  let binaryBuf
  let indexMs
  let toJSONMs
  let freezeMs
  let fromDocumentsMs
  let jsonSerializeMs
  let binarySerializeMs

  if (needsArtifacts) {
    const ms = timedMs(() => {
      const m = new MiniSearch(options)
      m.addAll(corpus)
      return m
    })
    indexMs = ms.ms
    const snap = timedMs(() => ms.result.toJSON())
    const snapshot = snap.result
    toJSONMs = snap.ms
    // Realistic end-to-end JSON persistence cost (stringify invokes toJSON again);
    // kept on `ms.result` so jsonSerializeMs stays comparable with prior baselines.
    const ser = timedMs(() => JSON.stringify(ms.result))
    json = ser.result
    jsonSerializeMs = ser.ms
    // freezeMs measures import only (no double toJSON): operate on the pre-built snapshot.
    const fr = timedMs(() => frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options))
    freezeMs = fr.ms
    const bin = timedMs(() => fr.result.saveBinarySync())
    binaryBuf = bin.result
    binarySerializeMs = bin.ms
    if (need.build) {
      // Isolate fromDocuments from the migrate artifacts built above (toJSON/freeze/saveBinary).
      gc()
      const direct = timedMs(() => FrozenMiniSearch.fromDocuments(corpus, options))
      fromDocumentsMs = direct.ms
    }
  }

  gc()

  let loadJson
  let loadBinary
  if (need.load) {
    gc()
    loadJson = timedMs(() => MiniSearch.loadJSON(json, options))
    gc()
    loadBinary = timedMs(() => FrozenMiniSearch.loadBinarySync(binaryBuf, options))
    gc()
  }

  let scoreDrift
  if (need.drift && driftQueries && driftQueries.length > 0) {
    const ms = new MiniSearch(options)
    ms.addAll(corpus)
    const frozen = frozenFromMiniSearchSnapshot(FrozenMiniSearch, ms.toJSON(), options)
    scoreDrift = driftQueries.map((query) => computeScoreDrift(ms, frozen, query))
  }

  const jsonMb = json != null ? mbRound(json.length) : undefined
  const binaryMb = binaryBuf != null ? mbRound(binaryBuf.length) : undefined
  const binaryMagic = binaryBuf != null ? binaryBuf.toString('ascii', 0, 4) : undefined

  const result = {
    id,
    name,
    documentCount: corpus.length,
    fields: options.fields,
    storeFields: options.storeFields || [],
    benchSurfaces: surfaces,
    summary: {},
  }

  if (needsArtifacts && (need.build || need.save || need.migrate)) {
    result.indexing = {
      ...(need.build ? {
        addAllMs: Number(indexMs.toFixed(2)),
        fromDocumentsMs: Number(fromDocumentsMs.toFixed(2)),
      } : {}),
      ...(need.migrate ? {
        toJSONMs: Number(toJSONMs.toFixed(2)),
        freezeMs: Number(freezeMs.toFixed(2)),
      } : {}),
      ...(need.save ? {
        jsonSerializeMs: Number(jsonSerializeMs.toFixed(2)),
        saveBinaryMs: Number(binarySerializeMs.toFixed(2)),
        binaryMagic,
      } : {}),
    }
  }

  if (need.save && jsonMb != null && binaryMb != null) {
    result.diskMb = {
      json: jsonMb,
      binary: binaryMb,
      binaryVsJsonSavingPct: jsonMb > 0
        ? Number((100 * (1 - binaryMb / jsonMb)).toFixed(1))
        : 0,
    }
    result.summary.diskBinaryVsJsonSavingPct = result.diskMb.binaryVsJsonSavingPct
  }

  if (need.load && loadJson && loadBinary) {
    result.loadMs = {
      json: Number(loadJson.ms.toFixed(2)),
      binary: Number(loadBinary.ms.toFixed(2)),
      binaryVsJsonSavingPct: loadJson.ms > 0
        ? Number((100 * (1 - loadBinary.ms / loadJson.ms)).toFixed(1))
        : 0,
    }
    result.summary.loadBinaryVsJsonSavingPct = result.loadMs.binaryVsJsonSavingPct
  }

  if (need.search) {
    result.search = search
    result.summary.searchFrozenP50AvgGainPct = searchGain
    if (searchLevels) result.searchLevels = searchLevels
  }
  if (need.drift) result.scoreDrift = scoreDrift

  return result
}

export function runBenchmarkSuite (
  scenarios = buildBenchmarkScenarios(),
  runs = defaultBenchmarkRuns(),
  benchOptions = {},
) {
  const total = scenarios.length
  const surfaces = benchOptions.surfaces ?? [...ALL_SURFACES]
  const need = computeSurfaceNeeds(surfaces)
  const profileLabel = need.searchOnly ? 'search-only' : `surfaces=[${surfaces.join(',')}]`
  if (need.searchOnly) {
    console.log('Benchmark profile: search-only (skip indexing / heap / save / load timing)\n')
  } else if (surfaces.length < ALL_SURFACES.length) {
    console.log(`Benchmark surfaces: ${surfaces.join(', ')}\n`)
  }
  return scenarios.map((scenario, index) => {
    const runPolicy = resolveScenarioRuns(scenario, runs, surfaces)
    const scenarioRuns = runPolicy.runs
    const runLabel = runPolicy.reason == null
      ? profileLabel
      : `${profileLabel}; ${scenarioRuns}/${runs} runs: ${runPolicy.reason}`

    if (scenarioRuns <= 1) {
      const t0 = performance.now()
      console.log(`[bench ${index + 1}/${total}] ${scenario.id} (${runLabel}) …`)
      const result = runScenario(scenario, benchOptions)
      console.log(`[bench ${index + 1}/${total}] ${scenario.id} done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      return withRunPolicy(result, runs, scenarioRuns, runPolicy.reason)
    }

    const results = []
    for (let i = 0; i < scenarioRuns; i++) {
      const t0 = performance.now()
      console.log(`[bench ${index + 1}/${total}] ${scenario.id} run ${i + 1}/${scenarioRuns} (${runLabel}) …`)
      results.push(runScenario(scenario, benchOptions))
      console.log(
        `[bench ${index + 1}/${total}] ${scenario.id} run ${i + 1}/${scenarioRuns} done in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      )
    }
    return withRunPolicy(aggregateScenarioRuns(results), runs, scenarioRuns, runPolicy.reason)
  })
}
