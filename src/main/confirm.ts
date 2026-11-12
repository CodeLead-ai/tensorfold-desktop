/** Native confirmations the main process asks for, shared by the window and the menu-bar item. */
import { dialog, type BrowserWindow } from 'electron'
import type { ServerState } from '@shared/api'

/** Before stopping a server the app did not start. Cancel is the default: Return does not stop it. */
export async function confirmStopExternal(win: BrowserWindow | null, state: ServerState): Promise<boolean> {
  const where = state.external?.cwd ? ` in ${state.external.cwd}` : ''
  const options = {
    type: 'warning' as const,
    buttons: ['Stop it', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Stop a server the app did not start?',
    detail:
      `TensorFold (pid ${state.pid ?? '?'}) was started outside the app${where}, by a script or a terminal. ` +
      'Stopping it ends it for whatever uses it. TensorFold saves its newest conversations, then exits; SIGKILL follows ' +
      'after the grace period if it has not.'
  }
  const choice = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return choice.response === 0
}
