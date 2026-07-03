import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenFromMiniSearch } from '../testSupport/frozenImportHelpers'
import { MSV5_HEADER_SIZE } from './msv5/binaryMsv5Constants'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  searchOptions: { prefix: true },
}

function corruptPayloadAfterLoad(buf) {
  buf.fill(0, MSV5_HEADER_SIZE)
}

describe('frozenOwnedSnapshot wire buffer isolation', () => {
  test.each(['raw', 'zlib'])('search stays stable after mutating the source buffer (%s)', (compression) => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const buf = frozen.saveBinarySync({ compression })
    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
    const query = 'ishmael'
    const expected = loaded.search(query, options.searchOptions)

    corruptPayloadAfterLoad(buf)
    expect(loaded.search(query, options.searchOptions)).toEqual(expected)
  })
})
