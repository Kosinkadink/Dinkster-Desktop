import { describe, expect, it } from 'vitest'
import { redactDiagnosticText } from '../src/desktop-manager.js'

describe('desktop engine management', () => {
  it('scrubs credentials from support diagnostics', () => {
    const source = 'Authorization: Bearer abc123 token=secret\nCookie: sid=private\n{"password":"hunter2","error":"Bearer raw-token"}\nhttps://user:pass@example.test --api-key hidden'
    const scrubbed = redactDiagnosticText(source)
    expect(scrubbed).not.toContain('abc123')
    expect(scrubbed).not.toContain('secret')
    expect(scrubbed).not.toContain('private')
    expect(scrubbed).not.toContain('hunter2')
    expect(scrubbed).not.toContain('raw-token')
    expect(scrubbed).not.toContain('user:pass')
    expect(scrubbed).not.toContain('hidden')
    expect(scrubbed.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6)
  })
})
