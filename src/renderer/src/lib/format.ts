import { GIB } from '@shared/health'

const DASH = '–'

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function int(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? DASH : intFormat.format(n)
}

export function fixed(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? DASH : n.toFixed(digits)
}

export function gib(bytes: number | null | undefined, digits = 2): string {
  return bytes === null || bytes === undefined ? DASH : (bytes / GIB).toFixed(digits)
}

export function percent(fraction: number | null | undefined, digits = 1): string {
  return fraction === null || fraction === undefined || !Number.isFinite(fraction) ? DASH : `${(fraction * 100).toFixed(digits)}%`
}

export function secs(s: number | null | undefined, digits = 2): string {
  return s === null || s === undefined ? DASH : `${s.toFixed(digits)} s`
}

/** 12.3 s, 4:05, 1:23:45 */
export function duration(ms: number): string {
  if (ms < 0) ms = 0
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${(ms / 1000).toFixed(1)} s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** 23.1k, 1.2M */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return intFormat.format(n)
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function bytes(n: number): string {
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`
  return `${n} B`
}
