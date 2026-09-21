import { describe, expect, it } from 'vitest'
import { isTrustedDesktopIpc } from '../src/ipc-security.js'

describe('desktop IPC sender binding', () => {
  it('accepts only the expected top frame at the loopback app origin', () => {
    const sender = {}
    const frame = { url: 'http://127.0.0.1:5000/settings' }
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', sender, frame)).toBe(true)
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', {}, frame)).toBe(false)
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', sender, { url: frame.url })).toBe(false)
    expect(isTrustedDesktopIpc(sender, frame, 'http://127.0.0.1:5000', sender, { url: 'https://attacker.invalid' })).toBe(false)
  })
})
