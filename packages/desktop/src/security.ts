import type { Session, WebPreferences } from 'electron'

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
}

export function denyRendererPermissions(session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>): void {
  // Copy actions may write sanitized text; clipboard reads and device access stay denied.
  session.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write')
  session.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
}
