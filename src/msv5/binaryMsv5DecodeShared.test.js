import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../FrozenMiniSearch'
import { frozenFromMiniSearch } from '../../testSupport/frozenImportHelpers'
import { readU32LE, writeU16LE } from '../binaryBytes'
import { vi } from 'vitest'
import {
  isMsv5Buffer,
  loadMsv5Sections,
  readMsv5GlobalFlags,
  readMsv5SectionDirectory,
} from './binaryMsv5Compression'
import {
  decodeMsv5Sections,
  validateMsv5Container,
} from './binaryMsv5DecodeShared'
import * as binaryMsv5Postings from './binaryMsv5Postings'
import { Msv5SectionId } from './binaryMsv5Constants'

const options = { fields: ['text'] }

function validMsv5Snapshot() {
  const mutable = new MiniSearch(options)
  mutable.add({ id: 1, text: 'hello world' })
  const buf = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    .saveBinarySync({ compression: 'raw' })
  const directory = readMsv5SectionDirectory(buf)
  return {
    buf,
    globalFlags: readMsv5GlobalFlags(buf),
    sections: loadMsv5Sections(buf, directory),
  }
}

const containerReaders = {
  isMsv5Buffer,
  readMsv5GlobalFlags,
  readMsv5SectionDirectory,
}

describe('binaryMsv5DecodeShared', () => {
  test('validateMsv5Container rejects a non-MSv5 buffer', () => {
    expect(() => validateMsv5Container(new Uint8Array(64), containerReaders))
      .toThrow(/not a frozen binary snapshot/)
  })

  test('validateMsv5Container rejects an unsupported snapshot version', () => {
    const { buf } = validMsv5Snapshot()
    const bad = new Uint8Array(buf)
    writeU16LE(bad, 4, 6)
    expect(() => validateMsv5Container(bad, containerReaders))
      .toThrow(/unsupported frozen snapshot version=6/)
  })

  test('decodeMsv5Sections rejects a core section whose size is not 16 bytes', () => {
    const { globalFlags, sections } = validMsv5Snapshot()
    const bad = sections.map(section => new Uint8Array(section))
    bad[Msv5SectionId.Core] = new Uint8Array(15)
    expect(() => decodeMsv5Sections(globalFlags, bad))
      .toThrow(/core section size mismatch/)
  })

  test('decodeMsv5Sections rejects core termCount mismatch with postings', () => {
    const { globalFlags, sections } = validMsv5Snapshot()
    const coreTermCount = readU32LE(sections[Msv5SectionId.Core], 12)
    const spy = vi.spyOn(binaryMsv5Postings, 'decodeMsv5PostingsSections')
    spy.mockReturnValue({ termCount: coreTermCount + 1 })
    expect(() => decodeMsv5Sections(globalFlags, sections))
      .toThrow(/core termCount mismatch with postings/)
    spy.mockRestore()
  })
})
