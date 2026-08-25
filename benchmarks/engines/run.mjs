import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildEngineBundle, outputFiles } from './build.mjs'

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

function parseMaxRssKiB (stderr) {
  const match = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)
  return match == null ? null : Number(match[1])
}

function detectGnuTime () {
  const command = process.env.FMS_GNU_TIME || '/usr/bin/time'
  const probe = spawnSync(command, ['-v', 'true'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
    timeout: 5000,
  })
  if (probe.error != null || probe.status !== 0) return null
  return parseMaxRssKiB(probe.stderr || '') == null ? null : command
}

function parseProfileReport (stdout, expectedProfile) {
  const lines = stdout
    .split(/\r?\n/)
    .filter(candidate => candidate.startsWith(REPORT_PREFIX))
  if (lines.length !== 1) {
    throw new Error(`expected one benchmark report for ${expectedProfile}, got ${lines.length}`)
  }
  const report = JSON.parse(lines[0].slice(REPORT_PREFIX.length))
  if (report.schema !== 1 || report.timings == null || report.fingerprints == null) {
    throw new Error(`benchmark report schema mismatch for ${expectedProfile}`)
  }
  const profile = report.profile || 'core'
  if (profile !== expectedProfile) {
    throw new Error(`benchmark profile mismatch: expected ${expectedProfile}, got ${profile}`)
  }
  return report
}

function runProfile (command, profile, gnuTime) {
  const executable = gnuTime || command
  const args = gnuTime ? ['-v', command, profile.file] : [profile.file]
  const child = spawnSync(executable, args, {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
    timeout: 120000,
  })
  if (child.error != null) throw child.error
  if (child.status !== 0) {
    const details = `${child.stderr || ''}${child.stdout || ''}`.trim()
    throw new Error(`${profile.name}: exit ${child.status}${details ? `: ${details.slice(0, 1000)}` : ''}`)
  }
  return {
    report: parseProfileReport(child.stdout, profile.name),
    maxRssKiB: gnuTime ? parseMaxRssKiB(child.stderr || '') : null,
  }
}

function mergeProfileReports (profileRuns) {
  const timings = {}
  const fingerprints = {}
  const profiles = []
  let documents = 0
  let terms = 0

  for (const { report } of profileRuns) {
    const profile = report.profile || 'core'
    const workloads = Object.keys(report.timings)
    profiles.push({ name: profile, corpus: report.corpus, workloads })
    documents += report.corpus.documents
    terms += report.corpus.terms

    for (const [name, timing] of Object.entries(report.timings)) {
      if (timings[name] != null) throw new Error(`duplicate timing name across profiles: ${name}`)
      timings[name] = timing
    }
    for (const [name, fingerprint] of Object.entries(report.fingerprints)) {
      if (fingerprints[name] != null) throw new Error(`duplicate fingerprint name across profiles: ${name}`)
      fingerprints[name] = fingerprint
    }
  }

  return {
    schema: 1,
    corpus: { documents, terms },
    profiles,
    fingerprints,
    timings,
  }
}

function runEngine (name, command, gnuTime) {
  const profileRuns = outputFiles.map(profile => runProfile(command, profile, gnuTime))
  const maxRssKiB = {}
  for (let i = 0; i < outputFiles.length; i++) {
    maxRssKiB[outputFiles[i].name] = profileRuns[i].maxRssKiB
  }
  return {
    name,
    command,
    version: versionFor(command),
    report: mergeProfileReports(profileRuns),
    maxRssKiB,
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

function formatMiB (kiB) {
  return `${(kiB / 1024).toFixed(1)} MiB`
}

function printProfileTable (runs, profile) {
  const reference = runs.find(run => run.name === 'node') || runs[0]
  const refProfile = reference.report.profiles.find(item => item.name === profile.name)
  const workloads = refProfile.workloads
  console.log(`\nProfile: ${profile.name} — ${profile.corpus.documents} docs, ${profile.corpus.terms} terms`)
  console.log(`Reference: ${reference.name} (${reference.version})\n`)
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

function printMemoryTable (runs) {
  const reference = runs.find(run => run.name === 'node') || runs[0]
  const profiles = reference.report.profiles.map(profile => profile.name)
  const hasMemory = runs.some(run => profiles.some(profile => run.maxRssKiB[profile] != null))
  if (!hasMemory) return

  console.log('\nOS peak RSS by isolated profile (GNU time; lower is better)')
  const width = 25
  console.log(['engine', ...profiles].map(value => value.padEnd(width)).join(''))
  console.log('-'.repeat(width * (profiles.length + 1)))
  for (const run of runs) {
    const cells = [run.name.padEnd(width)]
    for (const profile of profiles) {
      const rss = run.maxRssKiB[profile]
      const refRss = reference.maxRssKiB[profile]
      if (rss == null || refRss == null) {
        cells.push('n/a'.padEnd(width))
      } else {
        cells.push(`${formatMiB(rss)} ${(rss / refRss).toFixed(2)}x`.padEnd(width))
      }
    }
    console.log(cells.join(''))
  }
}

function printTables (runs) {
  const reference = runs.find(run => run.name === 'node') || runs[0]
  for (const profile of reference.report.profiles) printProfileTable(runs, profile)
  printMemoryTable(runs)
}

async function main () {
  await buildEngineBundle()
  for (const profile of outputFiles) await access(profile.file, constants.R_OK)

  const gnuTime = detectGnuTime()
  if (process.env.FMS_REQUIRE_RSS === '1' && gnuTime == null) {
    throw new Error('GNU time with -v support is required for RSS measurement but was not found')
  }

  const runs = []
  const failures = []
  for (const spec of engineSpecs) {
    const command = resolveCommand(spec)
    if (!executableExists(command)) {
      if (spec.required) failures.push(`${spec.name}: executable not found (${command})`)
      continue
    }
    try {
      runs.push(runEngine(spec.name, command, gnuTime))
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
        runs.push(runEngine('spidermonkey', spiderMonkey, gnuTime))
      } catch (error) {
        failures.push(`spidermonkey (${basename(spiderMonkey)}): ${error.message}`)
      }
    }
  }

  if (runs.length === 0) throw new Error('no JavaScript engine completed the benchmark')
  const mismatches = validateFingerprints(runs)
  printTables(runs)

  console.log('\nJSON:')
  console.log(JSON.stringify({
    schema: 1,
    rssMeasurement: gnuTime == null ? null : { tool: gnuTime, metric: 'maximum-resident-set-size-kib' },
    runs,
    failures,
    mismatches,
  }, null, 2))

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
