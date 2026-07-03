import FrozenMiniSearch from './FrozenMiniSearch'
import { buildBinarySnapshotInput } from './frozenBinaryShared'
import { fieldLengthMatrixWireFlags } from './fieldLengthMatrixWire'
import { frozenFieldLengthMatrix } from '../testSupport/frozenMemoryBreakdown.js'
import {
  FLAG_FL_U8,
  FLAG_FL_U16,
  Msv5SectionId,
} from './msv5/binaryMsv5Constants'
import {
  loadMsv5Sections,
  readMsv5GlobalFlags,
  readMsv5SectionDirectory,
} from './msv5/binaryMsv5Compression'

function densePostings(fieldCount, termCount, nextId) {
  return {
    fieldCount,
    termCount,
    nextId,
    layout: 'dense',
    docIdWidth: 32,
    allDocIds: new Uint32Array([0]),
    allFreqs: new Uint8Array([1]),
    denseOffsets: new Uint32Array(termCount * fieldCount).fill(0),
    denseLengths: new Uint32Array(termCount * fieldCount).fill(0),
  }
}

function snapshotState(overrides = {}) {
  const fieldCount = 2
  const nextId = 3
  return {
    documentCount: nextId,
    nextId,
    fieldIds: { title: 0, text: 1 },
    fieldCount,
    avgFieldLength: new Float32Array([2, 3]),
    externalIds: ['a', 'b', 'c'],
    storedFieldsLayout: { kind: 'none' },
    fieldLengthMatrix: new Uint8Array(nextId * fieldCount).fill(7),
    postings: densePostings(fieldCount, 1, nextId),
    ...overrides,
  }
}

describe('buildBinarySnapshotInput', () => {
  test('passes fieldLengthMatrix through without widening', () => {
    const u8 = new Uint8Array([1, 2, 3, 4, 5, 6])
    const snap = buildBinarySnapshotInput(snapshotState({ fieldLengthMatrix: u8 }))
    expect(snap.fieldLengthMatrix).toBe(u8)

    const u16 = new Uint16Array([256, 257, 258, 259, 260, 261])
    const snap16 = buildBinarySnapshotInput(snapshotState({ fieldLengthMatrix: u16 }))
    expect(snap16.fieldLengthMatrix).toBe(u16)
    expect(fieldLengthMatrixWireFlags(snap16.fieldLengthMatrix)).toBe(FLAG_FL_U16)
  })

  test('uses empty storedFields rows when storedFieldsLayout is set', () => {
    const snap = buildBinarySnapshotInput(snapshotState())
    expect(snap.storedFields).toEqual([])
    expect(snap.storedFieldsLayout).toEqual({ kind: 'none' })
  })

  test('keeps storedFields placeholder when layout is absent', () => {
    const snap = buildBinarySnapshotInput(snapshotState({ storedFieldsLayout: undefined }))
    expect(snap.storedFields).toHaveLength(3)
    expect(snap.storedFields.every(row => row === undefined)).toBe(true)
  })
})

describe('FrozenMiniSearch saveBinary fieldLengthMatrix wire width', () => {
  test('saveBinarySync keeps u8 matrix section size on corpus with short field lengths', () => {
    const docs = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      title: 'word'.repeat(3 + (i % 5)),
      text: 'token'.repeat(4 + (i % 8)),
    }))
    const opts = { fields: ['title', 'text'] }
    const frozen = FrozenMiniSearch.fromDocuments(docs, opts)
    const fieldLengthMatrix = frozenFieldLengthMatrix(frozen)
    expect(fieldLengthMatrix).toBeInstanceOf(Uint8Array)
    expect(fieldLengthMatrixWireFlags(fieldLengthMatrix)).toBe(FLAG_FL_U8)

    const buf = frozen.saveBinarySync({ compression: 'raw' })
    const globalFlags = readMsv5GlobalFlags(buf)
    expect(globalFlags & FLAG_FL_U8).toBe(FLAG_FL_U8)

    const directory = readMsv5SectionDirectory(buf)
    const sections = loadMsv5Sections(buf, directory)
    expect(sections[Msv5SectionId.FieldLengthMatrix].length)
      .toBe(fieldLengthMatrix.byteLength)

    const loaded = FrozenMiniSearch.loadBinarySync(buf, opts)
    expect(Array.from(frozenFieldLengthMatrix(loaded)))
      .toEqual(Array.from(fieldLengthMatrix))
  })
})
