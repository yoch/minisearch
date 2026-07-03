import { performance } from 'node:perf_hooks'
import { argValue } from '../benchmarkUtils.js'
import { median } from '../benchStats.js'

export { argValue, median }

export function intArg(name, fallback, { min = 1 } = {}) {
  const raw = argValue(`--${name}`)
  const value = raw == null ? NaN : Number(raw)
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback
}

export function listArg(name, fallback) {
  const raw = argValue(`--${name}`)
  if (raw == null || raw.trim() === '') return fallback
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

export function boolArg(name, fallback = false) {
  const raw = argValue(`--${name}`)
  if (raw == null) return process.argv.includes(`--${name}`) || fallback
  return raw !== '0' && raw !== 'false'
}

export function p95(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

export function timed(fn, warmup, iterations) {
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    const value = fn()
    sink += value?.size ?? value?.length ?? 0
  }
  if (typeof globalThis.gc === 'function') globalThis.gc()

  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    const value = fn()
    samples.push(performance.now() - t0)
    sink += value?.size ?? value?.length ?? 0
  }
  return { p50: median(samples), p95: p95(samples), sink }
}
