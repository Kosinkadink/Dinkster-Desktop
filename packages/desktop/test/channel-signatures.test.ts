import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { verifyChannel } from '../src/channel-signatures.js'

// Generated independently by the Python channel signer. Contains no private key.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/channel-signature.json', import.meta.url), 'utf8')) as {
  keys: Record<string, string>
  envelope: string
  payload: Record<string, unknown>
}

describe('signed channel authentication', () => {
  it('verifies Python ASCII/Unicode bytes and keeps explicit overlays separate', () => {
    const payload = verifyChannel(fixture.envelope, 'nightly', fixture.keys)
    expect(payload).toEqual(fixture.payload)
    const overlay = { ...payload, frontend: { version: '0.2.7' } }
    expect(verifyChannel(fixture.envelope, 'nightly', fixture.keys)).toEqual(fixture.payload)
    expect(overlay).not.toEqual(fixture.payload)
    expect(() => verifyChannel(fixture.envelope, 'nightly')).toThrow('trusted channel signature')
  })

  it.each([
    ['wrong channel', fixture.envelope, 'stable'],
    ['changed engine', fixture.envelope.replace('0.0.8.dev17', '0.0.8.dev18'), 'nightly'],
    ['unknown signer', fixture.envelope.replace(Object.keys(fixture.keys)[0]!, `sha256:${'f'.repeat(64)}`), 'nightly'],
    ['unsigned payload', JSON.stringify(fixture.payload), 'nightly'],
    ['duplicate field', fixture.envelope.replace('"channel":"nightly"', '"channel":"stable","channel":"nightly"'), 'nightly'],
    ['pretty JSON', JSON.stringify(JSON.parse(fixture.envelope), null, 2), 'nightly'],
    ['unsafe integer', fixture.envelope.replace('9007199254740991', '9007199254740992'), 'nightly'],
  ])('refuses %s', (_name, text, channel) => {
    expect(() => verifyChannel(text!, channel!, fixture.keys)).toThrow()
  })
})
