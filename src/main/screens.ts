/**
 * `npm run screens`: a screenshot of each view against the mock, into docs/screens (build prompt, last step).
 * Runs only when TENSORFOLD_DESK_SCREENS names a folder: it starts the mock server, lets requests arrive,
 * visits every view, saves a PNG of each, shows a death too, and quits.
 */
import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CHANNELS } from '@shared/api'
import type { Desk } from './Desk'

const VIEWS = ['server', 'requests', 'checkpoints', 'probe', 'log', 'settings'] as const

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('screenshots: timed out waiting')
    await sleep(100)
  }
}

export async function captureScreens(win: BrowserWindow, desk: Desk, dirArg: string, extra: (view: string) => Promise<void> = async () => {}): Promise<void> {
  const dir = resolve(dirArg)
  mkdirSync(dir, { recursive: true })
  win.setContentSize(1440, 900)
  win.center()
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
  await sleep(1200)

  const shoot = async (name: string): Promise<void> => {
    await sleep(900)
    const image = await win.webContents.capturePage()
    const size = image.getSize()
    const scaled = size.width > 1440 ? image.resize({ width: 1440, quality: 'best' }) : image
    writeFileSync(join(dir, `${name}.png`), scaled.toPNG())
  }
  const show = async (view: string): Promise<void> => {
    win.webContents.send(CHANNELS.navigate, view)
    await extra(view)
  }

  const result = await desk.start(desk.settings.lastConfig)
  if (!result.ok) throw new Error(`screenshots: ${result.error}`)
  await until(() => desk.manager.state.status === 'serving', 30_000)
  await until(() => desk.manager.state.info.done >= 18 && desk.manager.state.info.refused >= 1, 120_000)
  for (const view of VIEWS) {
    await show(view)
    await shoot(view)
  }

  await desk.stop()
  desk.setChildEnv('MOCK_TENSORFOLD_FAIL', 'crash')
  desk.setChildEnv('MOCK_TENSORFOLD_INTERVAL_MS', '0')
  await desk.start(desk.settings.lastConfig)
  await until(() => desk.manager.state.status === 'stopped' && desk.manager.state.sessionId > 1, 30_000)
  await show('server')
  await shoot('server-died')
  desk.setChildEnv('MOCK_TENSORFOLD_FAIL', undefined)
  app.exit(0)
}
