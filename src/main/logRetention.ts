/**
 * The session-log cap: <userData>/logs holds one file per server session (<start-stamp>.log). The newest
 * `keep` stay; 0 keeps them all. Only files named like the app's own session logs are ever deleted, and never
 * the one being written.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

/** `2026-09-29T15-22-21.log`, as ProcessManager names them. */
export const SESSION_LOG = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.log$/

/** The session logs in `dir`, oldest first (the stamp sorts by time). */
export function sessionLogs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => SESSION_LOG.test(name))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/** Deletes all but the newest `keep` session logs; returns what it deleted. */
export function pruneLogs(dir: string, keep: number, protect: string | null = null): string[] {
  if (!Number.isInteger(keep) || keep <= 0) return []
  const logs = sessionLogs(dir)
  // The log being written counts among those kept even before its stream has created the file.
  if (protect && SESSION_LOG.test(basename(protect)) && !logs.includes(protect)) {
    logs.push(protect)
    logs.sort()
  }
  const removed: string[] = []
  for (const path of logs.slice(0, Math.max(0, logs.length - keep))) {
    if (path === protect) continue
    try {
      unlinkSync(path)
      removed.push(path)
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed
}

export function logStats(dir: string): { files: number; bytes: number } {
  let bytes = 0
  const logs = sessionLogs(dir)
  for (const path of logs) {
    try {
      bytes += statSync(path).size
    } catch {
      // removed meanwhile
    }
  }
  return { files: logs.length, bytes }
}
