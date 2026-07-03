/**
 * Break down loadBinarySync cost by phase (decode vs assemble vs validation).
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-load-binary.mjs
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-load-binary.mjs --scenario=giant
 */
import FrozenMiniSearch from '../../dist/es/index.js'
import { decodeFrozenSnapshot } from '../../src/binaryDecode.ts'
import { validateFrozenSnapshot } from '../../src/binaryStructures.ts'
import { validateFrozenTermIndexLeaves } from '../../src/frozenTermIndex.ts'
import { materializeOwnedSnapshot } from '../../src/frozenOwnedSnapshot.ts'
import { assembleParamsFromBinarySnapshot } from '../../src/frozenBinaryShared.ts'
import { readPackedTermTreeSectionColumnar } from '../../src/msv5/packedRadixBinaryMsv5.ts'
import {
  isMsv5Buffer,
  loadMsv5Sections,
  readMsv5GlobalFlags,
  readMsv5SectionDirectory,
} from '../../src/msv5/binaryMsv5Compression.ts'
import { decodeMsv5Sections, validateMsv5Container } from '../../src/msv5/binaryMsv5DecodeShared.ts'
import { readU32LE } from '../../src/binaryBytes.ts'
import { Msv5SectionId } from '../../src/msv5/binaryMsv5Constants.ts'
import { giantVocabulary, sparseFields } from '../benchmarkScenarios.js'
import { loadDivinaLines } from '../loadDivinaLines.js'
import { argValue, intArg, timed } from './cpuBenchUtils.mjs'

const scenarios = {
  sparse: () => {
    const { docs, fields } = sparseFields()
    const options = { fields, idField: 'id' }
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    return { name: 'sparseFields-50kTerms-20Fields', buf: frozen.saveBinarySync(), options }
  },
  giant: () => {
    const docs = giantVocabulary(50000)
    const options = { fields: ['txt'], idField: 'id' }
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    return { name: 'extreme-giantVocabulary', buf: frozen.saveBinarySync(), options }
  },
  'divina-store': () => {
    const options = { fields: ['txt'], storeFields: ['txt'] }
    const frozen = FrozenMiniSearch.fromDocuments(loadDivinaLines(), options)
    return { name: 'divina-storeFields', buf: frozen.saveBinarySync(), options }
  },
  divina: () => {
    const options = { fields: ['txt'], storeFields: [] }
    const frozen = FrozenMiniSearch.fromDocuments(loadDivinaLines(), options)
    return { name: 'divina-indexOnly', buf: frozen.saveBinarySync(), options }
  },
}

const scenarioKey = argValue('--scenario') ?? 'sparse'
const warmup = intArg('warmup', 5, { min: 0 })
const iterations = intArg('iterations', 40)

async function main() {
  const build = scenarios[scenarioKey]
  if (build == null) {
    console.error(`Unknown scenario=${scenarioKey}. Try: ${Object.keys(scenarios).join(', ')}`)
    process.exit(1)
  }
  const { name, buf, options } = await build()
  const storeFields = options.storeFields ?? []

  const { globalFlags, directory } = validateMsv5Container(buf, {
    isMsv5Buffer,
    readMsv5GlobalFlags,
    readMsv5SectionDirectory,
  })
  const sections = loadMsv5Sections(buf, directory)
  const core = sections[Msv5SectionId.Core]
  const termCount = readU32LE(core, 12)

  const phases = {
    decompress: () => loadMsv5Sections(buf, directory),
    termTreeDecode: () => readPackedTermTreeSectionColumnar(sections[Msv5SectionId.TermTree], termCount),
    decodeSections: () => decodeMsv5Sections(globalFlags, sections, { storeFields }),
    validateSnapshot: () => {
      const snap = decodeMsv5Sections(globalFlags, sections, { storeFields })
      validateFrozenSnapshot(snap)
      return snap
    },
    validateLeavesOnly: () => {
      const tree = readPackedTermTreeSectionColumnar(sections[Msv5SectionId.TermTree], termCount)
      validateFrozenTermIndexLeaves(tree, termCount)
      return tree
    },
    assembleParams: () => assembleParamsFromBinarySnapshot(
      decodeMsv5Sections(globalFlags, sections, { storeFields }),
      options,
    ),
    copyWireOwned: () => materializeOwnedSnapshot(
      assembleParamsFromBinarySnapshot(
        decodeMsv5Sections(globalFlags, sections, { storeFields }),
        options,
      ),
      'binary-load-wire',
    ),
    loadBinarySync: () => FrozenMiniSearch.loadBinarySync(buf, options),
  }

  console.log(`Profile loadBinary — ${name}`)
  console.log(`  buffer: ${(buf.length / 1024 / 1024).toFixed(2)} MB, termCount: ${termCount}`)
  console.log(`  warmup=${warmup}, iterations=${iterations}\n`)

  for (const [label, fn] of Object.entries(phases)) {
    const { p50 } = timed(fn, warmup, iterations)
    console.log(`  ${label.padEnd(22)} ${p50.toFixed(3)} ms`)
  }

  const full = timed(() => FrozenMiniSearch.loadBinarySync(buf, options), warmup, iterations).p50
  const decodeOnly = timed(() => decodeFrozenSnapshot(buf, { storeFields }), warmup, iterations).p50
  const assembleCompressed = timed(() => {
    const snap = decodeFrozenSnapshot(buf, { storeFields })
    materializeOwnedSnapshot(assembleParamsFromBinarySnapshot(snap, options), 'binary-load')
  }, warmup, iterations).p50
  const assembleWire = timed(() => {
    const snap = decodeFrozenSnapshot(buf, { storeFields })
    materializeOwnedSnapshot(assembleParamsFromBinarySnapshot(snap, options), 'binary-load-wire')
  }, warmup, iterations).p50

  console.log('\nDerived splits:')
  console.log(`  decodeFrozenSnapshot      ${decodeOnly.toFixed(3)} ms`)
  console.log(`  decode + compressed owned ${assembleCompressed.toFixed(3)} ms`)
  console.log(`  decode + wire copy        ${assembleWire.toFixed(3)} ms`)
  console.log(`  loadBinarySync (total)    ${full.toFixed(3)} ms`)

  const leafValidate = timed(() => {
    const tree = readPackedTermTreeSectionColumnar(sections[Msv5SectionId.TermTree], termCount)
    validateFrozenTermIndexLeaves(tree, termCount)
  }, warmup, iterations).p50
  const treeNoVal = timed(() => {
    readPackedTermTreeSectionColumnar(sections[Msv5SectionId.TermTree], termCount)
  }, warmup, iterations).p50
  console.log(`\nTerm-tree validation overhead:`)
  console.log(`  readPackedTermTree     ${treeNoVal.toFixed(3)} ms`)
  console.log(`  + validateLeaves (1×)  ${leafValidate.toFixed(3)} ms  (+${(leafValidate - treeNoVal).toFixed(3)} ms)`)
  console.log(`  triple validate est.   +${((leafValidate - treeNoVal) * 2).toFixed(3)} ms vs single validate path`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
