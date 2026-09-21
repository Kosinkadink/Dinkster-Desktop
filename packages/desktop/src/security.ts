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
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
}
