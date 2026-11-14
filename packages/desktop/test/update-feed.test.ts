import { describe, expect, it, vi } from 'vitest'
import { configureUpdateFeed, configuredUpdateFeed, type UpdateFeedTarget } from '../src/update-feed.js'

describe('desktop update feed', () => {
  it('selects the highest RC across release pages, excluding stable and draft releases', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('page=1')
      ? [{ tag_name: 'desktop-v0.2.5-rc.2', prerelease: true, draft: false },
        { tag_name: 'desktop-v9.0.0', prerelease: false, draft: false }]
      : [{ tag_name: 'desktop-v0.2.5-rc.10', prerelease: true, draft: false },
        { tag_name: 'desktop-v9.0.0-rc.1', prerelease: true, draft: true }]), {
      headers: url.endsWith('page=1') ? { link: '<https://api.github.com/releases?page=2>; rel="next"' } : {},
    }))
    const target: UpdateFeedTarget = { channel: null, allowPrerelease: false, allowDowngrade: false, setFeedURL() {} }
    try {
      expect(await configureUpdateFeed(target, undefined, '0.2.4-rc.1'))
        .toBe('https://github.com/Kosinkadink/Dinkster-Desktop/releases/download/desktop-v0.2.5-rc.10')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('accepts HTTPS production feeds and loopback test feeds', () => {
    expect(configuredUpdateFeed('https://downloads.example.test/dinkster/')).toBe('https://downloads.example.test/dinkster')
    expect(configuredUpdateFeed('http://127.0.0.1:8123/releases')).toBe('http://127.0.0.1:8123/releases')
    expect(() => configuredUpdateFeed('http://downloads.example.test/dinkster')).toThrow('HTTPS')
    expect(() => configuredUpdateFeed('https://user:secret@example.test/dinkster')).toThrow('credentials')
  })
})
