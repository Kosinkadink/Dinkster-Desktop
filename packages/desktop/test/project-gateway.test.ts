import { createServer, type Server } from 'node:http'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProjectGateway, PROJECT_INSTALL_HEADER, type ProjectGateway } from '../src/project-gateway.js'
import type { EnvironmentRequest, EnvironmentResult } from '../src/environment.js'
import { LifecycleQueue } from '../src/lifecycle-queue.js'

const gateways: ProjectGateway[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
})

async function backend(label: string): Promise<string> {
  const server = createServer((request, response) => response.end(`${label}:${request.headers[PROJECT_INSTALL_HEADER] ?? 'no-capability'}`))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(allowPackInstall = true) {
  const calls: EnvironmentRequest[] = []
  let owner = 'document-1'
  let failure = ''
  let hold: (() => Promise<void>) | undefined
  const target = await backend('old')
  const next = await backend('new')
  const queue = new LifecycleQueue()
  let submitted!: () => void
  const enqueued = new Promise<void>((resolve) => { submitted = resolve })
  const gateway = await createProjectGateway({ root: '/project', target, allowPackInstall,
    serialize: (action) => { submitted(); return queue.run(action) },
    owner: async () => owner,
    run: async (request, confirmed) => {
      calls.push(request)
      await hold?.()
      if (failure) throw new Error(failure)
      const result: EnvironmentResult = { format: 'dinkster.environment-result/1', operation: request.operation,
        root: '/project', current: request.operation === 'packs-plan' ? 1 : 2, status: request.operation === 'packs-plan' ? 'planned' : 'applied', plan: ['add dinkster-text@1.0.0'] }
      if (request.operation === 'packs-plan') {
        await mkdir(request.inputs!)
        await writeFile(join(request.inputs!, 'plan.json'), 'retained verified inputs')
        return { ...result, packPlan: { root: '/project', store: '/store', current: 1, wheelBytes: 12345 }, approval: `sha256:${'a'.repeat(64)}`, expiresInSeconds: 900 }
      }
      expect(confirmed).toBe(true)
      expect(request.approval).toBe(`sha256:${'a'.repeat(64)}`)
      return result
    },
    activate: async (result, added) => { gateway.setTarget(next); return { generation: result.current, added, epoch: 1, failed: {}, rolledBack: false } },
  })
  gateways.push(gateway)
  const post = (action: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${gateway.url}/api/packs/install/${action}`, {
    method: 'POST', headers: { origin: gateway.url, [PROJECT_INSTALL_HEADER]: gateway.capability, ...headers }, body: JSON.stringify(body),
  })
  const plan = () => post('plan', { packs: [{ pack: 'dinkster-text', version: '1.0.0' }] })
  return { gateway, calls, queue, enqueued, post, plan, setOwner: (value: string) => { owner = value }, fail: (value: string) => { failure = value }, hold: (value: (() => Promise<void>) | undefined) => { hold = value } }
}

it('keeps one origin, consumes only the retained review and switches upstream without navigation', async () => {
  const f = await fixture()
  expect(await (await fetch(f.gateway.url, { headers: { [PROJECT_INSTALL_HEADER]: f.gateway.capability } })).text()).toBe('old:no-capability')
  const response = await f.plan()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const review = await response.json() as { confirmation: string; plan: unknown; review: string }
  expect(review.review).toContain('12345')
  expect(JSON.stringify(review)).not.toContain('/project')
  expect(JSON.stringify(review)).not.toContain('sha256:')
  const applied = await f.post('apply', { confirmation: review.confirmation })
  expect(applied.status).toBe(200)
  expect(await applied.json()).toEqual({ generation: 2, activation: { generation: 2, added: ['dinkster-text'], epoch: 1, failed: {}, rolledBack: false } })
  expect(await (await fetch(f.gateway.url)).text()).toBe('new:no-capability')
  expect((await f.post('apply', { confirmation: review.confirmation })).status).toBe(409)
  expect(f.calls.map((call) => call.operation)).toEqual(['packs-plan', 'packs-apply'])
  await f.gateway.close()
  await expect(stat(dirname(f.calls[0]!.inputs!))).rejects.toThrow()
})

it('rejects opted-out, untrusted origin, absent capability and bearer callers before command execution', async () => {
  const off = await fixture(false)
  expect((await off.plan()).status).toBe(404)
  expect(off.calls).toEqual([])
  const f = await fixture()
  for (const headers of [{ origin: 'http://attacker.invalid' }, { [PROJECT_INSTALL_HEADER]: '' }, { authorization: 'Bearer agent' }, { [PROJECT_INSTALL_HEADER]: 'a'.repeat(64) }, { [PROJECT_INSTALL_HEADER]: '\u00e9'.repeat(64) }]) {
    expect((await f.post('plan', { packs: [{ pack: 'dinkster-text', version: '1.0.0' }] }, headers)).status).toBe(403)
  }
  expect(f.calls).toEqual([])
})

it('invalidates replaced and changed-document plans and reclaims their inputs', async () => {
  const f = await fixture()
  const first = await (await f.plan()).json() as { confirmation: string }
  const inputs = f.calls[0]!.inputs!
  const second = await (await f.plan()).json() as { confirmation: string }
  await expect(stat(dirname(inputs))).rejects.toThrow()
  f.setOwner('document-2')
  expect((await f.post('apply', { confirmation: second.confirmation })).status).toBe(409)
  expect((await f.post('apply', { confirmation: first.confirmation })).status).toBe(409)
  expect(f.calls.every((call) => call.operation === 'packs-plan')).toBe(true)
})

it('keeps busy ownership through a disconnected caller and reports stale apply without exposing paths', async () => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  f.hold(async () => { entered(); await barrier })
  const controller = new AbortController()
  const aborted = fetch(`${f.gateway.url}/api/packs/install/plan`, { method: 'POST', headers: { origin: f.gateway.url, [PROJECT_INSTALL_HEADER]: f.gateway.capability },
    body: JSON.stringify({ packs: [{ pack: 'dinkster-text', version: '1.0.0' }] }), signal: controller.signal }).catch(() => undefined)
  try {
    await started
    controller.abort()
    expect((await f.plan()).status).toBe(409)
  } finally { release() }
  await aborted
  f.hold(undefined)
  // Closing drains the command even when the HTTP client has gone away.
  await f.gateway.close()
  await expect(stat(dirname(f.calls[0]!.inputs!))).rejects.toThrow()
  const other = await fixture()
  const review = await (await other.plan()).json() as { confirmation: string }
  other.fail('project changed after planning; request a new plan at /secret/project')
  const response = await other.post('apply', { confirmation: review.confirmation })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'plan-stale' })
})

it('expires reviewed inputs without applying and distinguishes a failed writer from stale approval', async () => {
  const f = await fixture()
  const review = await (await f.plan()).json() as { confirmation: string }
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 900_001)
  expect((await f.post('apply', { confirmation: review.confirmation })).status).toBe(409)
  expect(f.calls).toHaveLength(1)
  await expect(stat(dirname(f.calls[0]!.inputs!))).rejects.toThrow()
  vi.restoreAllMocks()
  const next = await (await f.plan()).json() as { confirmation: string }
  f.fail('wheel acquisition failed at /secret/store')
  const failed = await f.post('apply', { confirmation: next.confirmation })
  expect(failed.status).toBe(422)
  expect(await failed.json()).toEqual({ error: 'apply-failed' })
  expect((await f.post('apply', { confirmation: next.confirmation })).status).toBe(409)
})

it('closes ahead of a queued request without deadlocking the shared lifecycle queue', async () => {
  const f = await fixture()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const closing = f.queue.run(async () => { await barrier; await f.gateway.close() })
  const request = f.plan().catch(() => undefined)
  await f.enqueued
  release()
  await closing
  await request
  await f.queue.run(async () => {})
  expect(f.calls).toEqual([])
})
