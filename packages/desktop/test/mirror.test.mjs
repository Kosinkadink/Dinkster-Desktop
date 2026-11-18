import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { forwardMirror } from '../../e2e/scripts/forward-mirror.mjs'
import { download } from '../src/io.js'

const roots = []
const servers = []
async function listen(handler) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${server.address().port}`
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }),
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([false, true])('recovers a mirrored interrupted transfer or reports bounded failure (persistent: %s)', async (persistent) => {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-mirror-test-'))
  roots.push(root)
  const destination = join(root, 'artifact')
  await writeFile(destination, 'original')
  let requests = 0
  const origin = await listen((request, response) => {
    requests++
    response.writeHead(200, { 'Content-Length': 9 })
    if (persistent || requests < 3) {
      response.write('part')
      response.socket.end()
    } else response.end('recovered')
  })
  const failures = []
  const forwards = []
  const mirror = await listen((request, response) => {
    forwards.push(forwardMirror(`${origin}/artifact`, response).catch((error) => failures.push(error)))
  })
  const transfer = download(`${mirror}/artifact`, destination, undefined, 9)
  if (persistent) await expect(transfer).rejects.toThrow(/download interrupted.*3 attempts/)
  else await transfer
  await Promise.all(forwards)
  expect(requests).toBe(3)
  expect(await readFile(destination, 'utf8')).toBe(persistent ? 'original' : 'recovered')
  expect(failures).toHaveLength(persistent ? 3 : 2)
  for (const error of failures) expect(error.diagnostic).toMatchObject({ status: 200, contentLength: '9', bytesReceived: 4 })
})

it('preserves a complete upstream body and status', async () => {
  const origin = await listen((request, response) => {
    response.writeHead(206, { 'Content-Length': 7 })
    response.end('payload')
  })
  let forwarding
  const mirror = await listen((request, response) => {
    forwarding = forwardMirror(`${origin}/base.tar.zst.001`, response)
  })
  const response = await fetch(mirror)
  expect(response.status).toBe(206)
  expect(await response.text()).toBe('payload')
  await forwarding
})

it('fails a truncated upstream body with its URL, headers, byte count and cause', async () => {
  const origin = await listen((request, response) => {
    response.writeHead(200, { 'Content-Length': 19 })
    response.write('partial')
    response.socket.end()
  })
  const url = `${origin}/base.tar.zst.001`
  let failure
  const failed = new Promise((done) => {
    failure = done
  })
  const mirror = await listen((request, response) => {
    forwardMirror(url, response).catch(failure)
  })
  await expect(
    fetch(mirror).then((response) => response.text()),
  ).rejects.toThrow()
  const error = await failed
  expect(error.diagnostic).toMatchObject({
    url,
    status: 200,
    contentLength: '19',
    bytesReceived: 7,
  })
  expect(error.cause).toBeInstanceOf(Error)
  expect(error.diagnostic.exception).toContain('terminated')
  expect(error.diagnostic.exception).toMatch(/cause|UND_ERR/)
  expect(error.message).toContain(url)
  expect(error.message).toContain('"bytesReceived":7')
})
