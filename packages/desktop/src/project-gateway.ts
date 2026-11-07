import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import httpProxy from 'http-proxy'
import type { EnvironmentRequest, EnvironmentResult } from './environment.js'

export const PROJECT_INSTALL_HEADER = 'x-dinkster-desktop-install'

export interface ProjectGateway {
  readonly url: string
  readonly capability: string
  setTarget(url: string): void
  close(): Promise<void>
}

interface GatewayOptions {
  readonly root: string
  readonly target: string
  readonly preferredPort?: number | undefined
  readonly allowPackInstall: boolean
  readonly serialize: (action: () => Promise<void>) => Promise<void>
  readonly run: (request: EnvironmentRequest, confirmed?: boolean) => Promise<EnvironmentResult>
  /** Return an immutable top-level document identity, or reject a changed binding. */
  readonly owner: () => Promise<string>
  readonly activate: (result: EnvironmentResult, added: readonly string[]) => Promise<Record<string, unknown>>
}

function loopbackTarget(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('local project gateway needs a loopback engine origin')
  return url.origin
}

/** Stable connection origin survives replacement of the engine serving a project. */
export async function createProjectGateway(options: GatewayOptions): Promise<ProjectGateway> {
  let target = loopbackTarget(options.target)
  let origin = ''
  let closed = false
  let closing: Promise<void> | undefined
  let busy: Promise<void> | undefined
  let executing: Promise<void> | undefined
  let pending: { token: string; owner: string; directory: string; inputs: string; approval: string; expires: number; added: string[] } | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const capability = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  const upgrades = new Set<Duplex>()
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true })
  proxy.on('error', (_error, _request, response) => { response.destroy() })

  async function discard(): Promise<void> {
    const previous = pending
    pending = undefined
    clearTimeout(expiry)
    if (previous) await rm(previous.directory, { recursive: true, force: true })
  }

  function reply(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }

  async function install(request: IncomingMessage, response: ServerResponse, action: string): Promise<void> {
    if (!options.allowPackInstall) { reply(response, 404, { error: 'not-found' }); return }
    const provided = request.headers[PROJECT_INSTALL_HEADER]
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(origin).host
      || request.headers.origin !== origin || request.headers.authorization !== undefined
      || typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided)
      || !timingSafeEqual(Buffer.from(provided), Buffer.from(capability))) {
      reply(response, 403, { error: 'local-operator-required' }); return
    }
    if (closed || busy) { reply(response, 409, { error: 'install-in-progress' }); return }
    if (request.method !== 'POST') { reply(response, 405, { error: 'method-not-allowed' }); return }
    let raw: Record<string, unknown>
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > 64 * 1024) { reply(response, 413, { error: 'bad-request' }); return }
        chunks.push(Buffer.from(chunk))
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body')
      raw = value as Record<string, unknown>
    } catch { reply(response, 400, { error: 'bad-request' }); return }
    // Another request can enter while this request is reading its body.
    if (closed || busy) { reply(response, 409, { error: 'install-in-progress' }); return }
    const perform = async (): Promise<void> => {
      let directory: string | undefined
      let installedGeneration: number | null | undefined
      try {
        const owner = await options.owner()
        if (action === 'plan') {
          await discard()
          if (Object.keys(raw).length !== 1 || !Array.isArray(raw['packs']) || raw['packs'].length < 1 || raw['packs'].length > 64) {
            reply(response, 400, { error: 'bad-request' }); return
          }
          const packs: { pack: string; version: string }[] = []
          const names = new Set<string>()
          for (const item of raw['packs'] as unknown[]) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('bad-request')
            const row = item as Record<string, unknown>
            if (Object.keys(row).length !== 2 || typeof row['pack'] !== 'string' || typeof row['version'] !== 'string'
              || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(row['pack']) || !/^[0-9][a-zA-Z0-9.!]*$/.test(row['version']) || names.has(row['pack'])) throw new Error('bad-request')
            names.add(row['pack'])
            packs.push({ pack: row['pack'], version: row['version'] })
          }
          directory = await mkdtemp(join(tmpdir(), 'dinkster-desktop-pack-review-'))
          const inputs = join(directory, 'inputs')
          const result = await options.run({ root: options.root, operation: 'packs-plan', packs, inputs })
          if (!result.packPlan || !result.approval || result.expiresInSeconds !== 900) throw new Error('invalid pack review')
          if (closed || owner !== await options.owner()) throw new Error('plan-stale')
          const token = randomBytes(32).toString('hex')
          pending = { token, owner, directory, inputs, approval: result.approval, expires: Date.now() + 900_000, added: [...names] }
          directory = undefined
          expiry = setTimeout(() => { if (!busy) void discard().catch(() => undefined) }, 900_000)
          expiry.unref()
          let publicPlan = JSON.stringify(result.packPlan)
          for (const [path, label] of [[result.packPlan['root'], '<project>'], [result.packPlan['store'], '<store>'], [tmpdir(), '<temporary>']] as const) {
            if (typeof path === 'string' && path) publicPlan = publicPlan.split(JSON.stringify(path).slice(1, -1)).join(label)
          }
          const plan: unknown = JSON.parse(publicPlan)
          reply(response, 200, { confirmation: token, plan,
            review: [...result.plan, JSON.stringify(plan, null, 2)].join('\n'), expiresInSeconds: 900 })
        } else {
          if (Object.keys(raw).length !== 1 || typeof raw['confirmation'] !== 'string') { reply(response, 400, { error: 'bad-request' }); return }
          const approved = pending
          if (!approved || approved.owner !== owner || approved.token !== raw['confirmation'] || Date.now() >= approved.expires) {
            await discard()
            reply(response, 409, { error: 'plan-stale' }); return
          }
          pending = undefined
          clearTimeout(expiry)
          directory = approved.directory
          const result = await options.run({ root: options.root, operation: 'packs-apply', inputs: approved.inputs, approval: approved.approval }, true)
          installedGeneration = result.current
          const activation = await options.activate(result, approved.added)
          reply(response, 200, { generation: result.current, activation })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const bad = message === 'bad-request'
        const code = bad ? 'bad-request' : message.includes('another environment writer') ? 'install-in-progress'
          : installedGeneration !== undefined ? 'activation-failed'
            : message === 'plan-stale' || /changed|expired|already used|approval does not match/.test(message) ? 'plan-stale'
              : action === 'apply' ? 'apply-failed' : 'plan-failed'
        // Environment tools retain detailed diagnostics locally; HTTP must not leak host paths.
        reply(response, bad ? 400 : ['install-in-progress', 'plan-stale', 'activation-failed'].includes(code) ? 409 : 422,
          { error: code, ...(installedGeneration === undefined ? {} : { generation: installedGeneration }) })
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    }
    busy = options.serialize(() => {
      if (closed) return Promise.resolve()
      executing = perform()
      return executing
    })
    try { await busy } finally {
      busy = undefined
      if (pending && Date.now() >= pending.expires) await discard()
    }
  }

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/api/packs/install/plan' || path === '/api/packs/install/apply') {
      void install(request, response, path.endsWith('/plan') ? 'plan' : 'apply').catch(() => response.destroy())
      return
    }
    if (request.headers.host !== new URL(origin).host || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      reply(response, 403, { error: 'origin-not-allowed' }); return
    }
    delete request.headers[PROJECT_INSTALL_HEADER]
    proxy.web(request, response, { target }, () => {
      if (!response.headersSent) reply(response, 502, { error: 'backend-unavailable' })
      else response.destroy()
    })
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.host !== new URL(origin).host || (request.headers.origin !== undefined && request.headers.origin !== origin)) { socket.destroy(); return }
    delete request.headers[PROJECT_INSTALL_HEADER]
    upgrades.add(socket)
    socket.once('close', () => upgrades.delete(socket))
    proxy.ws(request, socket, head, { target }, () => socket.destroy())
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.preferredPort ?? 0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('project gateway did not bind')
  origin = `http://127.0.0.1:${address.port}`
  return {
    url: origin,
    capability,
    setTarget: (url) => {
      target = loopbackTarget(url)
      for (const socket of upgrades) socket.destroy()
    },
    close: () => {
      closing ??= (async () => {
        closed = true
        await executing
        await discard()
        proxy.close()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve())
          for (const socket of sockets) socket.destroy()
        })
      })()
      return closing
    },
  }
}
