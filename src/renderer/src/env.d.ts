import type { DeskApi } from '@shared/api'

declare global {
  interface Window {
    tfdesk: DeskApi
  }
}

export {}
