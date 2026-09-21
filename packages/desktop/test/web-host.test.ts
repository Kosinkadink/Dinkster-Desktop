import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebHost, type WebHost } from '../src/web-host.js'

let root: string | undefined
let host: WebHost | undefined
let backend: Server | undefined

afterEach(async () => {
  await host?.close()
  await new Promise<void>((resolve) => backend?.close(() => resolve()) ?? resolve())
  if (root) await rm(root, { recursive: true, force: true })
  host = undefined
  root = undefined
  backend = undefined
})

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function websocketAttempt(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url)
    const socket = connect(Number(port), hostname)
    let response = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('WebSocket attempt did not settle'))
    }, 2000)
    socket.on('connect', () => socket.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    ))
    socket.on('data', (chunk) => {
      response += chunk.toString()
      if (response.includes('\r\n\r\n')) socket.destroy()
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(timeout)
      resolve(response)
    })
  })
}

describe('desktop web host', () => {
  it('serves the app with a loopback-only WebSocket policy', async () => {
    root = await mkdtemp(join(tmpdir(), 'dinkster-desktop-web-'))
    await writeFile(join(root, 'index.html'), '<h1>Dinkster</h1>')
    host = await createWebHost(root, 65534)

    const response = await fetch(host.url)
    expect(await response.text()).toBe('<h1>Dinkster</h1>')
    expect(response.headers.get('content-security-policy')).toContain(
      `connect-src 'self' ${host.url.replace('http:', 'ws:')}`,
    )
    expect((await fetch(`${host.url}/%E0%A4%A`)).status).toBe(400)
  })

  it('rebinds the preferred port so the renderer origin survives restarts', async () => {
    root = await mkdtemp(join(tmpdir(), 'dinkster-desktop-web-'))
    await writeFile(join(root, 'index.html'), '<h1>Dinkster</h1>')
    const port = await unusedPort()
    host = await createWebHost(root, 65534, port)
    expect(new URL(host.url).port).toBe(String(port))
    const url = host.url
    await host.close()
    host = await createWebHost(root, 65534, port)
    expect(host.url).toBe(url)
  })

  it('falls back to an ephemeral port when the preferred port is taken', async () => {
    root = await mkdtemp(join(tmpdir(), 'dinkster-desktop-web-'))
    await writeFile(join(root, 'index.html'), '<h1>Dinkster</h1>')
    backend = createServer()
    await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', resolve))
    const taken = backend.address()
    if (taken === null || typeof taken === 'string') throw new Error('test server did not bind')
    host = await createWebHost(root, 65534, taken.port)
    expect(new URL(host.url).port).not.toBe(String(taken.port))
    expect((await fetch(host.url)).status).toBe(200)
  })

  it('contains a WebSocket outage and proxies again after backend recovery', async () => {
    root = await mkdtemp(join(tmpdir(), 'dinkster-desktop-web-'))
    await writeFile(join(root, 'index.html'), '<h1>Dinkster</h1>')
    const backendPort = await unusedPort()
    host = await createWebHost(root, backendPort)

    expect(await websocketAttempt(host.url)).not.toContain('101 Switching Protocols')
    expect((await fetch(`${host.url}/api/nodes`)).status).toBe(502)
    expect((await fetch(host.url)).status).toBe(200)

    backend = createServer()
    backend.on('upgrade', (_request, socket) => {
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    await new Promise<void>((resolve) => backend!.listen(backendPort, '127.0.0.1', resolve))
    expect(await websocketAttempt(host.url)).toContain('101 Switching Protocols')
  })
})
