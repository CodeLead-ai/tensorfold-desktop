// npm run screens: one screenshot per view against the mock, into docs/screens, on a throwaway profile.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'

const userData = mkdtempSync(join(tmpdir(), 'tfdesk-screens-'))
const result = spawnSync(electron, ['.'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    TENSORFOLD_DESK_MOCK: '1',
    TENSORFOLD_DESK_USER_DATA: userData,
    TENSORFOLD_DESK_SCREENS: process.argv[2] ?? 'docs/screens',
    TENSORFOLD_DESK_SCREENS_THEME: process.argv[3] ?? 'dark',
    MOCK_TENSORFOLD_LOAD_MS: '1200',
    MOCK_TENSORFOLD_TIME_SCALE: '0.004',
    MOCK_TENSORFOLD_INTERVAL_MS: '150'
  }
})
rmSync(userData, { recursive: true, force: true })
process.exit(result.status ?? 1)
