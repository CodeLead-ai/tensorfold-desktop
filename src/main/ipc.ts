import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { CHANNELS } from '@shared/api'
import type { ServeConfig } from '@shared/config'
import type { Settings } from '@shared/settings'
import type { Desk } from './Desk'

/** The renderer's API (src/preload) routed to the Desk service; events go to every window. */
export function registerIpc(desk: Desk): void {
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
  desk.on('state', (state) => broadcast(CHANNELS.state, state))
  desk.on('lines', (lines) => broadcast(CHANNELS.lines, lines))
  desk.on('health', (sample) => broadcast(CHANNELS.health, sample))

  ipcMain.handle(CHANNELS.getSession, () => desk.session())
  ipcMain.handle(CHANNELS.start, (_e, config: ServeConfig) => desk.start(config))
  ipcMain.handle(CHANNELS.stop, () => desk.stop())
  ipcMain.handle(CHANNELS.restart, (_e, config: ServeConfig) => desk.restart(config))
  ipcMain.handle(CHANNELS.kill, () => desk.kill())
  ipcMain.handle(CHANNELS.validate, (_e, config: ServeConfig) => desk.validate(config))
  ipcMain.handle(CHANNELS.previewCommand, (_e, config: ServeConfig) => desk.previewCommand(config))
  ipcMain.handle(CHANNELS.getSettings, () => desk.settings)
  ipcMain.handle(CHANNELS.setSettings, (_e, patch: Partial<Settings>) => desk.setSettings(patch))
  ipcMain.handle(CHANNELS.detectBinary, () => desk.binary(true))
  ipcMain.handle(CHANNELS.copyText, (_e, text: string) => clipboard.writeText(String(text)))
  ipcMain.handle(CHANNELS.reveal, (_e, path: string) => shell.showItemInFolder(String(path)))
  ipcMain.handle(CHANNELS.chooseFile, async (e, options: { title: string; directory: boolean; defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const props: Array<'openFile' | 'openDirectory' | 'showHiddenFiles'> = [options.directory ? 'openDirectory' : 'openFile', 'showHiddenFiles']
    const dialogOptions = { title: options.title, defaultPath: options.defaultPath, properties: props }
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
