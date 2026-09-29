import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { resolveProfile } from './profile'

const profile = resolveProfile(process.env, app.getAppPath())
app.setName(profile.name)
app.setPath('userData', join(app.getPath('appData'), profile.name))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    title: profile.name,
    backgroundColor: '#060B18',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
