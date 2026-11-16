import { describe, expect, it } from 'vitest'
import { denyRendererPermissions } from '../src/security.js'

describe('desktop renderer security', () => {
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
