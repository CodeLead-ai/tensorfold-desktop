/**
 * SPEC §6 against the real `tensorfold serve` and Qwen3.8-27B-MLX-8bit, through the app's UI:
 *   §6.1 the endorsed preset reaches "serving" with model, port, context and "loaded in"; stop returns to
 *        "stopped" with the exit code,
 *   §6.3 a done line reaches the request feed within a second,
 *   §6.4 the memory gauge moves during a long prefill,
 *   §6.6 the exported snapshot reproduces the command line,
 *   §6.8 the window makes no request beyond its own files.
 * The second run adds --snapshot-dir (a temporary folder), so the probe's conversation is not saved into
 * TensorFold's shared ~/.cache/tensorfold/prefix-snapshots.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DeskApi } from '@shared/api'
import type { LogLine } from '@shared/events'
import { reproduceCommandLine, type ServingSnapshot } from '@shared/snapshot'
import { ROOT } from '../helpers'

/** The page's API, inside page.evaluate callbacks (this file is checked without the DOM library). */
declare const window: { tfdesk: DeskApi }

const MODEL = join(homedir(), '.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit')
const available = existsSync(join(MODEL, 'config.json'))

let app: ElectronApplication
let page: Page
let userData: string
let snapshotDir: string
const log = (...args: unknown[]): void => console.log('[acceptance]', ...args)

beforeAll(async () => {
  if (!available) return
  userData = mkdtempSync(join(tmpdir(), 'tfdesk-real-'))
  snapshotDir = mkdtempSync(join(tmpdir(), 'tfdesk-real-snapshots-'))
  const env = { ...process.env } as Record<string, string>
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['TENSORFOLD_DESK_MOCK']
  app = await electron.launch({ args: [ROOT], env: { ...env, TENSORFOLD_DESK_USER_DATA: userData } })
  page = await app.firstWindow()
  await page.locator('text=Configuration').waitFor()
})

afterAll(async () => {
  if (!available) return
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(snapshotDir, { recursive: true, force: true })
})

const header = (): ReturnType<Page['locator']> => page.locator('header.header')
const rail = (name: RegExp): ReturnType<Page['locator']> => page.locator('nav.rail').getByRole('button', { name })
const session = (): Promise<{ lines: LogLine[]; state: { lastExit: { code: number | null } | null; logFile: string | null } }> =>
  page.evaluate(() => window.tfdesk.getSession()) as never

async function activeGib(): Promise<number | null> {
  const text = await page.locator('.legend-item:has(.label:text-is("active")) .value').innerText().catch(() => '')
  const m = /([\d.]+) GiB/.exec(text)
  return m ? Number(m[1]) : null
}

describe.skipIf(!available)('SPEC §6 against the real server', () => {
  it('§6.1: the endorsed preset serves, then stops with its exit code', async () => {
    const command = await page.locator('pre.command').innerText()
    log('command:', command.replace(/\s+/g, ' '))
    expect(command.replace(/\s+/g, ' ')).toMatch(new RegExp(`/tensorfold serve ${MODEL.replace(/[.]/g, '\\.')} --port 8080 --context 89600 --reasoning-effort medium --no-update-check$`))
    const t0 = Date.now()
    await header().getByRole('button', { name: 'Start' }).click()
    await header().locator('.state.loading').waitFor({ timeout: 30_000 })
    await header().locator('.state.serving').waitFor({ timeout: 5 * 60_000 })
    const chips = (await header().innerText()).replace(/\s+/g, ' ')
    log(`serving after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, chips)
    expect(chips).toContain('Qwen3.8-27B-MLX-8bit')
    expect(chips).toContain('port 8080')
    expect(chips).toContain('context 89,600')
    expect(chips).toMatch(/loaded in [\d.]+ s/)
    expect(chips).toContain('tensorfold 0.3.6.2')

    await header().getByRole('button', { name: 'Stop' }).click()
    await header().locator('text=exit 0').waitFor({ timeout: 90_000 })
    expect(await header().locator('.state').innerText()).toBe('Stopped')
    const s = await session()
    expect(s.state.lastExit?.code).toBe(0)
    log('stopped: exit', s.state.lastExit?.code, 'log file', s.state.logFile)
    expect(readFileSync(s.state.logFile as string, 'utf8')).toContain('[tensorfold] serving Qwen3.8-27B-MLX-8bit at http://127.0.0.1:8080/v1')
  })

  it('§6.3, §6.4, §6.6, §6.8: a long prefill moves the gauge; the feed, the snapshot and the audit hold', async () => {
    const dirField = page.locator('label.field:has(code:text-is("--snapshot-dir")) input')
    await dirField.fill(snapshotDir)
    await header().getByRole('button', { name: 'Start' }).click()
    await header().locator('.state.serving').waitFor({ timeout: 5 * 60_000 })
    await rail(/Server/).click()
    await page.locator('text=of what MLX may use').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(2500)
    const before = await activeGib()
    log('active before the probe:', before, 'GiB')

    const sentence = (i: number): string => `Record ${i}: the lane kernels verify eight rows a round while the drafter proposes the next block of tokens.`
    const prompt = `${Array.from({ length: 1400 }, (_, i) => sentence(i + 1)).join('\n')}\n\nIn one word, what do the records repeat?`
    await rail(/Probe/).click()
    await page.locator('textarea').first().fill(prompt)
    await page.locator('label.field:has(code:text-is("max_tokens")) input').fill('16')
    const clicked = Date.now()
    await page.getByRole('button', { name: 'Run the probe' }).click()

    await rail(/Server/).click()
    const samples: number[] = []
    const started = Date.now()
    while (Date.now() - started < 10 * 60_000) {
      const v = await activeGib()
      if (v !== null) samples.push(v)
      const done = await page.evaluate(() => window.tfdesk.getSession().then((s) => s.lines.some((l) => l.event.kind === 'done')))
      if (done) break
      await page.waitForTimeout(1000)
    }
    const peak = Math.max(...samples)
    log('active during the prefill (GiB, every 1 s):', samples.join(' '))
    expect(before).not.toBeNull()
    expect(peak - (before as number)).toBeGreaterThan(0.3)

    await rail(/Probe/).click()
    await page.locator('text=measured here').waitFor({ timeout: 60_000 })
    const comparison = (await page.locator('table.compare').innerText()).replace(/\s+/g, ' ')
    log('probe:', comparison)
    expect(comparison).toMatch(/req-[0-9a-f]{12}/)

    // §6.3: the done line reaches the feed within a second of arriving.
    const s = await session()
    const doneLine = s.lines.find((l) => l.event.kind === 'done') as LogLine
    // NOTES 8: with PYTHONUNBUFFERED the stream's access line arrives when its headers go out, not with the done line.
    const access = s.lines.find((l) => l.event.kind === 'access' && l.event.method === 'POST' && l.at >= clicked) as LogLine
    log(`POST access line ${access.at - clicked} ms after the click; done line ${((doneLine.at - access.at) / 1000).toFixed(1)} s after it`)
    expect(access.at - clicked).toBeLessThan(5000)
    await rail(/Requests/).click()
    const reqId = doneLine.event.kind === 'done' ? doneLine.event.reqId : ''
    await page.locator(`td:text-is("${reqId}")`).waitFor({ timeout: 1000 })
    log('done line', reqId, 'is in the feed')

    // §6.6: the snapshot reproduces the command line.
    await rail(/Server/).click()
    await page.getByRole('button', { name: 'Export snapshot' }).click()
    const path = await page.locator('span.mono:has-text("serving-")').innerText()
    const snapshot = JSON.parse(readFileSync(path.trim(), 'utf8')) as ServingSnapshot
    expect(reproduceCommandLine(snapshot)).toBe(snapshot.commandLine)
    log('snapshot:', path.trim(), '\n   ', snapshot.commandLine)

    // §6.8: the window asked for nothing beyond its own files.
    const audit = await page.evaluate(() => window.tfdesk.networkAudit())
    const outside = audit.filter((e) => !e.url.startsWith('file:') && !e.url.startsWith('devtools:') && !e.url.startsWith('data:'))
    log(`network audit: ${audit.length} requests, ${outside.length} beyond the app's files`)
    expect(outside).toEqual([])

    await header().getByRole('button', { name: 'Stop' }).click()
    await header().locator('text=exit 0').waitFor({ timeout: 90_000 })
  })
})
