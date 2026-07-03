import {
  searchWithRunOptions,
} from '../../src/internal/frozenInternals'

function searchNaive(frozen, query, searchOptions = {}) {
  return searchWithRunOptions(frozen, query, searchOptions, { disableGating: true })
}

export { searchNaive, searchWithRunOptions }
