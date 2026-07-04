#!/usr/bin/env node
/**
 * Copy repo markdown/JSON into docs/media/ for the TypeDoc site (relative links in docs/index.html).
 * Outputs are gitignored. Run after TypeDoc (`build-docs` runs typedoc first, then this script).
 */
const { copyFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const mediaDir = join(root, 'docs', 'media')

/** @type {Array<[sourceRelative: string, destName: string]>} */
const COPIES = [
  ['DESIGN_DOCUMENT.md', 'DESIGN_DOCUMENT.md'],
  ['CHANGELOG.md', 'CHANGELOG.md'],
  ['benchmarks/README.md', 'README.md'],
  ['benchmarks/VS_REFERENCE.md', 'VS_REFERENCE.md'],
  ['benchmarks/baselines/reference.json', 'reference.json'],
]

mkdirSync(mediaDir, { recursive: true })

for (const [srcRel, destName] of COPIES) {
  const src = join(root, srcRel)
  const dest = join(mediaDir, destName)
  copyFileSync(src, dest)
  console.log(`sync-docs-media: ${destName} ← ${srcRel}`)
}
