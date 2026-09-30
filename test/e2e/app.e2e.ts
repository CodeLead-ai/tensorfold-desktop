import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT, freePort } from '../helpers'

let app: ElectronApplication
let page: Page
let userData: string

/** The built app on a throwaway profile, against the mock (playing 0.5.0 unless `mockEnv` says otherwise). */
async function launch(dir: string, mockEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env } as Record<string, string>
  delete env['ELECTRON_RUN_AS_NODE']
  const launched = await electron.launch({
    args: [ROOT],
    env: {
      ...env,
      TENSORFOLD_DESK_MOCK: '1',
      TENSORFOLD_DESK_USER_DATA: dir,
      MOCK_TENSORFOLD_LOAD_MS: '600',
      MOCK_TENSORFOLD_TIME_SCALE: '0.003',
      MOCK_TENSORFOLD_INTERVAL_MS: '100',
      FAKE_LMS_STATE: join(dir, 'fake-lms.json'),
      ...mockEnv
    }
  })
  const window = await launched.firstWindow()
  await window.locator('text=Configuration').waitFor()
  return { app: launched, page: window }
}

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'tfdesk-e2e-'))
  ;({ app, page } = await launch(userData, { MOCK_TENSORFOLD_MEMORY: 'pressure' }))
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

  it("keeps a flag's value when its name is clicked (a label must not hand the click to the reset button)", async () => {
    await page.locator('label.field code:text-is("--context")').click()
    expect(await field('--context').inputValue()).toBe('89600')
  })

  it('blocks a folder without config.json', async () => {
    const model = page.getByRole('textbox', { name: /^Model/ })
    const good = await model.inputValue()
    await model.fill(join(ROOT, 'mock/models/lmstudio-community/Muse-Glimmer-30B-GGUF'))
    await page.locator('.issue.error:has-text("no config.json")').waitFor()
    await model.fill(good)
    // Only this error: another server on 8080 (a real one, say) adds its own port error, which is right.
    await page.locator('.issue.error:has-text("no config.json")').waitFor({ state: 'detached' })
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
    // 0.4.0+: the endorsed --context is past what the budget keeps for a next turn
    expect(chips).toMatch(/prompts kept\s*≤ 49,664/)

    await page.locator('text=of what MLX may use').waitFor({ timeout: 15_000 })

    await page.locator('nav.rail').getByRole('button', { name: /Requests/ }).click()
    await expect.poll(() => page.locator('table.data tbody tr').count(), { timeout: 30_000 }).toBeGreaterThan(3)
    // the mock's memory pressure ended one stream (0.4.0+'s `memory: ended` line)
    await page.locator('table.data tr.refused .tag:text-is("ended for memory")').waitFor({ timeout: 30_000 })
    expect(await page.locator('.tile:has(.label:text-is("Requests"))').getAttribute('title')).toMatch(/1 of them ended when memory ran short/)

    await page.locator('nav.rail').getByRole('button', { name: /Log/ }).click()
    await expect.poll(() => page.locator('.log-line').count()).toBeGreaterThan(10)
    // SIGUSR1: TensorFold's stack dump arrives on stderr
    await page.getByRole('button', { name: 'Dump stacks' }).click()
    await page.locator('.log-line.s-stderr:has-text("Current thread 0x")').first().waitFor({ timeout: 15_000 })
    expect(await header().locator('.state').innerText()).toBe('Serving')

    await header().getByRole('button', { name: 'Stop' }).click()
    await header().locator('text=exit 0').waitFor({ timeout: 30_000 })
    expect(await header().locator('.state').innerText()).toBe('Stopped')
  })
})

describe('TensorFold releases', () => {
  it('checks for a newer release and says this one is the latest', async () => {
    await page.locator('nav.rail').getByRole('button', { name: /Settings/ }).click()
    await page.getByRole('button', { name: 'Check for a newer release' }).click()
    await page.locator('text=0.5.0 is the latest release').waitFor({ timeout: 15_000 })
    await page.locator('nav.rail').getByRole('button', { name: /Server/ }).click()
  })

  it("follows an older binary's serve --help, and offers the command that installs a newer release", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tfdesk-e2e-old-'))
    const old = await launch(dir, { MOCK_TENSORFOLD_VERSION: '0.3.6.2', MOCK_TENSORFOLD_LATEST: '0.6.0' })
    try {
      const minP = old.page.locator('label.field:has(code:text-is("--min-p"))')
      await minP.locator('.field-help:text-is("tensorfold 0.3.6.2 has no --min-p (it came in 0.5.0)")').waitFor({ timeout: 15_000 })
      expect(await minP.locator('input').isDisabled()).toBe(true)
      expect(await old.page.locator('label.field:has(code:text-is("--context")) input').isDisabled()).toBe(false)

      await old.page.locator('nav.rail').getByRole('button', { name: /Settings/ }).click()
      await old.page.getByRole('button', { name: 'Check for a newer release' }).click()
      await old.page.locator('text=TensorFold 0.6.0 is out (this is 0.3.6.2)').waitFor({ timeout: 15_000 })
      expect(await old.page.locator('pre.command').first().innerText()).toMatch(/fake-tensorfold\.mjs update$/)
      expect(await old.page.locator('text=release notes: https://github.com/ashhart/TensorFold/releases/tag/v0.6.0').count()).toBe(1)
    } finally {
      await old.app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('P1 against the mock', () => {
  const rail = (name: RegExp): ReturnType<Page['locator']> => page.locator('nav.rail').getByRole('button', { name })

  it('lists the servable checkpoints, and "Serve this" fills the form', async () => {
    await rail(/Checkpoints/).click()
    await expect.poll(() => page.locator('.ckpt').count(), { timeout: 20_000 }).toBe(2)
    const card = page.locator('.ckpt:has(.ckpt-name:text-is("Qwen3.8-27B-MLX-4bit"))')
    expect(await card.innerText()).toContain('MLX 4-bit, groups of 64')
    await card.getByRole('button', { name: 'Serve this' }).click()
    await expect.poll(() => page.getByRole('textbox', { name: /^Model/ }).inputValue()).toMatch(/Qwen3\.8-27B-MLX-4bit$/)
  })

  it('unloads LM Studio, serves, probes, then stops and restores (SPEC §6.5 against the fake lms)', async () => {
    await rail(/Server/).click()
    const lmsCard = page.locator('section.card:has(h2:text-is("LM Studio"))')
    await lmsCard.locator('table td', { hasText: 'google/gemma-4-e4b' }).waitFor({ timeout: 15_000 })
    await field('--port').fill(String(await freePort()))
    page.once('dialog', (dialog) => void dialog.accept())
    await lmsCard.getByRole('button', { name: 'Unload LM Studio, then serve' }).click()
    await header().locator('.state.serving').waitFor({ timeout: 30_000 })
    await lmsCard.locator('text=Nothing loaded in LM Studio.').waitFor({ timeout: 15_000 })

    await rail(/Probe/).click()
    await page.getByRole('button', { name: 'Run the probe' }).click()
    await page.locator('text=measured here').waitFor({ timeout: 30_000 })
    expect(await page.locator('table.compare').innerText()).toMatch(/req-[0-9a-f]{12}/)

    await rail(/Server/).click()
    await lmsCard.getByRole('button', { name: 'Stop, then restore' }).click()
    await lmsCard.locator('table td', { hasText: 'google/gemma-4-e4b' }).waitFor({ timeout: 30_000 })
    expect(await header().locator('.state').innerText()).toBe('Stopped')
  })
})
