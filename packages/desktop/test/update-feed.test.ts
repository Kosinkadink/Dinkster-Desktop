import { describe, expect, it, vi } from 'vitest'
import { configureUpdateFeed, configuredUpdateFeed } from '../src/update-feed.js'

describe('desktop update feed', () => {
  it('leaves production updates unwired until a feed is configured', () => {
    const setFeedURL = vi.fn()
    expect(configureUpdateFeed({ setFeedURL }, undefined)).toBeUndefined()
    expect(setFeedURL).not.toHaveBeenCalled()
  })

  it('accepts HTTPS production feeds and loopback test feeds', () => {
    expect(configuredUpdateFeed('https://downloads.example.test/dinkster/')).toBe('https://downloads.example.test/dinkster')
    expect(configuredUpdateFeed('http://127.0.0.1:8123/releases')).toBe('http://127.0.0.1:8123/releases')
    expect(() => configuredUpdateFeed('http://downloads.example.test/dinkster')).toThrow('HTTPS')
    expect(() => configuredUpdateFeed('https://user:secret@example.test/dinkster')).toThrow('credentials')
  })

  it('configures electron-updater with the generic provider', () => {
    const setFeedURL = vi.fn()
    expect(configureUpdateFeed({ setFeedURL }, 'http://localhost:8123/releases/')).toBe('http://localhost:8123/releases')
    expect(setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://localhost:8123/releases' })
  })
})
