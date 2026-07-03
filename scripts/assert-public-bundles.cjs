#!/usr/bin/env node
/**
 * Ensure published bundles (ES, CJS, browser) do not embed test/bench-only helpers
 * or legacy Map-radix encode fallbacks.
 */
const { accessSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const bundlePaths = [
  join(root, 'dist', 'es', 'index.js'),
  join(root, 'dist', 'cjs', 'index.cjs'),
  join(root, 'dist', 'browser', 'index.js'),
]

const forbiddenPatterns = [
  { name: 'internal frozenInternals harness', pattern: /\bfrozenInternals\b/ },
  { name: 'SearchableMap runtime', pattern: /\bclass SearchableMap\b|\bnew SearchableMap\b|SearchableMap\/TreeIterator|SearchableMap\/fuzzySearch/ },
  { name: 'legacy Map-radix packer', pattern: /\bfromRadixTree\b|\bdeserializeRadixTreeShape\b|\bdeserializeTermIndexTree\b/ },
  { name: 'benchmark harness paths', pattern: /benchmarks\/|testSupport\/|dev\/parity/ },
  { name: 'incremental grow profiler hooks', pattern: /\breadIncrementalGrowStats\b|\bresetIncrementalGrowStats\b|\bsimulateColumnGrowth\b/ },
  { name: 'legacy encode shared fallback module', pattern: /\bbinaryMsv5EncodeShared\b/ },
  { name: 'deprecated PackedRadix string wrappers', pattern: /\bprefixEntries\b|\bfuzzyEntries\b|\bpackedRadixFuzzyEntries\b|\bpackedPrefixEntries\b|\bdevStringIterators\b/ },
]

function stripComments (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

for (const bundlePath of bundlePaths) {
  try {
    accessSync(bundlePath)
  } catch {
    console.error(`assert-public-bundles: missing ${bundlePath} — run pnpm build first`)
    process.exit(1)
  }

  const bundle = stripComments(readFileSync(bundlePath, 'utf8'))
  const rel = bundlePath.slice(root.length + 1)

  for (const { name, pattern } of forbiddenPatterns) {
    if (pattern.test(bundle)) {
      console.error(`assert-public-bundles: forbidden ${name} found in ${rel}`)
      process.exit(1)
    }
  }
}

console.log(`assert-public-bundles: ok (${bundlePaths.length} bundles checked)`)
