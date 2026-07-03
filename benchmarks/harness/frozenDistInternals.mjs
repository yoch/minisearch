/** Benchmark-only helpers for scripts that intentionally run against dist/es. */

export { frozenMemoryBreakdown } from '../../testSupport/frozenMemoryBreakdown.js'

export function frozenFromMiniSearch (Ctor, source, options = {}) {
  return Ctor.fromJSON(JSON.stringify(source.toJSON()), options)
}
