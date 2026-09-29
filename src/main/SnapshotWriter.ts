/** Writes the serving snapshot (SPEC §3.10) to <userData>/snapshots/serving-<start-stamp>.json. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, release, totalmem } from 'node:os'
import { join } from 'node:path'
import type { ServerState } from '@shared/api'
import type { HealthMemory } from '@shared/health'
import { buildSnapshot, type ServingSnapshot } from '@shared/snapshot'
import { stamp } from './ProcessManager'

export function machine(): ServingSnapshot['machine'] {
  return { chip: cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(totalmem() / 1024 ** 3), os: `${process.platform} ${release()}` }
}

export function configSha256(modelPath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(join(modelPath, 'config.json'))).digest('hex')
  } catch {
    return null
  }
}

export function writeSnapshot(dir: string, state: ServerState, health: HealthMemory | null, appVersion: string): { path: string; json: string } {
  const snapshot = buildSnapshot({
    state,
    health,
    exportedAt: Date.now(),
    appVersion,
    machine: machine(),
    configSha256: state.config ? configSha256(state.config.model) : null
  })
  const json = `${JSON.stringify(snapshot, null, 2)}\n`
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `serving-${stamp(state.startedAt ?? Date.now())}.json`)
  writeFileSync(path, json)
  return { path, json }
}
