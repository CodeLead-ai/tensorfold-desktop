/**
 * The menu-bar item (SPEC §3.11): a state dot, the last request's tok/s as its title, and a menu with the
 * model, start/stop, and the way back to the window.
 */
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { ServerState } from '@shared/api'
import type { Desk } from './Desk'

const COLORS = { serving: '#3ddc97', loading: '#f5b84b', stopping: '#f5b84b', stopped: '#8fa0bc', died: '#ff6b7a' } as const

/** A round dot as a bitmap (BGRA, drawn at 2x), so the app ships no image for it. */
export function dotImage(hex: string, points = 16): NativeImage {
  const scale = 2
  const size = points * scale
  const buffer = Buffer.alloc(size * size * 4)
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const center = size / 2
  const radius = size * 0.28
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - center, y + 0.5 - center)
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - d))
      const i = (y * size + x) * 4
      buffer[i] = b
      buffer[i + 1] = g
      buffer[i + 2] = r
      buffer[i + 3] = Math.round(alpha * 255)
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: scale })
}

function stateOf(state: ServerState): keyof typeof COLORS {
  if (state.status === 'stopped' && state.lastExit && !state.lastExit.requested) return 'died'
  return state.status
}

export class MenuBar {
  private readonly tray: Tray
  private timer: NodeJS.Timeout | null = null
  private readonly images = new Map<string, NativeImage>()

  constructor(
    private readonly desk: Desk,
    private readonly show: (view?: string) => void
  ) {
    this.tray = new Tray(this.image('stopped'))
    desk.on('state', () => this.schedule())
    this.update()
  }

  private image(key: keyof typeof COLORS): NativeImage {
    let image = this.images.get(key)
    if (!image) {
      image = dotImage(COLORS[key])
      this.images.set(key, image)
    }
    return image
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.update()
    }, 400)
  }

  update(): void {
    const state = this.desk.manager.state
    const key = stateOf(state)
    const serving = state.info.serving
    const model = serving?.model ?? state.info.loading?.model ?? null
    const last = state.info.lastTokPerS
    this.tray.setImage(this.image(key))
    this.tray.setTitle(state.status === 'serving' && last !== null ? ` ${last.toFixed(1)} tok/s` : '', { fontType: 'monospacedDigit' })
    const label = { serving: 'Serving', loading: 'Loading', stopping: 'Stopping', stopped: 'Stopped', died: 'Died' }[key]
    this.tray.setToolTip(`TensorFold Desk · ${label}${model ? ` · ${model}` : ''}`)
    const running = state.status === 'loading' || state.status === 'serving'
    const template: MenuItemConstructorOptions[] = [
      { label: `${label}${model ? ` · ${model}` : ''}${serving ? ` · :${serving.port}` : ''}`, enabled: false },
      { label: last !== null ? `Last request: ${last.toFixed(1)} tok/s (${state.info.done} done)` : 'No requests yet', enabled: false },
      { type: 'separator' },
      state.status === 'stopped'
        ? { label: 'Start with the server form', click: () => void this.desk.start(this.desk.settings.lastConfig) }
        : { label: 'Stop the server', enabled: running, click: () => void this.desk.stop() },
      ...(running ? [{ label: 'Restart', click: () => void this.desk.restart(this.desk.settings.lastConfig) }] : []),
      { type: 'separator' },
      { label: 'Show TensorFold Desk', click: () => this.show() },
      { label: 'Requests', click: () => this.show('requests') },
      { label: 'Log', click: () => this.show('log') },
      { type: 'separator' },
      { label: 'Quit TensorFold Desk', click: () => app.quit() }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy(): void {
    this.tray.destroy()
  }
}
