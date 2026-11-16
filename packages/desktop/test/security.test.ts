import { describe, expect, it } from 'vitest'
import { denyRendererPermissions, secureWebPreferences } from '../src/security.js'

describe('desktop renderer security', () => {
  it('exposes only the sandboxed context-isolated preload', () => {
    expect(secureWebPreferences('preload.js')).toEqual({
      preload: 'preload.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    })
  })

  it('permits sanitized clipboard writes but denies reads and device permissions', () => {
    let check: ((webContents: unknown, permission: string) => boolean) | undefined
    let request: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
    denyRendererPermissions({
      setPermissionCheckHandler: (handler) => { check = handler as typeof check },
      setPermissionRequestHandler: (handler) => { request = handler as typeof request },
    })
    for (const permission of ['clipboard-sanitized-write', 'clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'geolocation', 'openExternal', 'unknown']) {
      const expected = permission === 'clipboard-sanitized-write'
      expect(check?.(undefined, permission)).toBe(expected)
      let allowed = !expected
      request?.(undefined, permission, (result) => { allowed = result })
      expect(allowed).toBe(expected)
    }
  })
})
