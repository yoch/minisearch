import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import typescript from '@rollup/plugin-typescript'
import ts from 'typescript'
import { rollup } from 'rollup'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const input = resolve(here, 'engineBenchEntry.ts')
const typescriptOutDir = resolve(root, 'benchmarks/tmp/engines/ts')
export const outputFile = resolve(root, 'benchmarks/tmp/engines/frozen-engine-bench.js')

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

const engineEntryTypescript = {
  name: 'engine-entry-typescript',
  transform (code, id) {
    if (id !== input) return null
    const result = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
      },
    })
    return { code: result.outputText, map: null }
  },
}

export async function buildEngineBundle () {
  await mkdir(dirname(outputFile), { recursive: true })
  const bundle = await rollup({
    input,
    treeshake: { moduleSideEffects: false },
    onwarn (warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return
      warn(warning)
    },
    plugins: [
      engineEntryTypescript,
      typescript({
        tsconfig: resolve(root, 'tsconfig.json'),
        filterRoot: root,
        include: [
          'src/**/*.ts',
          'src/**/*.js',
        ],
        compilerOptions: {
          outDir: typescriptOutDir,
          sourceMap: false,
          declaration: false,
          declarationMap: false,
        },
      }),
    ],
  })

  try {
    await bundle.write({
      file: outputFile,
      format: 'iife',
      sourcemap: false,
      generatedCode: 'es2015',
    })
  } finally {
    await bundle.close()
  }

  const source = await readFile(outputFile, 'utf8')
  for (const [label, pattern] of forbiddenRuntimeTokens) {
    if (pattern.test(source)) {
      throw new Error(`engine bundle purity check failed: ${label}`)
    }
  }
  if (!source.includes('@@FROZEN_ENGINE_BENCH@@')) {
    throw new Error('engine bundle purity check failed: report marker missing')
  }
  return outputFile
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildEngineBundle()
    .then(file => console.log(`engine benchmark bundle: ${file}`))
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
