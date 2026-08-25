import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import resolvePlugin from '@rollup/plugin-node-resolve'
import ts from 'typescript'
import { rollup } from 'rollup'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outputDir = resolve(root, 'benchmarks/tmp/engines')
const profiles = [
  { name: 'core', input: resolve(here, 'engineBenchEntry.ts') },
  { name: 'bdpm-shaped', input: resolve(here, 'bdpmEngineBenchEntry.ts') },
  { name: 'resident-pressure', input: resolve(here, 'residentEngineBenchEntry.ts') },
]
export const outputFiles = profiles.map(profile => ({
  name: profile.name,
  file: resolve(outputDir, `${profile.name}.js`),
}))
export const outputFile = resolve(outputDir, 'frozen-engine-bench.js')

const forbiddenRuntimeTokens = [
  ['Node built-in import', /['"]node:/],
  ['CommonJS require', /\brequire\s*\(/],
  ['dynamic import', /\bimport\s*\(/],
  ['Node Buffer', /\bBuffer\b/],
  ['Node process', /\bprocess\b/],
  ['Bun global', /\bBun\b/],
  ['TextEncoder', /\bTextEncoder\b/],
  ['TextDecoder', /\bTextDecoder\b/],
  ['CompressionStream', /\bCompressionStream\b/],
  ['DecompressionStream', /\bDecompressionStream\b/],
  ['ReadableStream', /\bReadableStream\b/],
  ['Response', /\bResponse\b/],
]

function engineTypescript () {
  return {
    name: 'engine-typescript',
    transform (code, id) {
      if (!id.endsWith('.ts')) return null
      const result = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          sourceMap: false,
          importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
        },
      })
      return { code: result.outputText, map: null }
    },
  }
}

async function buildPart (input) {
  const bundle = await rollup({
    input,
    treeshake: { moduleSideEffects: false },
    onwarn (warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return
      warn(warning)
    },
    plugins: [
      resolvePlugin({
        extensions: ['.mjs', '.js', '.json', '.node', '.ts'],
      }),
      engineTypescript(),
    ],
  })

  try {
    const generated = await bundle.generate({
      format: 'iife',
      sourcemap: false,
      generatedCode: 'es2015',
    })
    const chunk = generated.output.find(item => item.type === 'chunk')
    if (chunk == null) throw new Error(`engine benchmark build produced no chunk for ${input}`)
    return chunk.code
  } finally {
    await bundle.close()
  }
}

function assertPureBundle (source, expectedMarkers, label) {
  for (const [tokenLabel, pattern] of forbiddenRuntimeTokens) {
    if (pattern.test(source)) {
      throw new Error(`engine bundle purity check failed (${label}): ${tokenLabel}`)
    }
  }
  const reportMarkers = source.match(/@@FROZEN_ENGINE_BENCH@@/g)?.length ?? 0
  if (reportMarkers !== expectedMarkers) {
    throw new Error(`engine bundle purity check failed (${label}): expected ${expectedMarkers} report markers, got ${reportMarkers}`)
  }
}

export async function buildEngineBundle () {
  await mkdir(outputDir, { recursive: true })
  const parts = []
  for (let i = 0; i < profiles.length; i++) {
    const source = await buildPart(profiles[i].input)
    parts.push(source)
    assertPureBundle(source, 1, profiles[i].name)
    await writeFile(outputFiles[i].file, `${source}\n`, 'utf8')
  }

  await writeFile(outputFile, `${parts.join('\n;\n')}\n`, 'utf8')
  const combined = await readFile(outputFile, 'utf8')
  assertPureBundle(combined, profiles.length, 'combined')
  return { outputFile, outputFiles }
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildEngineBundle()
    .then(({ outputFile: file, outputFiles: files }) => {
      console.log(`engine benchmark bundle: ${file}`)
      for (const profile of files) console.log(`engine profile bundle (${profile.name}): ${profile.file}`)
    })
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
