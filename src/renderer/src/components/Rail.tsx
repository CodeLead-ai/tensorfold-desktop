import { compact, fixed } from '../lib/format'
import { useDesk, type ViewId } from '../store'
import { Icon, type IconName } from './Icon'

const VIEWS: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: 'server', label: 'Server', icon: 'server' },
  { id: 'requests', label: 'Requests', icon: 'requests' },
  { id: 'checkpoints', label: 'Checkpoints', icon: 'checkpoints' },
  { id: 'probe', label: 'Probe', icon: 'probe' },
  { id: 'log', label: 'Log', icon: 'log' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

export function Rail(): React.JSX.Element {
  const view = useDesk((s) => s.view)
  const setView = useDesk((s) => s.setView)
  const rows = useDesk((s) => s.rows)
  const lines = useDesk((s) => s.lines.length)
  const server = useDesk((s) => s.server)
  const mock = useDesk((s) => s.mock)
  const done = rows.filter((r) => r.kind === 'done').length
  const refused = rows.length - done
  const died = server.status === 'stopped' && server.lastExit !== null && !server.lastExit.requested

  return (
    <nav className="rail">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="brand" size={17} />
        </div>
        <div>
          <div className="brand-name">TensorFold Desk</div>
          <div className="brand-sub">for tensorfold serve</div>
        </div>
      </div>
      {VIEWS.map((v) => (
        <button key={v.id} className={`nav-item ${view === v.id ? 'active' : ''}`} onClick={() => setView(v.id)}>
          <Icon name={v.icon} />
          {v.label}
          {v.id === 'requests' && rows.length > 0 && (
            <span className="count" title={`${done} done, ${refused} refused or failed`}>
              {done}
              {refused > 0 && <span className="bad"> · {refused}</span>}
            </span>
          )}
          {v.id === 'log' && lines > 0 && <span className="count">{compact(lines)}</span>}
        </button>
      ))}
      <div className="rail-foot">
        <div className="row">
          <span className={`state ${died ? 'died' : server.status}`} style={{ padding: '2px 8px 2px 6px', fontSize: 11 }}>
            <i className="dot" />
            {died ? 'died' : server.status}
          </span>
          {mock && <span className="badge mock">MOCK</span>}
        </div>
        <div className="speed" title="tok/s of the latest request">
          {fixed(server.info.lastTokPerS)}
          <small>tok/s last</small>
        </div>
      </div>
    </nav>
  )
}
