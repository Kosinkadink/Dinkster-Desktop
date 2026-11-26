import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, readlink } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { Socket } from 'node:net'
import { delimiter, dirname, isAbsolute, join, toNamespacedPath } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { acquireEnvironmentTools, type EnvironmentToolsInput } from './environment-tools.js'
import { LifecycleQueue } from './lifecycle-queue.js'

const execute = promisify(execFile)

async function requireOwnedConnection(child: ChildProcess, socket: Socket): Promise<void> {
  const alive = (): boolean => !!child.pid && child.exitCode === null && child.signalCode === null && !child.killed && !socket.destroyed
  if (!alive() || socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1'
    || !socket.localPort || !socket.remotePort) throw new Error('The owned Dinkster connection is no longer live')
  const pid = child.pid!
  const port = socket.remotePort
  const clientPort = socket.localPort
  let owned = false
  if (process.platform === 'linux') {
    const directory = `/proc/${pid}/fd`
    const sockets = new Set(await Promise.all((await readdir(directory)).map(async (fd) => {
      try { return (await readlink(`${directory}/${fd}`)).match(/^socket:\[(\d+)\]$/)?.[1] }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    })))
    const rows = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1)
      .map((line) => line.trim().split(/\s+/)).filter((row) => sockets.has(row[9]))
    const address = (value: number): string => `0100007F:${value.toString(16).toUpperCase().padStart(4, '0')}`
    owned = rows.some((row) => row[1] === address(port) && row[3] === '0A')
      && rows.some((row) => row[1] === address(port) && row[2] === address(clientPort) && row[3] === '01')
  } else if (process.platform === 'win32') {
    const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `$rows = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -OwningProcess ${pid} -ErrorAction Stop); [bool]((@($rows | Where-Object { $_.State -eq 'Listen' }).Count -gt 0) -and (@($rows | Where-Object { $_.State -eq 'Established' -and $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq ${clientPort} }).Count -eq 1))`,
    ], { windowsHide: true, timeout: 10_000 })
    owned = stdout.trim() === 'True'
  } else if (process.platform === 'darwin') {
    const states = await Promise.all(['LISTEN', 'ESTABLISHED'].map(async (state) => {
      const { stdout } = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', `-sTCP:${state}`, '-Fn'], { timeout: 10_000 })
      return stdout.trim().split('\n')
    }))
    owned = states[0]!.includes(`n127.0.0.1:${port}`) && states[1]!.includes(`n127.0.0.1:${port}->127.0.0.1:${clientPort}`)
  }
  if (!owned || !alive()) throw new Error('The Dinkster child does not own the live listener and connection')
}

export interface HomeStatus {
  readonly protocol: 1
  readonly role: 'home'
  readonly supervisor: { readonly pid: number }
  readonly instance?: string
  readonly frontend?: string
  readonly frontendKind?: string
  readonly installationFrontend?: string
  readonly state: string
  readonly open?: { readonly root: string; readonly engine: string }
}

export class HomeProcess {
  readonly url: string
  private started: { child: ChildProcess; pid: number; instance: string } | undefined
  private readonly queue = new LifecycleQueue()

  constructor(private readonly options: {
    readonly port?: number
    readonly frontend: string
    readonly dataDirectory: string
    readonly tools: EnvironmentToolsInput
    readonly python?: string
  }) {
    const port = options.port ?? 3638
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Dinkster process port')
    this.url = `http://127.0.0.1:${port}`
  }

  private json(path: string, method: 'GET' | 'POST', agent?: Agent): Promise<{ ok: boolean; value: unknown; socket: Socket }> {
    return new Promise((resolve, reject) => {
      const pending = request(new URL(path, this.url), {
        method, agent: agent ?? false,
        signal: AbortSignal.timeout(method === 'GET' ? 2000 : 300_000),
      }, (response) => {
        const socket = response.socket
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          try { resolve({ ok: response.statusCode === 200, value: JSON.parse(Buffer.concat(chunks).toString()), socket }) }
          catch (error) { reject(error) }
        })
      })
      pending.on('error', reject)
      pending.end()
    })
  }

  status(): Promise<HomeStatus | undefined> {
    return this.readStatus()
  }

  async ownedStatus(project: string): Promise<HomeStatus> {
    const owner = this.started
    if (!owner) throw new Error('Native file access requires a Dinkster process started by this Desktop')
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const status = await this.readStatus(agent, project, owner)
      if (!status) throw new Error('The owned Dinkster process is no longer available')
      return status
    } finally { agent.destroy() }
  }

  private async readStatus(agent?: Agent, project?: string, owner?: NonNullable<HomeProcess['started']>): Promise<HomeStatus | undefined> {
    let response: { ok: boolean; value: unknown; socket: Socket }
    try {
      response = await this.json(`/supervisor/status${project === undefined ? '' : `?${new URLSearchParams({ project })}`}`, 'GET', agent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return undefined
      throw error
    }
    const value = response.value as Partial<HomeStatus> | null
    if (!response.ok || !value || value.protocol !== 1 || value.role !== 'home'
      || !Number.isSafeInteger(value.supervisor?.pid) || value.supervisor!.pid <= 0) {
      throw new Error('The selected port does not answer as the Dinkster process')
    }
    if (owner) {
      await requireOwnedConnection(owner.child, response.socket)
      if (this.started !== owner || value.supervisor!.pid !== owner.pid || value.instance !== owner.instance) {
        throw new Error('The owned Dinkster process identity changed')
      }
    }
    return value as HomeStatus
  }

  start(): Promise<HomeStatus> {
    return this.queue.run(() => this.startProcess())
  }

  private async startProcess(): Promise<HomeStatus> {
    const running = await this.status()
    if (running) return running
    const python = this.options.python ?? (await acquireEnvironmentTools({ ...this.options.tools,
      cacheRoot: this.options.tools.cacheRoot ?? join(this.options.dataDirectory, 'home-tools'),
    })).python
    if (!isAbsolute(python)) throw new Error('The Dinkster tools interpreter must be absolute')
    // Tools acquisition can take long enough for the command-line launcher to win.
    const raced = await this.status()
    if (raced) return raced
    await mkdir(this.options.dataDirectory, { recursive: true })
    const log = await open(join(this.options.dataDirectory, 'home.log'), 'a')
    const instance = randomUUID()
    let failure: Error | undefined
    let child: ChildProcess | undefined
    try {
      const environment = { ...process.env }
      const hostPath = Object.entries(environment).find(([name]) => name.toLowerCase() === 'path')?.[1]
      for (const name of Object.keys(environment)) if (name.toLowerCase() === 'path' || /^PYTHON/i.test(name)) delete environment[name]
      const toolsPath = [dirname(python), ...(process.platform === 'win32' ? [join(dirname(python), 'Scripts')] : [])].join(delimiter)
      environment['PATH'] = hostPath ? `${toolsPath}${delimiter}${hostPath}` : toolsPath
      child = spawn(toNamespacedPath(python), ['-I', '-m', 'dinkster_supervisor.home',
        '--port', new URL(this.url).port, '--frontend-root', this.options.frontend, '--instance', instance], {
        env: environment, cwd: dirname(python), detached: true, windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      })
      child.on('error', (error) => { failure = error })
      child.unref()
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const status = await this.status()
        if (status) {
          if (status.instance === instance && status.supervisor.pid === child.pid) {
            this.started = { child, pid: status.supervisor.pid, instance }
          } else child.kill()
          return status
        }
        if (failure) throw failure
        if (child.exitCode !== null) throw new Error('Dinkster did not start; inspect home.log')
        await setTimeout(50)
      }
      throw new Error('Dinkster did not become ready; inspect home.log')
    } catch (error) {
      // No page has loaded yet, so this child has not been asked to open an engine.
      child?.kill()
      throw error
    } finally {
      await log.close()
    }
  }

  stop(): Promise<void> {
    return this.queue.run(() => this.stopProcess())
  }

  private async stopProcess(): Promise<void> {
    if (!this.started) return
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const status = await this.readStatus(agent)
      if (!status || status.instance !== this.started.instance || status.supervisor.pid !== this.started.pid) {
        this.started = undefined
        return
      }
      // Shutdown must use the connection that answered status. A new connection
      // could reach an unrelated process that replaced it on the same port.
      agent.createConnection = (_options, callback) => {
        callback?.(new Error('The owned Dinkster process connection closed before shutdown'), new Socket())
        return undefined
      }
      const response = await this.json('/supervisor/shutdown', 'POST', agent)
      const result = response.value as { status?: string } | null
      if (!response.ok || result?.status !== 'stopped') throw new Error('Dinkster did not stop every engine it started')
      this.started = undefined
    } finally {
      agent.destroy()
    }
  }
}
