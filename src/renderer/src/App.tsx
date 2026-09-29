import { useEffect } from 'react'
import { Icon } from './components/Icon'
import { Rail } from './components/Rail'
import { StatusHeader } from './components/StatusHeader'
import { useDesk } from './store'
import { CheckpointsView } from './views/CheckpointsView'
import { LogView } from './views/LogView'
import { ProbeView } from './views/ProbeView'
import { RequestsView } from './views/RequestsView'
import { ServerView } from './views/ServerView'
import { SettingsView } from './views/SettingsView'

function useTheme(): void {
  const theme = useDesk((s) => s.settings?.theme ?? 'dark')
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      const resolved = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme
      document.documentElement.dataset['theme'] = resolved
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

export function App(): React.JSX.Element {
  const ready = useDesk((s) => s.ready)
  const view = useDesk((s) => s.view)
  const toast = useDesk((s) => s.toast)
  const notify = useDesk((s) => s.notify)
  useTheme()
  useEffect(() => {
    void useDesk.getState().init()
  }, [])

  if (!ready) return <div className="empty" style={{ paddingTop: 120 }}>Starting…</div>

  return (
    <div className="app">
      <Rail />
      <div className="main">
        <StatusHeader />
        <main className={`view ${view === 'log' ? 'fill' : ''}`}>
          {view === 'server' && <ServerView />}
          {view === 'requests' && <RequestsView />}
          {view === 'log' && <LogView />}
          {view === 'checkpoints' && <CheckpointsView />}
          {view === 'probe' && <ProbeView />}
          {view === 'settings' && <SettingsView />}
        </main>
      </div>
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span className={toast.kind === 'error' ? 'bad' : ''}>
            <Icon name={toast.kind === 'error' ? 'alert' : 'chevron'} size={16} />
          </span>
          <span className="selectable" style={{ flex: 1 }}>
            {toast.text}
          </span>
          <button className="btn ghost small" onClick={() => notify(null)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
