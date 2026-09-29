/**
 * `npm run screens`: a screenshot of each view against the mock, into docs/screens (build prompt, last step).
 * Runs only when TENSORFOLD_DESK_SCREENS names a folder: it starts the mock server, lets requests arrive,
 * uses each view as a person would (a pull, a probe, a snapshot), saves a PNG of each, shows a death too,
 * and quits.
 */
import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CHANNELS } from '@shared/api'
import type { Desk } from './Desk'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > end) throw new Error('screenshots: timed out waiting')
    await sleep(150)
  }
}

export async function captureScreens(win: BrowserWindow, desk: Desk, dirArg: string): Promise<void> {
  const dir = resolve(dirArg)
  mkdirSync(dir, { recursive: true })
  const theme = process.env['TENSORFOLD_DESK_SCREENS_THEME']
  if (theme === 'light' || theme === 'dark') desk.setSettings({ theme })
  win.setContentSize(1440, 900)
  win.center()
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
  await sleep(1200)

  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>
  const click = (text: string): Promise<boolean> =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled); if (b) b.click(); return !!b })()`)
  const has = (selector: string, text: string): Promise<boolean> =>
    js<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.textContent.includes(${JSON.stringify(text)}))`)
  const show = async (view: string): Promise<void> => {
    win.webContents.send(CHANNELS.navigate, view)
    await sleep(700)
  }
  const shoot = async (name: string): Promise<void> => {
    await sleep(700)
    const image = await win.webContents.capturePage()
    const scaled = image.getSize().width > 1440 ? image.resize({ width: 1440, quality: 'best' }) : image
    writeFileSync(join(dir, `${name}.png`), scaled.toPNG())
  }

  const result = await desk.start(desk.settings.lastConfig)
  if (!result.ok) throw new Error(`screenshots: ${result.error}`)
  await until(() => desk.manager.state.status === 'serving', 30_000)
  await until(() => desk.manager.state.info.done >= 18 && desk.manager.state.info.refused >= 1, 120_000)

  await show('server')
  await click('Export snapshot')
  await shoot('server')
  await js('document.querySelector("main.view").scrollTop = 100000')
  await shoot('server-lower')

  await show('requests')
  await shoot('requests')

  await show('checkpoints')
  await until(async () => (await has('.card h2', 'Servable checkpoints')) && (await has('.ckpt-name', 'Qwen3.8')), 20_000)
  await click('incoai/GLM-5.3-Flash-DFlash2')
  await until(() => has('.pull-box .tag', 'done'), 20_000)
  await shoot('checkpoints')

  await show('probe')
  await click('Run the probe')
  await until(() => has('.card', 'measured here'), 30_000)
  await shoot('probe')

  await show('log')
  await shoot('log')

  await show('settings')
  await shoot('settings')

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
