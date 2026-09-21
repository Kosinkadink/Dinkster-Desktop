import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import httpProxy from 'http-proxy'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const PROXY_PREFIXES = ['/api', '/memory', '/supervisor', '/object_info', '/prompt', '/interrupt', '/view', '/history', '/queue', '/system_stats', '/ws']

function isProxyPath(path: string): boolean {
  return PROXY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`))
}

export interface WebHost {
  readonly url: string
  close(): Promise<void>
}

/**
 * Serve the renderer from a stable localhost origin. The port is part of the
 * renderer's web origin, which keys localStorage (connection profiles,
 * projects, workflows): a different port on the next launch would silently
 * present an empty app. Callers pass the previously used port back in as
 * preferredPort; only when it is missing or already taken does the host fall
 * back to a fresh ephemeral port.
 */
export async function createWebHost(appDirectory: string, backendPort = 3639, preferredPort?: number): Promise<WebHost> {
  const appRoot = resolve(appDirectory)
  const target = `http://127.0.0.1:${backendPort}`
  const proxy = httpProxy.createProxyServer({ target, ws: true, changeOrigin: true })
  const sockets = new Set<Socket>()
  let webSocketSource = "'none'"
  proxy.on('error', (_error, _request, responseOrSocket) => {
    if ('destroy' in responseOrSocket) responseOrSocket.destroy()
  })
  const server: Server = createServer((request, response) => {
    const requestPath = request.url ?? '/'
    if (isProxyPath(requestPath)) {
      proxy.web(request, response, {}, (error) => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'backend-unavailable', detail: error.message }))
      })
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(requestPath, 'http://127.0.0.1').pathname)
    } catch {
      response.writeHead(400).end()
      return
    }
    const relative = normalize(pathname).replace(/^([/\\])+/, '')
    let file = resolve(appRoot, relative)
    if (!file.startsWith(`${appRoot}${process.platform === 'win32' ? '\\' : '/'}`) && file !== appRoot) {
      response.writeHead(403).end()
      return
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(appRoot, 'index.html')
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': `default-src 'self'; connect-src 'self' ${webSocketSource}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'`,
      'x-content-type-options': 'nosniff',
    })
    createReadStream(file).pipe(response)
  })
  server.on('upgrade', (request, socket, head) => {
    if (isProxyPath(request.url ?? '/')) {
      proxy.ws(request, socket, head, {}, () => socket.destroy())
    }
    else socket.destroy()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const listen = (port: number): Promise<boolean> => new Promise<boolean>((resolveListen, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (port !== 0 && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) resolveListen(false)
      else reject(error)
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolveListen(true)
    })
  })
  const valid = preferredPort !== undefined && Number.isInteger(preferredPort) && preferredPort >= 1 && preferredPort <= 65535
  if (!valid || !(await listen(preferredPort!))) await listen(0)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('desktop web host did not bind a TCP port')
  webSocketSource = `ws://127.0.0.1:${address.port}`
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      proxy.close()
      server.close((error) => error ? reject(error) : resolveClose())
      for (const socket of sockets) socket.destroy()
    }),
  }
}
