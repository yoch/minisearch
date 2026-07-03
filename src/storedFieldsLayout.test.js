import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenFromMiniSearch } from '../testSupport/frozenImportHelpers'
import {
  createStoredFieldsLayout,
  readStoredFields,
  resizeStoredFields,
  storedFieldsFromRows,
  storedFieldsJsonBytes,
  storedFieldsSlotCount,
  storedFieldsToWireRows,
  writeStoredField,
} from './storedFieldsLayout'
import { allocBytes, writeU32LE } from './binaryBytes'
import { buildStoredFieldsWireSection, readStoredFieldsWireSection } from './storedFieldsWire'
import { buildStoredFieldsSectionWire } from './binaryWireIo'

describe('storedFieldsLayout', () => {
  test('single store field: column at rest, Record on read', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [{ id: 1, txt: 'alpha' }, { id: 2, txt: 'beta' }],
      { fields: ['txt'], storeFields: ['txt'] },
    )
    expect(index.getStoredFields(1)).toEqual({ txt: 'alpha' })
    expect(index.getStoredFields(2)).toEqual({ txt: 'beta' })
  })

  test('wire round-trip', () => {
    const layout = createStoredFieldsLayout(['txt'], 2)
    writeStoredField(layout, 0, ['txt'], (d, f) => d[f], { txt: 'x' })
    writeStoredField(layout, 1, ['txt'], (d, f) => d[f], { txt: 'y' })
    const back = storedFieldsFromRows(storedFieldsToWireRows(layout, 2), ['txt'])
    expect(readStoredFields(back, 0)).toEqual({ txt: 'x' })
  })

  test('wire section matches row encode (single field)', () => {
    const layout = createStoredFieldsLayout(['txt'], 2)
    writeStoredField(layout, 0, ['txt'], (d, f) => d[f], { txt: 'x' })
    writeStoredField(layout, 1, ['txt'], (d, f) => d[f], { txt: 'y' })
    const fromRows = buildStoredFieldsSectionWire(storedFieldsToWireRows(layout, 2), 2)
    const direct = buildStoredFieldsWireSection(layout, 2)
    expect(Buffer.from(direct)).toEqual(Buffer.from(fromRows))
  })

  test('wire section read → single column', () => {
    const layout = createStoredFieldsLayout(['txt'], 2)
    writeStoredField(layout, 0, ['txt'], (d, f) => d[f], { txt: 'x' })
    writeStoredField(layout, 1, ['txt'], (d, f) => d[f], { txt: 'y' })
    const section = buildStoredFieldsWireSection(layout, 2)
    const loaded = readStoredFieldsWireSection(section, 0, 2, section.length, ['txt'])
    expect(loaded).toEqual({ kind: 'single', field: 'txt', values: ['x', 'y'] })
  })

  test('multi store fields keep row records', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [{ id: 1, title: 'A', category: 'x' }],
      { fields: ['title', 'category'], storeFields: ['title', 'category'] },
    )
    expect(index.getStoredFields(1)).toEqual({ title: 'A', category: 'x' })
  })

  test('binary load without storeFields option', () => {
    const mutable = new MiniSearch({
      fields: ['title', 'text'],
      storeFields: ['title', 'category'],
    })
    mutable.add({ id: 1, title: 'Zen Motorcycle', text: 'zen art', category: 'fiction' })
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, {
      fields: ['title', 'text'],
      storeFields: ['title', 'category'],
    })
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), {})
    expect(loaded.getStoredFields(1)).toEqual({ title: 'Zen Motorcycle', category: 'fiction' })
  })

  test('resizeStoredFields truncates single and multi layouts', () => {
    const single = { kind: 'single', field: 'txt', values: ['a', 'b', 'c'] }
    expect(resizeStoredFields(single, 2)).toEqual({ kind: 'single', field: 'txt', values: ['a', 'b'] })
    expect(resizeStoredFields(single, 5)).toBe(single)

    const multi = { kind: 'multi', rows: [{ x: 1 }, { x: 2 }, { x: 3 }] }
    expect(resizeStoredFields(multi, 2)).toEqual({ kind: 'multi', rows: [{ x: 1 }, { x: 2 }] })
    expect(resizeStoredFields(multi, 5)).toBe(multi)
    expect(resizeStoredFields({ kind: 'none' }, 3)).toEqual({ kind: 'none' })
  })

  test('storedFieldsToWireRows pads multi rows and materializes single rows', () => {
    const multi = { kind: 'multi', rows: [{ txt: 'x' }] }
    expect(storedFieldsToWireRows(multi, 3)).toEqual([{ txt: 'x' }, undefined, undefined])

    const single = { kind: 'single', field: 'txt', values: ['x', undefined, 'y'] }
    expect(storedFieldsToWireRows(single, 3)).toEqual([{ txt: 'x' }, {}, { txt: 'y' }])
    expect(storedFieldsToWireRows({ kind: 'none' }, 2)).toEqual([undefined, undefined])
  })

  test('storedFieldsJsonBytes and slotCount follow layout kind', () => {
    expect(storedFieldsJsonBytes({ kind: 'none' })).toBe(0)
    expect(storedFieldsSlotCount({ kind: 'none' })).toBe(0)

    const single = { kind: 'single', field: 'txt', values: ['a', undefined, 'b'] }
    expect(storedFieldsJsonBytes(single)).toBe(JSON.stringify({ txt: 'a' }).length + JSON.stringify({ txt: 'b' }).length)
    expect(storedFieldsSlotCount(single)).toBe(3)

    const multi = { kind: 'multi', rows: [{ txt: 'x' }, null, { txt: 'y' }] }
    expect(storedFieldsJsonBytes(multi)).toBe(JSON.stringify({ txt: 'x' }).length + JSON.stringify({ txt: 'y' }).length)
    expect(storedFieldsSlotCount(multi)).toBe(3)
  })

  test('readStoredFieldsWireSection rejects corrupted wire sections', () => {
    const section = buildStoredFieldsWireSection(
      createStoredFieldsLayout(['txt'], 1),
      1,
    )
    expect(() => readStoredFieldsWireSection(section, 0, 2, 4))
      .toThrow(/stored fields table out of bounds/)

    const tableOnly = allocBytes(4)
    writeU32LE(tableOnly, 0, 1)
    expect(() => readStoredFieldsWireSection(tableOnly, 0, 1, 4, ['txt']))
      .toThrow(/stored fields entry offset out of bounds/)

    const badJsonLen = allocBytes(8)
    writeU32LE(badJsonLen, 0, 1)
    writeU32LE(badJsonLen, 4, 99)
    expect(() => readStoredFieldsWireSection(badJsonLen, 0, 1, 8, ['txt']))
      .toThrow(/stored fields JSON out of bounds/)
  })

  test('readStoredFieldsWireSection infers multi vs none without storeFields hint', () => {
    const layout = createStoredFieldsLayout(['txt'], 1)
    writeStoredField(layout, 0, ['txt'], (d, f) => d[f], { txt: 'x' })
    const section = buildStoredFieldsWireSection(layout, 1)
    expect(readStoredFieldsWireSection(section, 0, 1, section.length, []))
      .toEqual({ kind: 'multi', rows: [{ txt: 'x' }] })

    const emptyTable = allocBytes(4)
    expect(readStoredFieldsWireSection(emptyTable, 0, 1, emptyTable.length, []))
      .toEqual({ kind: 'none' })
  })
})
