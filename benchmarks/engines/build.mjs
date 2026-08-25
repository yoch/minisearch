import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import resolvePlugin from '@rollup/plugin-node-resolve'
import ts from 'typescript'
import { rollup } from 'rollup'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const inputs = [
  resolve(here, 'engineBenchEntry.ts'),
  resolve(here, 'bdpmEngineBenchEntry.ts'),
]
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

export async function buildEngineBundle () {
  await mkdir(dirname(outputFile), { recursive: true })
  const parts = []
  for (const input of inputs) parts.push(await buildPart(input))
  await writeFile(outputFile, `${parts.join('\n;\n')}\n`, 'utf8')

  const source = await readFile(outputFile, 'utf8')
  for (const [label, pattern] of forbiddenRuntimeTokens) {
    if (pattern.test(source)) {
      throw new Error(`engine bundle purity check failed: ${label}`)
    }
  }
  const reportMarkers = source.match(/@@FROZEN_ENGINE_BENCH@@/g)?.length ?? 0
  if (reportMarkers < inputs.length) {
    throw new Error(`engine bundle purity check failed: expected ${inputs.length} report markers, got ${reportMarkers}`)
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
