import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPreset, emptyConfig } from '@shared/config'
import { defaultSettings, sanitizeSettings } from '@shared/settings'
import { Desk } from '../../src/main/Desk'
import { logStats, pruneLogs, sessionLogs } from '../../src/main/logRetention'
import { ProcessManager } from '../../src/main/ProcessManager'
import { MemorySettings } from '../../src/main/Settings'
import { FAST_MOCK_ENV, MOCK, MOCK_MODEL, freePort } from '../helpers'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A logs folder with `n` session logs, one a day from 2026-01-01, plus files that are not the app's. */
function logsDir(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tfdesk-logs-'))
  dirs.push(dir)
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
    writeFileSync(join(dir, `${day}T09-00-00.log`), 'x'.repeat(10))
  }
  writeFileSync(join(dir, 'notes.txt'), 'mine')
  writeFileSync(join(dir, 'other.log'), 'not a session log')
  mkdirSync(join(dir, '2026-01-01T00-00-00.log.d'))
  return dir
}

const names = (dir: string): string[] => readdirSync(dir).sort()

describe('the session-log cap', () => {
  it('keeps the newest ones and deletes nothing that is not a session log', () => {
    const dir = logsDir(60)
    const removed = pruneLogs(dir, 50)
    expect(removed).toHaveLength(10)
    expect(removed[0]).toMatch(/2026-01-01T09-00-00\.log$/)
    expect(sessionLogs(dir)).toHaveLength(50)
    expect(sessionLogs(dir)[0]).toMatch(/2026-01-11T09-00-00\.log$/)
    expect(names(dir)).toEqual(expect.arrayContaining(['notes.txt', 'other.log', '2026-01-01T00-00-00.log.d']))
    expect(logStats(dir)).toEqual({ files: 50, bytes: 500 })
  })

  it('keeps everything at 0, and when there are fewer than the cap', () => {
    const dir = logsDir(5)
    expect(pruneLogs(dir, 0)).toEqual([])
    expect(pruneLogs(dir, 50)).toEqual([])
    expect(sessionLogs(dir)).toHaveLength(5)
  })

  it('never deletes the log being written', () => {
    const dir = logsDir(3)
    const current = sessionLogs(dir)[0] as string
    pruneLogs(dir, 1, current)
    expect(sessionLogs(dir)).toEqual([current, sessionLogs(dir)[1]])
  })

  it('does nothing for a folder that is not there', () => {
    expect(pruneLogs('/nonexistent/logs', 1)).toEqual([])
    expect(logStats('/nonexistent/logs')).toEqual({ files: 0, bytes: 0 })
  })

  it('prunes when a server session starts, keeping the new log', async () => {
    const dir = logsDir(5)
    const manager = new ProcessManager({ logDir: dir, keepLogs: 3, env: { ...process.env, ...FAST_MOCK_ENV, MOCK_TENSORFOLD_INTERVAL_MS: '0' }, stopGraceMs: 5000 })
    const config = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
    config.endpoint.port = await freePort()
    manager.start({ binary: MOCK, config })
    const current = manager.state.logFile as string
    for (let i = 0; i < 50 && !existsSync(current); i++) await new Promise((r) => setTimeout(r, 20))
    const logs = sessionLogs(dir)
    expect(logs).toHaveLength(3)
    expect(logs).toContain(current)
    expect(logs[0]).toMatch(/2026-01-04T09-00-00\.log$/)
    await manager.stop()
  })

  it('applies a lower cap at once, and reports the logs', () => {
    const dir = logsDir(6)
    const desk = new Desk({
      settings: new MemorySettings(defaultSettings('/Users/test')),
      env: process.env,
      home: '/Users/test',
      logDir: dir,
      snapshotDir: null,
      infoCacheFile: null,
      mockBinary: MOCK,
      mock: true,
      appVersion: '0.0.0-test',
      platform: 'darwin'
    })
    expect(desk.logsInfo()).toEqual({ dir, files: 6, bytes: 60, keep: 50 })
    desk.setSettings({ keepLogs: 2 })
    expect(desk.logsInfo()).toEqual({ dir, files: 2, bytes: 20, keep: 2 })
    desk.dispose()
  })

  it('is a whole number from 0, 50 unless set', () => {
    const defaults = defaultSettings('/Users/test')
    expect(defaults.keepLogs).toBe(50)
    expect(sanitizeSettings({ keepLogs: -3 }, defaults).keepLogs).toBe(0)
    expect(sanitizeSettings({ keepLogs: 2.6 }, defaults).keepLogs).toBe(3)
    expect(sanitizeSettings({ keepLogs: 'x' }, defaults).keepLogs).toBe(50)
  })
})
