import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildEngineBundle, outputFile } from './build.mjs'

const REPORT_PREFIX = '@@FROZEN_ENGINE_BENCH@@'
const MAX_OUTPUT = 8 * 1024 * 1024

const engineSpecs = [
  { name: 'node', env: 'FMS_ENGINE_NODE', command: process.execPath, required: true },
  { name: 'bun', env: 'FMS_ENGINE_BUN', command: 'bun' },
  { name: 'v8', env: 'FMS_ENGINE_D8', command: 'd8' },
  { name: 'jsc', env: 'FMS_ENGINE_JSC', command: 'jsc' },
  { name: 'quickjs', env: 'FMS_ENGINE_QJS', command: 'qjs' },
]

function resolveCommand (spec) {
  return process.env[spec.env] || spec.command
}

function executableExists (command) {
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
    timeout: 5000,
  })
  return probe.error == null
}

function versionFor (command) {
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
    timeout: 5000,
  })
  const text = `${probe.stdout || ''}${probe.stderr || ''}`.trim().split('\n')[0]
  return probe.status === 0 && text ? text : 'unknown'
}

function parseReport (stdout) {
  const line = stdout
    .split(/\r?\n/)
    .find(candidate => candidate.startsWith(REPORT_PREFIX))
  if (line == null) throw new Error('benchmark report marker not found')
  const report = JSON.parse(line.slice(REPORT_PREFIX.length))
  if (report.schema !== 1 || report.timings == null || report.fingerprints == null) {
    throw new Error('benchmark report schema mismatch')
  }
  return report
}

function runEngine (name, command) {
  const child = spawnSync(command, [outputFile], {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
    timeout: 120000,
  })
  if (child.error != null) throw child.error
  if (child.status !== 0) {
    const details = `${child.stderr || ''}${child.stdout || ''}`.trim()
    throw new Error(`exit ${child.status}${details ? `: ${details.slice(0, 1000)}` : ''}`)
  }
  return {
    name,
    command,
    version: versionFor(command),
    report: parseReport(child.stdout),
  }
}

function validateFingerprints (runs) {
  if (runs.length < 2) return []
  const reference = runs.find(run => run.name === 'node') || runs[0]
  const mismatches = []
  for (const run of runs) {
    for (const [workload, expected] of Object.entries(reference.report.fingerprints)) {
      const actual = run.report.fingerprints[workload]
      if (actual !== expected) mismatches.push(`${run.name}:${workload} ${actual} != ${expected}`)
    }
    if (run.report.corpus.documents !== reference.report.corpus.documents ||
        run.report.corpus.terms !== reference.report.corpus.terms) {
      mismatches.push(`${run.name}:corpus differs from ${reference.name}`)
    }
  }
  return mismatches
}

function formatUs (value) {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} ms`
  return `${value.toFixed(2)} us`
}

function printTable (runs) {
  const reference = runs.find(run => run.name === 'node') || runs[0]
  const workloads = Object.keys(reference.report.timings)
  console.log(`\nCorpus: ${reference.report.corpus.documents} docs, ${reference.report.corpus.terms} terms`)
  console.log(`Reference: ${reference.name} (${reference.version})`)
  console.log('')
  const width = 18
  console.log(['engine', ...workloads].map(value => value.padEnd(width)).join(''))
  console.log('-'.repeat(width * (workloads.length + 1)))
  for (const run of runs) {
    const cells = [run.name.padEnd(width)]
    for (const workload of workloads) {
      const us = run.report.timings[workload].medianUs
      const refUs = reference.report.timings[workload].medianUs
      const relative = us === 0 ? 0 : refUs / us
      cells.push(`${formatUs(us)} ${relative.toFixed(2)}x`.padEnd(width))
    }
    console.log(cells.join(''))
  }
}

async function main () {
  await buildEngineBundle()
  await access(outputFile, constants.R_OK)

  const runs = []
  const failures = []
  for (const spec of engineSpecs) {
    const command = resolveCommand(spec)
    if (!executableExists(command)) {
      if (spec.required) failures.push(`${spec.name}: executable not found (${command})`)
      continue
    }
    try {
      runs.push(runEngine(spec.name, command))
    } catch (error) {
      failures.push(`${spec.name} (${basename(command)}): ${error.message}`)
    }
  }

  const spiderMonkey = process.env.FMS_ENGINE_SM
  if (spiderMonkey) {
    if (!executableExists(spiderMonkey)) {
      failures.push(`spidermonkey: executable not found (${spiderMonkey})`)
    } else {
      try {
        runs.push(runEngine('spidermonkey', spiderMonkey))
      } catch (error) {
        failures.push(`spidermonkey (${basename(spiderMonkey)}): ${error.message}`)
      }
    }
  }

  if (runs.length === 0) throw new Error('no JavaScript engine completed the benchmark')
  const mismatches = validateFingerprints(runs)
  printTable(runs)

  console.log('\nJSON:')
  console.log(JSON.stringify({ schema: 1, runs, failures, mismatches }, null, 2))

  if (failures.length > 0) {
    console.error(`\nFailed engines:\n- ${failures.join('\n- ')}`)
    process.exitCode = 1
  }
  if (mismatches.length > 0) {
    console.error(`\nCorrectness mismatches:\n- ${mismatches.join('\n- ')}`)
    process.exitCode = 2
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
