import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebLauncher } from '../src/web-launcher.js'

let server: Server | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  server = undefined
})

async function listen(port = 0): Promise<number> {
  server = createServer()
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  return address.port
}

describe('browser launcher lifecycle', () => {
  it('cleans a failed engine launch so the same host port can be retried', async () => {
    const port = await listen()
    const failedServer = server
    const stop = vi.fn(async () => undefined)
    const hostClose = vi.fn(async () => {
      await new Promise<void>((resolve) => failedServer!.close(() => resolve()))
      server = undefined
    })
    const launcher = createWebLauncher(
      { start: async () => { throw new Error('supervisor reported failed') }, stop },
      { url: `http://127.0.0.1:${port}`, close: hostClose },
      vi.fn(),
    )

    await expect(launcher.start()).rejects.toThrow('supervisor reported failed')
    expect(stop).toHaveBeenCalledOnce()
    expect(hostClose).toHaveBeenCalledOnce()
    expect(await listen(port)).toBe(port)
  })

  it('shares idempotent cleanup between repeated stop requests', async () => {
    const stop = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const ready = vi.fn()
    const launcher = createWebLauncher(
      { start: async () => undefined, stop },
      { url: 'http://127.0.0.1:1234', close },
      ready,
    )
    await launcher.start()
    await Promise.all([launcher.stop(), launcher.stop()])
    expect(ready).toHaveBeenCalledWith('http://127.0.0.1:1234')
    expect(stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
