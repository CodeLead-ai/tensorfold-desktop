import { useEffect, useState } from 'react'
import type { Theme } from '@shared/settings'
import { Field, NumberInput, Segmented } from '../components/Fields'
import { Icon } from '../components/Icon'
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
    </div>
  )
}
