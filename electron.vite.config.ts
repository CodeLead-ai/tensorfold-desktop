import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const alias = { '@shared': resolve('src/shared') }

/**
 * The renderer's Content-Security-Policy. Built: its own files only, and no network at all (connect-src
 * 'none'; SPEC §6.8). In development Vite needs an inline preamble (React refresh) and its websocket.
 */
function contentSecurityPolicy(): Plugin {
  let dev = false
  return {
    name: 'tfdesk-csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml() {
      const policy = dev
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'none'"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }]
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    // electron-store is ESM-only; bundling it keeps the main process a single CommonJS file.
    build: { externalizeDeps: { exclude: ['electron-store'] } }
  },
  preload: {
    resolve: { alias }
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), contentSecurityPolicy()]
  }
})
