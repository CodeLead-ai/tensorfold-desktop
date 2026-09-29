import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('tfdesk', {})
