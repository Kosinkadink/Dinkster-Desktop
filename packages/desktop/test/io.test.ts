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

  it('streams artifact chunks without materializing the complete response', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'))
        controller.enqueue(new TextEncoder().encode('second'))
        controller.close()
      },
    }))
    const buffer = vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('must stream'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const destination = join(root, 'artifact.whl')
    await download('https://example.test/artifact.whl', destination)
    expect(buffer).not.toHaveBeenCalled()
    expect(await readFile(destination, 'utf8')).toBe('firstsecond')
    expect(existsSync(`${destination}.part`)).toBe(false)
  })

  it('removes an aborted partial download without replacing the existing artifact', async () => {
    let closed = false
    const server = createServer((_request, response) => {
      response.once('close', () => { closed = true })
      response.writeHead(200)
      response.write('partial')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const destination = join(root, 'artifact.whl')
    await writeFile(destination, 'original')
    const controller = new AbortController()
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('download fixture did not bind')
      const rejected = expect(download(`http://127.0.0.1:${address.port}/artifact.whl`, destination, controller.signal)).rejects.toThrow()
      await vi.waitFor(() => expect(existsSync(`${destination}.part`)).toBe(true))
      controller.abort()
      await rejected
      await vi.waitFor(() => expect(closed).toBe(true))
      expect(await readFile(destination, 'utf8')).toBe('original')
      expect(existsSync(`${destination}.part`)).toBe(false)
    } finally {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
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
