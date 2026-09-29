/**
 * The renderer's store (SPEC §4: zustand, fed by IPC events). It mirrors the main process's server state,
 * keeps the session's lines and request rows, the latest /health sample, the settings, and the server form.
 */
import { create } from 'zustand'
import type { BinaryInfo, ServerState } from '@shared/api'
import { emptyConfig, type ServeConfig } from '@shared/config'
import type { LogLine } from '@shared/events'
import type { HealthSample } from '@shared/health'
import { rowFromLine, type RequestRow } from '@shared/requests'
import { emptySessionInfo } from '@shared/session'
import type { Settings } from '@shared/settings'
import type { ValidationIssue } from '@shared/validate'

export type ViewId = 'server' | 'requests' | 'checkpoints' | 'probe' | 'log' | 'settings'

const MAX_LINES = 20_000
const api = (): Window['tfdesk'] => window.tfdesk

function initialServer(): ServerState {
  return {
    status: 'stopped',
    sessionId: 0,
    pid: null,
    binary: null,
    version: null,
    config: null,
    argv: [],
    commandLine: '',
    startedAt: null,
    servingAt: null,
    stoppingSince: null,
    killAt: null,
    logFile: null,
    info: emptySessionInfo(),
    lastExit: null
  }
}

export interface Toast {
  kind: 'error' | 'info'
  text: string
}

interface DeskStore {
  ready: boolean
  mock: boolean
  appVersion: string
  view: ViewId
  server: ServerState
  lines: LogLine[]
  lastSeq: number
  rows: RequestRow[]
  health: HealthSample | null
  settings: Settings | null
  binary: BinaryInfo | null
  form: ServeConfig
  issues: ValidationIssue[]
  preview: string
  busy: boolean
  toast: Toast | null

  init(): Promise<void>
  setView(view: ViewId): void
  setForm(config: ServeConfig): void
  start(config?: ServeConfig): Promise<boolean>
  stop(): Promise<void>
  restart(): Promise<void>
  kill(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
  detectBinary(): Promise<void>
  notify(toast: Toast | null): void
}

let formTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function appendLines(state: DeskStore, batch: LogLine[]): Partial<DeskStore> {
  const fresh = batch.filter((l) => l.seq > state.lastSeq)
  if (fresh.length === 0) return {}
  let lines = state.lines.concat(fresh)
  if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES)
  const newRows = fresh.map(rowFromLine).filter((r): r is RequestRow => r !== null)
  return {
    lines,
    lastSeq: (fresh[fresh.length - 1] as LogLine).seq,
    rows: newRows.length ? state.rows.concat(newRows) : state.rows
  }
}

export const useDesk = create<DeskStore>((set, get) => ({
  ready: false,
  mock: false,
  appVersion: '',
  view: 'server',
  server: initialServer(),
  lines: [],
  lastSeq: 0,
  rows: [],
  health: null,
  settings: null,
  binary: null,
  form: emptyConfig(),
  issues: [],
  preview: '',
  busy: false,
  toast: null,

  async init() {
    if (get().ready) return
    api().onState((server) => {
      const current = get().server
      if (server.sessionId !== current.sessionId) {
        set({ server, lines: [], rows: [], lastSeq: 0, health: server.status === 'serving' ? get().health : null })
      } else {
        set({ server })
      }
    })
    api().onLines((batch) => set((state) => appendLines(state, batch)))
    api().onHealth((health) => set({ health }))
    api().onNavigate((view) => set({ view: view as ViewId }))
    const [session, settings] = await Promise.all([api().getSession(), api().getSettings()])
    const rows = session.lines.map(rowFromLine).filter((r): r is RequestRow => r !== null)
    set({
      ready: true,
      mock: session.mock,
      appVersion: session.appVersion,
      server: session.state,
      lines: session.lines,
      lastSeq: session.lines.length ? (session.lines[session.lines.length - 1] as LogLine).seq : 0,
      rows,
      health: session.health,
      settings,
      form: session.state.status !== 'stopped' && session.state.config ? session.state.config : settings.lastConfig
    })
    get().setForm(get().form)
    void get().detectBinary()
  },

  setView(view) {
    set({ view })
  },

  setForm(config) {
    set({ form: config })
    if (formTimer) clearTimeout(formTimer)
    formTimer = setTimeout(async () => {
      const [issues, preview] = await Promise.all([api().validateConfig(config), api().previewCommand(config)])
      if (get().form === config) set({ issues, preview })
    }, 200)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void api().setSettings({ lastConfig: config }), 800)
  },

  async start(config) {
    const form = config ?? get().form
    set({ busy: true })
    try {
      const result = await api().startServer(form)
      if (!result.ok) {
        if (result.issues) set({ issues: result.issues })
        get().notify({ kind: 'error', text: result.error })
        return false
      }
      return true
    } finally {
      set({ busy: false })
    }
  },

  async stop() {
    const result = await api().stopServer()
    if (!result.ok) get().notify({ kind: 'error', text: result.error })
  },

  async restart() {
    set({ busy: true })
    try {
      const result = await api().restartServer(get().form)
      if (!result.ok) {
        if (result.issues) set({ issues: result.issues })
        get().notify({ kind: 'error', text: result.error })
      }
    } finally {
      set({ busy: false })
    }
  },

  async kill() {
    await api().killServer()
  },

  async saveSettings(patch) {
    const settings = await api().setSettings(patch)
    set({ settings })
    if ('binaryPath' in patch) void get().detectBinary()
  },

  async detectBinary() {
    set({ binary: await api().detectBinary() })
    const form = get().form
    set({ preview: await api().previewCommand(form) })
  },

  notify(toast) {
    set({ toast })
    if (toast) {
      const shown = toast
      setTimeout(() => {
        if (get().toast === shown) set({ toast: null })
      }, 7000)
    }
  }
}))
