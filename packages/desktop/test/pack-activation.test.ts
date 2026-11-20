import { afterEach, expect, it, vi } from 'vitest'
import { packActivation } from '../src/pack-activation.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('waits for all composition to settle before acknowledging the activated generation', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const path = new URL(input).pathname
    if (path === '/api/nodes') return Response.json({ dinkster: { services: { name: 'production' } } })
    const settled = Date.now() >= 2000
    if (path === '/api/health') return Response.json({ ok: true, compositionState: { failed: 0, epoch: settled ? 7 : 2 } })
    return Response.json({ epoch: settled ? 7 : 2, ...(settled ? {} : { composing: true }), packs: {
      'new-pack': { state: Date.now() >= 1000 ? 'announced' : 'pending' },
      core: { state: settled ? 'announced' : 'pending' },
    } })
  })
  const activation = expect(packActivation('http://127.0.0.1:39262', 3, 'production', ['new-pack'])).resolves.toEqual({
    generation: 3, epoch: 7, added: ['new-pack'], removed: [], reloaded: [], unchanged: ['core'], failed: {}, diagnostics: [], rolledBack: false,
  })
  await vi.runAllTimersAsync()
  await activation
})

it.each(['failed', 'missing', 'unhealthy', 'epoch-changed'])('refuses terminal %s composition without acknowledging activation', async (failure) => {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const path = new URL(input).pathname
    if (path === '/api/nodes') return Response.json({ dinkster: { services: { name: 'production' } } })
    if (path === '/api/health') return Response.json({ ok: failure !== 'unhealthy', compositionState: { failed: failure === 'failed' ? 1 : 0, epoch: 7 } })
    return Response.json({ epoch: failure === 'epoch-changed' ? 6 : 7, packs: failure === 'missing' ? {} : { 'new-pack': { state: failure === 'failed' ? 'failed' : 'announced' } } })
  })
  await expect(packActivation('http://127.0.0.1:39262', 3, 'production', ['new-pack'])).rejects.toThrow('activation-failed')
})

it('bounds the wait when composition never finishes', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const path = new URL(input).pathname
    if (path === '/api/nodes') return Response.json({ dinkster: { services: { name: 'production' } } })
    if (path === '/api/health') return Response.json({ ok: true, compositionState: { failed: 0, epoch: 2 } })
    return Response.json({ epoch: 2, composing: true, packs: { 'new-pack': { state: 'announced' } } })
  })
  const activation = expect(packActivation('http://127.0.0.1:39262', 3, 'production', ['new-pack'])).rejects.toThrow('activation-failed')
  await vi.runAllTimersAsync()
  await activation
})
