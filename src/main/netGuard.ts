/**
 * SPEC §6.8: nothing leaves the machine. The renderer gets its data through IPC only; this guard lets it
 * load its own files (and, in development, the Vite dev server on localhost), blocks every other request,
 * and keeps a record of what was asked, for the audit in Settings.
 */
export interface AuditEntry {
  at: number
  url: string
  allowed: boolean
}

export function isAllowedRendererUrl(url: string, devServer: string | null): boolean {
  if (url.startsWith('file:') || url.startsWith('devtools:') || url.startsWith('data:') || url.startsWith('blob:')) return true
  if (devServer) {
    const dev = new URL(devServer)
    try {
      const u = new URL(url)
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
      return local && u.port === dev.port
    } catch {
      return false
    }
  }
  return false
}

export class NetworkAudit {
  private readonly entries: AuditEntry[] = []
  record(url: string, allowed: boolean): void {
    this.entries.push({ at: Date.now(), url, allowed })
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 2000)
  }
  list(): AuditEntry[] {
    return this.entries.slice()
  }
}
