import { describe, expect, it } from 'vitest'
import { configuredUpdateFeed } from '../src/update-feed.js'

describe('desktop update feed', () => {
  it('accepts HTTPS production feeds and loopback test feeds', () => {
    expect(configuredUpdateFeed('https://downloads.example.test/dinkster/')).toBe('https://downloads.example.test/dinkster')
    expect(configuredUpdateFeed('http://127.0.0.1:8123/releases')).toBe('http://127.0.0.1:8123/releases')
    expect(() => configuredUpdateFeed('http://downloads.example.test/dinkster')).toThrow('HTTPS')
    expect(() => configuredUpdateFeed('https://user:secret@example.test/dinkster')).toThrow('credentials')
  })
})
