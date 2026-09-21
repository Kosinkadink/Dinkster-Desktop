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

  it('denies permission checks and requests by default', () => {
    let check: (() => boolean) | undefined
    let request: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
    denyRendererPermissions({
      setPermissionCheckHandler: (handler) => { check = handler as () => boolean },
      setPermissionRequestHandler: (handler) => { request = handler as typeof request },
    })
    expect(check?.()).toBe(false)
    let allowed = true
    request?.(undefined, 'media', (result) => { allowed = result })
    expect(allowed).toBe(false)
  })
})
