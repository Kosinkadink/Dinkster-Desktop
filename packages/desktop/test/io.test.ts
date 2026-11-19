import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { download } from '../src/io.js'

describe('artifact downloads', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dinkster-download-test-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('bounds streamed bytes at the declared size and preserves the prior artifact on overflow', async () => {
    const server = createServer((_request, response) => { response.end('12345') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const destination = join(root, 'bounded.zip')
    await writeFile(destination, 'original')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('download fixture did not bind')
      const url = `http://127.0.0.1:${address.port}/artifact.zip`
      await expect(download(url, destination, undefined, 4)).rejects.toThrow('exceeds the declared size')
      expect(await readFile(destination, 'utf8')).toBe('original')
      expect(existsSync(`${destination}.part`)).toBe(false)
      await download(url, destination, undefined, 5)
      expect(await readFile(destination, 'utf8')).toBe('12345')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each([false, true])('bounds retries for an interrupted transfer (persistent: %s)', async (persistent) => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.writeHead(200, { 'Content-Length': 9 })
      if (persistent || requests < 3) {
        response.write('part')
        response.socket!.end()
      } else response.end('recovered')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const destination = join(root, 'interrupted.zip')
    await writeFile(destination, 'original')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('download fixture did not bind')
      const transfer = download(`http://127.0.0.1:${address.port}/artifact.zip`, destination, undefined, 9)
      if (persistent) await expect(transfer).rejects.toThrow(/download interrupted.*3 attempts/)
      else await transfer
      expect(requests).toBe(3)
      expect(await readFile(destination, 'utf8')).toBe(persistent ? 'original' : 'recovered')
      expect(existsSync(`${destination}.part`)).toBe(false)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('does not retry a denied response or extend an aborted download', async () => {
    const destination = join(root, 'refused.zip')
    await writeFile(destination, 'original')
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(download('https://example.test/archive', destination)).rejects.toThrow('403')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    controller.abort()
    fetcher.mockImplementation(async () => { throw controller.signal.reason })
    await expect(download('https://example.test/archive', destination, controller.signal)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await readFile(destination, 'utf8')).toBe('original')
    expect(existsSync(`${destination}.part`)).toBe(false)
  })

  it('rejects credential-bearing redirects and HTTPS downgrades without replacing the artifact', async () => {
    const destination = join(root, 'redirect.zip')
    await writeFile(destination, 'original')
    for (const location of ['http://example.test/payload', 'http://127.0.0.1/payload', 'http://[::1]/payload', 'https://user:secret@example.test/payload']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location } })))
      await expect(download('https://example.test/archive', destination)).rejects.toThrow('credential-free HTTPS')
      expect(await readFile(destination, 'utf8')).toBe('original')
      expect(existsSync(`${destination}.part`)).toBe(false)
    }
  })
})
