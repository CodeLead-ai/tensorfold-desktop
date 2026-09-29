import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type DeskApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DeskApi = {
  getSession: () => ipcRenderer.invoke(CHANNELS.getSession),
  startServer: (config) => ipcRenderer.invoke(CHANNELS.start, config),
  stopServer: () => ipcRenderer.invoke(CHANNELS.stop),
  restartServer: (config) => ipcRenderer.invoke(CHANNELS.restart, config),
  killServer: () => ipcRenderer.invoke(CHANNELS.kill),
  validateConfig: (config) => ipcRenderer.invoke(CHANNELS.validate, config),
  previewCommand: (config) => ipcRenderer.invoke(CHANNELS.previewCommand, config),
  onState: (cb) => subscribe(CHANNELS.state, cb),
  onLines: (cb) => subscribe(CHANNELS.lines, cb),
  onHealth: (cb) => subscribe(CHANNELS.health, cb),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(CHANNELS.setSettings, patch),
  detectBinary: () => ipcRenderer.invoke(CHANNELS.detectBinary),
  copyText: (text) => ipcRenderer.invoke(CHANNELS.copyText, text),
  reveal: (path) => ipcRenderer.invoke(CHANNELS.reveal, path),
  chooseFile: (options) => ipcRenderer.invoke(CHANNELS.chooseFile, options),
  onNavigate: (cb) => subscribe(CHANNELS.navigate, cb),
  listCheckpoints: (refresh) => ipcRenderer.invoke(CHANNELS.listCheckpoints, refresh),
  pull: (repo) => ipcRenderer.invoke(CHANNELS.pull, repo),
  cancelPull: () => ipcRenderer.invoke(CHANNELS.cancelPull),
  getPull: () => ipcRenderer.invoke(CHANNELS.getPull),
  onPull: (cb) => subscribe(CHANNELS.pullUpdate, cb),
  lmStudioStatus: () => ipcRenderer.invoke(CHANNELS.lmStatus),
  unloadAndServe: (config) => ipcRenderer.invoke(CHANNELS.unloadAndServe, config),
  stopAndRestore: () => ipcRenderer.invoke(CHANNELS.stopAndRestore),
  probe: (request) => ipcRenderer.invoke(CHANNELS.probe, request),
  exportSnapshot: () => ipcRenderer.invoke(CHANNELS.exportSnapshot),
  runnerLines: () => ipcRenderer.invoke(CHANNELS.runnerLines),
  networkAudit: () => ipcRenderer.invoke(CHANNELS.networkAudit)
}

contextBridge.exposeInMainWorld('tfdesk', api)
