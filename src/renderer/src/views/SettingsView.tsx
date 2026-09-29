import { useEffect, useState } from 'react'
import type { AuditEntry } from '@shared/api'
import type { Theme } from '@shared/settings'
import { Field, NumberInput, Segmented } from '../components/Fields'
import { Icon } from '../components/Icon'
import { clock } from '../lib/format'
import { useDesk } from '../store'

export function SettingsView(): React.JSX.Element {
  const settings = useDesk((s) => s.settings)
  const binary = useDesk((s) => s.binary)
  const { saveSettings, detectBinary } = useDesk.getState()
  const [binaryPath, setBinaryPath] = useState(settings?.binaryPath ?? '')
  useEffect(() => setBinaryPath(settings?.binaryPath ?? ''), [settings?.binaryPath])
  if (!settings) return <div className="empty">Loading settings…</div>

  return (
    <div className="settings-grid">
      <section className="card">
        <div className="card-head">
          <h2>TensorFold binary</h2>
          <span className="spacer" />
          <button className="btn small" onClick={() => void detectBinary()}>
            Look again
          </button>
        </div>
        <div className="card-body grid" style={{ gap: 14 }}>
          <Field
            label={<span>Path</span>}
            help="Empty: the tensorfold on your login shell's PATH (which tensorfold), then a venv under ~/Projects or your home folder that holds one."
          >
            <div className="row">
              <input
                className="input mono grow"
                value={binaryPath}
                placeholder={binary?.path ?? 'find it'}
                spellCheck={false}
                onChange={(e) => setBinaryPath(e.target.value)}
                onBlur={() => binaryPath !== settings.binaryPath && void saveSettings({ binaryPath })}
              />
              <button
                className="btn"
                onClick={async () => {
                  const file = await window.tfdesk.chooseFile({ title: 'Choose the tensorfold binary', directory: false, defaultPath: binary?.path ?? undefined })
                  if (file) void saveSettings({ binaryPath: file })
                }}
              >
                <Icon name="folder" size={14} /> Choose…
              </button>
              {settings.binaryPath && (
                <button className="btn ghost" onClick={() => void saveSettings({ binaryPath: '' })}>
                  Find it instead
                </button>
              )}
            </div>
          </Field>
          {binary && (
            <dl className="kv">
              <dt>In use</dt>
              <dd className={binary.path ? '' : 'bad'}>{binary.path ?? 'none found'}</dd>
              <dt>Found by</dt>
              <dd>{binary.source === 'settings' ? 'the path above' : binary.source === 'path' ? 'PATH' : binary.source === 'found' ? 'looking in the usual places' : binary.source === 'mock' ? 'the mock profile (npm run dev:mock)' : '–'}</dd>
              <dt>Version</dt>
              <dd className={binary.version ? '' : 'bad'}>{binary.version ?? binary.error ?? '–'}</dd>
              {!binary.path && (
                <>
                  <dt>Looked in</dt>
                  <dd style={{ fontSize: 11.5 }} className="muted">
                    {binary.searched.join(' · ')}
                  </dd>
                </>
              )}
            </dl>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Server</h2>
        </div>
        <div className="card-body">
          <div className="fields" style={{ padding: 0 }}>
            <Field label={<span>Stop grace period (seconds)</span>} help="SIGTERM first; SIGKILL if the server has not exited by then. TensorFold saves its newest conversations while it stops.">
              <NumberInput value={settings.stopGraceSeconds} onChange={(v) => typeof v === 'number' && v >= 1 && void saveSettings({ stopGraceSeconds: v })} />
            </Field>
            <Field label={<span>/health every (ms)</span>} help="How often the memory gauge reads GET /health while serving (it backs off when the server does not answer).">
              <NumberInput value={settings.healthIntervalMs} onChange={(v) => typeof v === 'number' && v >= 500 && void saveSettings({ healthIntervalMs: v })} />
            </Field>
          </div>
        </div>
      </section>

      <RootsCard />
      <LmStudioSettings />

      <section className="card">
        <div className="card-head">
          <h2>Appearance</h2>
        </div>
        <div className="card-body row">
          <Segmented<Theme>
            value={settings.theme}
            onChange={(theme) => void saveSettings({ theme })}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'Follow macOS' }
            ]}
          />
        </div>
      </section>

      <AuditCard />
    </div>
  )
}

function RootsCard(): React.JSX.Element | null {
  const settings = useDesk((s) => s.settings)
  const { saveSettings, loadCheckpoints } = useDesk.getState()
  const [draft, setDraft] = useState('')
  if (!settings) return null
  const roots = settings.checkpointRoots
  const save = async (next: string[]): Promise<void> => {
    await saveSettings({ checkpointRoots: next })
    void loadCheckpoints(false)
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2>Checkpoint folders</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          LM Studio's models, the Hugging Face cache, or any folder of checkpoints
        </span>
      </div>
      <div className="card-body grid" style={{ gap: 8 }}>
        {roots.map((root) => (
          <div key={root} className="row">
            <span className="mono grow" style={{ fontSize: 12.5 }}>
              {root}
            </span>
            <button className="btn small ghost" onClick={() => void save(roots.filter((r) => r !== root))}>
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <input className="input mono grow" placeholder="/path/to/models" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <button className="btn" disabled={!draft.trim()} onClick={() => (void save([...roots, draft.trim()]), setDraft(''))}>
            Add
          </button>
          <button
            className="btn"
            onClick={async () => {
              const dir = await window.tfdesk.chooseFile({ title: 'Choose a folder of checkpoints', directory: true })
              if (dir && !roots.includes(dir)) void save([...roots, dir])
            }}
          >
            <Icon name="folder" size={14} /> Choose…
          </button>
        </div>
      </div>
    </section>
  )
}

function LmStudioSettings(): React.JSX.Element | null {
  const settings = useDesk((s) => s.settings)
  const { saveSettings, refreshLms } = useDesk.getState()
  const [lmsPath, setLmsPath] = useState(settings?.lmsPath ?? '')
  const [unload, setUnload] = useState(settings?.unloadCommand ?? '')
  const [restore, setRestore] = useState(settings?.restoreCommand ?? '')
  if (!settings) return null
  const commit = async (patch: Parameters<typeof saveSettings>[0]): Promise<void> => {
    await saveSettings(patch)
    void refreshLms()
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2>LM Studio</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          for "Unload LM Studio, then serve" and "Stop, then restore"
        </span>
      </div>
      <div className="card-body grid" style={{ gap: 14 }}>
        <Field label={<span>lms</span>} help="Empty: lms on your PATH, then ~/.lmstudio/bin/lms. Without it the app says so and serves nothing on its behalf.">
          <input className="input mono" value={lmsPath} placeholder="find it" spellCheck={false} onChange={(e) => setLmsPath(e.target.value)} onBlur={() => lmsPath !== settings.lmsPath && void commit({ lmsPath })} />
        </Field>
        <Field label={<span>Unload command</span>} help="Run before serving. A leading lms means the lms above.">
          <input className="input mono" value={unload} spellCheck={false} onChange={(e) => setUnload(e.target.value)} onBlur={() => unload !== settings.unloadCommand && void commit({ unloadCommand: unload })} />
        </Field>
        <Field label={<span>Restore command</span>} help="Run after stopping, e.g. a script that reloads LM Studio's model and checks its configuration. Runs through /bin/sh.">
          <input className="input mono" value={restore} placeholder="not set" spellCheck={false} onChange={(e) => setRestore(e.target.value)} onBlur={() => restore !== settings.restoreCommand && void commit({ restoreCommand: restore })} />
        </Field>
      </div>
    </section>
  )
}

/** SPEC §6.8: what the renderer asked the network for. Its own files only; anything else is blocked. */
function AuditCard(): React.JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  useEffect(() => {
    void window.tfdesk.networkAudit().then(setEntries)
  }, [])
  const blocked = entries?.filter((e) => !e.allowed) ?? []
  const outside = entries?.filter((e) => !/^(file|devtools|data|blob):/.test(e.url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(e.url)) ?? []
  return (
    <section className="card">
      <div className="card-head">
        <h2>Network audit</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          every request the window made since the app started
        </span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => void window.tfdesk.networkAudit().then(setEntries)}>
          <Icon name="restart" size={12} /> Refresh
        </button>
      </div>
      <div className="card-body grid" style={{ gap: 10 }}>
        {entries && (
          <div className={outside.length === 0 ? 'ok' : 'bad'}>
            {entries.length} requests: {outside.length === 0 ? 'all to the app itself (its files, or the dev server on localhost)' : `${outside.length} beyond this machine`}
            {blocked.length > 0 ? `, ${blocked.length} blocked` : ''}. Server traffic (/health, the probe) goes from the main process to 127.0.0.1 only.
          </div>
        )}
        {entries && entries.length > 0 && (
          <pre className="lines-box selectable" style={{ maxHeight: 160 }}>
            {entries
              .slice(-40)
              .map((e) => `${clock(e.at)} ${e.allowed ? 'allowed' : 'BLOCKED'} ${e.url}`)
              .join('\n')}
          </pre>
        )}
      </div>
    </section>
  )
}
