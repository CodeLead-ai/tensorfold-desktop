/**
 * SPEC §6 against the real `tensorfold serve` (whichever version is installed) and Qwen3.8-27B-MLX-8bit, through
 * the app's UI:
 *   §6.1 the endorsed preset reaches "serving" with model, port, context and "loaded in"; stop returns to
 *        "stopped" with the exit code,
 *   §6.3 a done line reaches the request feed within a second,
 *   §6.4 the memory gauge moves during a long prefill,
 *   §6.6 the exported snapshot reproduces the command line,
 *   §6.8 the window makes no request beyond its own files.
 * Also: the app knows every line the server prints on stdout (each session's lines go to
 * .tmp/serve-log-<version>-<time>.txt, fixture material), the form has every flag of the binary's serve --help,
 * "Dump stacks" gets the stacks from the real server, and `tensorfold update --check` answers (it asks GitHub).
 * Needs the machine's memory: LM Studio must have nothing loaded (the test checks, and stops if it has).
 * The second run passes --snapshot-dir <tmp>/prefix-snapshots. TensorFold keeps conversation snapshots in the
 * sibling session-snapshots folder, so the probe's conversation stays in the temporary folder and never reaches
 * ~/.cache/tensorfold. The run checks the flag reached the server before it sends the probe.
 *
 * §6.5 runs only when asked, since it unloads LM Studio's model and reloads it:
 *   TFDESK_REAL_LMS=1 TFDESK_RESTORE_COMMAND='<your reload command>' npx vitest run -c vitest.real.config.ts -t 6.5
 * It needs LM Studio running with a model loaded and idle, and port 8080 free.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DeskApi, ServerState } from '@shared/api'
import { FLAGS } from '@shared/config'
import type { LogLine } from '@shared/events'
import { reproduceCommandLine, type ServingSnapshot } from '@shared/snapshot'
import { ROOT } from '../helpers'

/** The page's API, inside page.evaluate callbacks (this file is checked without the DOM library). */
declare const window: { tfdesk: DeskApi }

const MODEL = join(homedir(), '.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit')
const available = existsSync(join(MODEL, 'config.json'))
const lmsRun = process.env['TFDESK_REAL_LMS'] === '1'
const restoreCommand = process.env['TFDESK_RESTORE_COMMAND'] ?? ''

let app: ElectronApplication
let page: Page
let work: string
let failed = false
/** Printed, and kept in .tmp/acceptance.log (vitest hides a passing test's output outside a terminal). */
const log = (...args: unknown[]): void => {
  console.log('[acceptance]', ...args)
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  appendFileSync(join(ROOT, '.tmp', 'acceptance.log'), `${new Date().toISOString()} ${args.map(String).join(' ')}\n`)
}

beforeAll(async () => {
  if (!available) return
  work = mkdtempSync(join(tmpdir(), 'tfdesk-real-'))
  mkdirSync(join(work, 'profile'))
  const env = { ...process.env } as Record<string, string>
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['TENSORFOLD_DESK_MOCK']
  app = await electron.launch({ args: [ROOT], env: { ...env, TENSORFOLD_DESK_USER_DATA: join(work, 'profile') } })
  page = await app.firstWindow()
  await page.locator('text=Configuration').waitFor()
})

afterEach((context) => {
  if (context.task.result?.state === 'fail') failed = true
})

afterAll(async () => {
  if (!available) return
  const state = await page?.evaluate(() => window.tfdesk.getSession().then((s) => s.state.status)).catch(() => 'unknown')
  if (state !== 'stopped') await page?.evaluate(() => window.tfdesk.stopServer()).catch(() => undefined)
  await app?.close()
  if (failed) {
    // The logs stay for a look; the snapshots TensorFold saved there (a 36k-token conversation is 2.5 GiB) do not.
    for (const big of ['session-snapshots', 'prefix-snapshots']) rmSync(join(work, big), { recursive: true, force: true })
    log(`kept for a look: ${work} (the app's logs are in profile/logs)`)
  } else rmSync(work, { recursive: true, force: true })
})

const header = (): ReturnType<Page['locator']> => page.locator('header.header')
const button = (scope: ReturnType<Page['locator']> | Page, name: string): ReturnType<Page['locator']> => scope.getByRole('button', { name, exact: true })
const rail = (name: RegExp): ReturnType<Page['locator']> => page.locator('nav.rail').getByRole('button', { name })
const session = (): Promise<{ lines: LogLine[]; state: ServerState }> => page.evaluate(() => window.tfdesk.getSession()) as never

/**
 * The session's server lines, kept in .tmp for a fixture; the stdout lines the parser does not know fail the run
 * (stderr may hold a stack dump, which is plain text).
 */
async function everyLineKnown(label: string): Promise<void> {
  const { lines, state } = await session()
  const server = lines.filter((l) => l.stream !== 'desk')
  const file = join(ROOT, '.tmp', `serve-log-${state.version ?? 'unknown'}-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`)
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  writeFileSync(file, server.map((l) => l.text).join('\n') + '\n')
  const unknown = server.filter((l) => l.stream === 'stdout' && l.event.kind === 'unknown').map((l) => l.text)
  log(`${server.length} server lines kept in ${file}; ${unknown.length} stdout lines unknown to the parser`)
  for (const text of unknown) log('  unknown:', text)
  expect(unknown).toEqual([])
}

/** Refuses to load the 27B beside a model LM Studio holds (SPEC §2.4: unload it first). */
async function lmStudioIsEmpty(): Promise<void> {
  const lms = await page.evaluate(() => window.tfdesk.lmStudioStatus())
  const loaded = lms.available ? lms.models.map((m) => `${m.identifier} (${m.status})`) : []
  log('LM Studio:', lms.available ? loaded.join(', ') || 'nothing loaded' : lms.error)
  expect(loaded, 'LM Studio has a model loaded: unload it before this run').toEqual([])
}

/** Start, and wait for serving; a death while loading fails at once with the server's last lines. */
async function startAndServe(): Promise<ServerState> {
  return serveAfter(() => button(header(), 'Start').click())
}

async function serveAfter(click: () => Promise<void>): Promise<ServerState> {
  const before = (await session()).state.sessionId
  const t0 = Date.now()
  await click()
  for (;;) {
    const { state } = await session()
    if (state.sessionId !== before && state.status === 'serving') {
      log(`serving after ${((Date.now() - t0) / 1000).toFixed(1)} s (session ${state.sessionId})`)
      return state
    }
    if (state.sessionId !== before && state.status === 'stopped') {
      throw new Error(`the server died while loading:\n${state.lastExit?.lastLines.map((l) => l.text).join('\n')}`)
    }
    if (Date.now() - t0 > 5 * 60_000) throw new Error(`not serving after 5 minutes (${state.status})`)
    await page.waitForTimeout(500)
  }
}

describe.skipIf(!available)('SPEC §6 against the real server', () => {
  it('§6.1: the endorsed preset serves, then stops with its exit code', async () => {
    await lmStudioIsEmpty()
    const binary = await page.evaluate(() => window.tfdesk.detectBinary())
    log(`tensorfold ${binary.version} at ${binary.path}; serve --help lists ${binary.serveHelp?.length ?? 'no'} flags`)
    const listed = new Set((binary.serveHelp ?? []).map((f) => f.cli))
    expect(binary.serveHelp?.length).toBeGreaterThan(0)
    expect(FLAGS.filter((f) => !listed.has(f.cli)).map((f) => f.cli), "the app's flags the binary lacks").toEqual([])
    expect((binary.serveHelp ?? []).filter((f) => !FLAGS.some((k) => k.cli === f.cli)).map((f) => f.cli), 'flags new to the app').toEqual([])
    await expect.poll(() => page.locator('pre.command').innerText(), { timeout: 20_000 }).toContain(' serve ')
    const command = (await page.locator('pre.command').innerText()).replace(/\s+/g, ' ')
    log('command:', command)
    expect(command).toMatch(new RegExp(`/tensorfold serve ${MODEL.replace(/[.]/g, '\\.')} --port 8080 --context 89600 --reasoning-effort medium --no-update-check$`))

    const state = await startAndServe()
    expect(state.commandLine).toBe(command)
    const chips = (await header().innerText()).replace(/\s+/g, ' ')
    log('header:', chips)
    expect(chips).toContain('Qwen3.8-27B-MLX-8bit')
    expect(chips).toContain('port 8080')
    expect(chips).toContain('context 89,600')
    expect(chips).toMatch(/loaded in [\d.]+ s/)
    expect(chips).toContain(`tensorfold ${binary.version}`)
    const kept = state.info.resumable
    log(kept ? `prompts kept up to ${kept.tokens} tokens (with the reply) in the ${kept.budgetGib} GiB budget` : 'no kept-prompt line (the budget keeps the whole window, or TensorFold is older than 0.4.0)')

    await button(header(), 'Stop').click()
    await header().locator('text=exit 0').waitFor({ timeout: 90_000 })
    expect(await header().locator('.state').innerText()).toBe('Stopped')
    const s = await session()
    expect(s.state.lastExit).toMatchObject({ code: 0, requested: true })
    log('stopped: exit', s.state.lastExit?.code, '· log file', s.state.logFile)
    expect(readFileSync(s.state.logFile as string, 'utf8')).toContain('[tensorfold] serving Qwen3.8-27B-MLX-8bit at http://127.0.0.1:8080/v1')
    await everyLineKnown('6.1')

    // Asks GitHub from the CLI; offline is an answer too.
    const update = await page.evaluate(() => window.tfdesk.checkUpdate())
    log('update --check:', update.ok ? (update.newer ? `${update.latest} is out (this is ${update.current})` : `${update.current} is the latest`) : update.error)
    expect(update.ok || /could not reach GitHub/.test(update.error ?? '')).toBe(true)
  })

  it('§6.3, §6.4, §6.6, §6.8: a long prefill moves the gauge; the feed, the snapshot and the audit hold', async () => {
    await lmStudioIsEmpty()
    const snapshotDir = join(work, 'prefix-snapshots')
    await page.locator('label.field:has(code:text-is("--snapshot-dir")) input').fill(snapshotDir)
    await expect.poll(() => page.locator('pre.command').innerText()).toContain(`--snapshot-dir ${snapshotDir}`)
    const state = await startAndServe()
    if (!state.commandLine.includes(`--snapshot-dir ${snapshotDir}`)) {
      await page.evaluate(() => window.tfdesk.stopServer())
      throw new Error(`the server runs without the test's --snapshot-dir; stopped it before any request:\n${state.commandLine}`)
    }
    log('command:', state.commandLine)

    await rail(/Server/).click()
    await page.locator('text=of what MLX may use').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(2500)
    const activeGib = async (): Promise<number | null> => {
      const text = await page.locator('.legend-item:has(.label:text-is("active")) .value').innerText().catch(() => '')
      const m = /([\d.]+) GiB/.exec(text)
      return m ? Number(m[1]) : null
    }
    const before = await activeGib()
    log('active before the probe:', before, 'GiB')

    const sentence = (i: number): string => `Record ${i}: the lane kernels verify eight rows a round while the drafter proposes the next block of tokens.`
    const prompt = `${Array.from({ length: 1400 }, (_, i) => sentence(i + 1)).join('\n')}\n\nIn one word, what do the records repeat?`
    await rail(/Probe/).click()
    await page.locator('textarea').first().fill(prompt)
    await page.locator('label.field:has(code:text-is("max_tokens")) input').fill('16')
    const clicked = Date.now()
    await button(page, 'Run the probe').click()

    await rail(/Server/).click()
    const samples: number[] = []
    while (Date.now() - clicked < 10 * 60_000) {
      const v = await activeGib()
      if (v !== null) samples.push(v)
      const s = await session()
      if (s.lines.some((l) => l.event.kind === 'done')) break
      if (s.state.sessionId !== state.sessionId || s.state.status !== 'serving') throw new Error(`the server left serving during the probe (${s.state.status})`)
      await page.waitForTimeout(1000)
    }
    log('active during the prefill (GiB, every 1 s):', samples.join(' '))
    expect(before).not.toBeNull()
    expect(Math.max(...samples) - (before as number)).toBeGreaterThan(0.3)

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
    await button(page, 'Export snapshot').click()
    const path = (await page.locator('span.mono:has-text("serving-")').innerText()).trim()
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as ServingSnapshot
    expect(snapshot.commandLine).toBe(state.commandLine)
    expect(reproduceCommandLine(snapshot)).toBe(snapshot.commandLine)
    log('snapshot:', path)

    // SIGUSR1: the real server prints every thread's stack on stderr, and keeps serving.
    const dumpAt = Date.now()
    expect(await page.evaluate(() => window.tfdesk.dumpStacks())).toEqual({ ok: true })
    for (;;) {
      const { lines, state: now } = await session()
      if (lines.some((l) => l.stream === 'stderr' && l.at >= dumpAt && /^Current thread 0x/.test(l.text))) break
      if (now.status !== 'serving') throw new Error(`the server left serving after SIGUSR1 (${now.status})`)
      if (Date.now() - dumpAt > 15_000) throw new Error('no stack dump on stderr 15 s after SIGUSR1')
      await page.waitForTimeout(250)
    }
    const threads = (await session()).lines.filter((l) => l.stream === 'stderr' && l.at >= dumpAt && /^(Current t|T)hread 0x/.test(l.text)).length
    log(`stack dump: ${threads} threads, ${Date.now() - dumpAt} ms after SIGUSR1; still serving`)

    // §6.8: the window asked for nothing beyond its own files.
    const audit = await page.evaluate(() => window.tfdesk.networkAudit())
    const outside = audit.filter((e) => !e.url.startsWith('file:') && !e.url.startsWith('devtools:') && !e.url.startsWith('data:'))
    log(`network audit: ${audit.length} requests, ${outside.length} beyond the app's files`)
    expect(outside).toEqual([])

    await button(header(), 'Stop').click()
    await header().locator('text=exit 0').waitFor({ timeout: 120_000 })
    const kept = existsSync(join(work, 'session-snapshots')) ? 'in the test folder' : 'nowhere (none saved)'
    log(`the probe's conversation snapshot: ${kept}`)
    await everyLineKnown('probe')
  })

  it.skipIf(!lmsRun)('§6.5: without lms, a clear message; with it, unload LM Studio then serve, and stop then restore', async () => {
    expect(restoreCommand, 'set TFDESK_RESTORE_COMMAND').not.toBe('')
    const card = page.locator('section.card:has(h2:text-is("LM Studio"))')
    const setting = async (label: string, value: string): Promise<void> => {
      await rail(/Settings/).click()
      const input = page.locator(`label.field:has(span:text-is("${label}")) input`)
      await input.fill(value)
      await input.press('Tab')
      await page.waitForTimeout(300)
    }

    // No lms: the card says so, and offers nothing to run.
    await setting('lms', '/nonexistent/lms')
    await rail(/Server/).click()
    await card.locator("text=LM Studio's lms was not found").waitFor({ timeout: 20_000 })
    log('without lms:', (await card.locator('.issue').innerText()).replace(/\s+/g, ' '))

    // The real lms, and the restore command.
    await setting('lms', '')
    await setting('Restore command', restoreCommand)
    await rail(/Server/).click()
    await card.locator('table td').first().waitFor({ timeout: 30_000 })
    const before = await page.evaluate(() => window.tfdesk.lmStudioStatus())
    const describe = (s: typeof before): string => s.models.map((m) => `${m.identifier} (${m.status}, ctx ${m.contextLength})`).join(', ') || 'nothing loaded'
    log('LM Studio before:', describe(before))
    expect(before.models.length, 'LM Studio has no model to unload').toBeGreaterThan(0)
    expect(before.models.filter((m) => m.status === 'generating'), 'LM Studio is busy').toEqual([])
    // Never unload a model that is generating: the app asks first, and this test says no.
    page.on('dialog', (dialog) => void dialog.dismiss())

    const unloadAt = Date.now()
    const serving = await serveAfter(() => button(card, 'Unload LM Studio, then serve').click())
    const unloaded = await page.evaluate(() => window.tfdesk.lmStudioStatus())
    log(`unloaded and serving after ${((Date.now() - unloadAt) / 1000).toFixed(1)} s; LM Studio now: ${describe(unloaded)}`)
    expect(unloaded.models).toEqual([])
    expect(serving.commandLine).toMatch(/--port 8080 --context 89600 --reasoning-effort medium --no-update-check$/)
    log('unload step:', (await card.innerText()).replace(/\s+/g, ' ').slice(0, 400))

    const restoreAt = Date.now()
    await button(card, 'Stop, then restore').click()
    let restored: typeof unloaded
    for (;;) {
      const s = await session()
      restored = await page.evaluate(() => window.tfdesk.lmStudioStatus())
      const done = await card.locator('.tag.ok, .tag.bad').filter({ hasText: /ok|exit|timed out|failed/ }).count()
      if (s.state.status === 'stopped' && restored.models.length > 0 && done > 0) {
        log(`stopped (exit ${s.state.lastExit?.code}) and restored after ${((Date.now() - restoreAt) / 1000).toFixed(1)} s; LM Studio now: ${describe(restored)}`)
        expect(s.state.lastExit).toMatchObject({ code: 0, requested: true })
        break
      }
      if (Date.now() - restoreAt > 15 * 60_000) throw new Error(`not restored after 15 minutes (${s.state.status}; ${describe(restored)})`)
      await page.waitForTimeout(2000)
    }
    const output = (await card.locator('pre.lines-box').last().innerText().catch(() => '')).split('\n').slice(-20).join('\n')
    log(`restore command output (last lines):\n${output}`)
    expect(await card.locator('.tag.ok').count()).toBeGreaterThan(0)
    expect(restored.models.map((m) => m.identifier)).toEqual(before.models.map((m) => m.identifier))
  })
})
