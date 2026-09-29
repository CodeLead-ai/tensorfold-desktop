import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT, freePort } from '../helpers'

let app: ElectronApplication
let page: Page
let userData: string

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'tfdesk-e2e-'))
  const env = { ...process.env } as Record<string, string>
  delete env['ELECTRON_RUN_AS_NODE']
  app = await electron.launch({
    args: [ROOT],
    env: {
      ...env,
      TENSORFOLD_DESK_MOCK: '1',
      TENSORFOLD_DESK_USER_DATA: userData,
      MOCK_TENSORFOLD_LOAD_MS: '600',
      MOCK_TENSORFOLD_TIME_SCALE: '0.003',
      MOCK_TENSORFOLD_INTERVAL_MS: '100'
    }
  })
  page = await app.firstWindow()
  await page.locator('text=Configuration').waitFor()
})

afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

const header = (): ReturnType<Page['locator']> => page.locator('header.header')
const field = (flag: string): ReturnType<Page['locator']> => page.locator(`label.field:has(code:text-is("${flag}")) input`)

describe('the app against the mock', () => {
  it('starts with the endorsed preset and shows its exact command line', async () => {
    await expect.poll(() => page.locator('pre.command').innerText()).toMatch(/serve .*Qwen3\.8-27B-MLX-8bit --port 8080 --context 89600 --reasoning-effort medium --no-update-check$/)
    expect(await page.locator('.segmented button.on').first().innerText()).toBe('CodeLead endorsed')
  })

  it('blocks a folder without config.json', async () => {
    const model = page.getByRole('textbox', { name: /^Model/ })
    const good = await model.inputValue()
    await model.fill(join(ROOT, 'mock/models/lmstudio-community/Muse-Glimmer-30B-GGUF'))
    await page.locator('.issue.error:has-text("no config.json")').waitFor()
    await model.fill(good)
    await page.locator('.issue.error').waitFor({ state: 'detached' })
  })

  it('serves, streams requests, tracks memory, and stops with exit code 0', async () => {
    const port = await freePort()
    await field('--port').fill(String(port))
    await expect.poll(() => page.locator('pre.command').innerText()).toContain(`--port ${port}`)
    await header().getByRole('button', { name: 'Start' }).click()
    await header().locator('.state.serving').waitFor({ timeout: 30_000 })
    const chips = await header().locator('.chips').innerText()
    expect(chips).toContain(String(port))
    expect(chips).toContain('89,600')
    expect(chips).toContain('z-lab/Qwen3.8-27B-DFlash2')

    await page.locator('text=of what MLX may use').waitFor({ timeout: 15_000 })

    await page.locator('nav.rail').getByRole('button', { name: /Requests/ }).click()
    await expect.poll(() => page.locator('table.data tbody tr').count(), { timeout: 30_000 }).toBeGreaterThan(3)

    await page.locator('nav.rail').getByRole('button', { name: /Log/ }).click()
    await expect.poll(() => page.locator('.log-line').count()).toBeGreaterThan(10)

    await header().getByRole('button', { name: 'Stop' }).click()
    await header().locator('text=exit 0').waitFor({ timeout: 30_000 })
    expect(await header().locator('.state').innerText()).toBe('Stopped')
  })
})
