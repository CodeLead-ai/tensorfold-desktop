import { app, BrowserWindow, dialog, nativeTheme, session } from 'electron'
import { join } from 'node:path'
import { Desk } from './Desk'
import { registerIpc } from './ipc'
import { NetworkAudit, isAllowedRendererUrl } from './netGuard'
import { resolveProfile } from './profile'
import { SettingsService, profileDefaults } from './Settings'
import { loginShellEnv } from './shellEnv'

const profile = resolveProfile(process.env, app.getAppPath())
app.setName(profile.name)
app.setPath('userData', join(app.getPath('appData'), profile.name))

const devServer = process.env['ELECTRON_RENDERER_URL'] ?? null
const audit = new NetworkAudit()
let desk: Desk | null = null
let mainWindow: BrowserWindow | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => showWindow())

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 660,
    title: profile.name,
    backgroundColor: '#060B18',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  if (devServer) void win.loadURL(devServer)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

export function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url, devServer)) event.preventDefault()
  })
})

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRendererUrl(details.url, devServer)
    audit.record(details.url, allowed)
    callback({ cancel: !allowed })
  })

  const home = app.getPath('home')
  const settings = new SettingsService(profileDefaults(profile, home))
  nativeTheme.themeSource = settings.get().theme
  const env = await loginShellEnv(process.env, home)
  desk = new Desk({
    settings,
    env,
    home,
    logDir: join(app.getPath('userData'), 'logs'),
    mockBinary: profile.mockDefaults?.binary ?? null,
    mock: profile.mock,
    appVersion: app.getVersion(),
    platform: process.platform
  })
  desk.on('settings', (next) => (nativeTheme.themeSource = next.theme))
  registerIpc(desk)
  showWindow()
})

app.on('activate', () => showWindow())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || !desk?.manager.running) {
    desk?.dispose()
    return
  }
  event.preventDefault()
  void confirmQuit()
})

async function confirmQuit(): Promise<void> {
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Stop the server and quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'The server is running.',
    detail: 'Quitting stops it. TensorFold saves its newest conversations before it exits.'
  })
  if (choice.response !== 0) return
  quitting = true
  await desk?.manager.stop()
  app.quit()
}
