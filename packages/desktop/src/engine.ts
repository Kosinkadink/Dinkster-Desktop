import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { diagnosticCall } from './hang-diagnostic.js'
import { ENGINE_RELEASE, torchBackend } from './release.js'
import {
  decodeEngineAccelerator,
  detectEngineAccelerator,
  engineProcessEnvironment,
  type EngineAccelerator,
} from './accelerator.js'
import type { LifecycleStatus } from './types.js'

export interface EngineRuntimeOptions {
  readonly dataDirectory: string
  readonly sourceDirectory?: string
  readonly variant?: EngineAccelerator
  readonly releaseCommit?: string
  readonly port?: number
}

function executable(root: string, name: string): string {
  return process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', `${name}.exe`)
    : join(root, '.venv', 'bin', name)
}

export function supervisorArguments(source: string, library: string, port: number, instance?: string): readonly string[] {
  return [
    '--host', '127.0.0.1', '--port', String(port), ...(instance ? ['--instance', instance] : []), '--',
    executable(source, 'dinkster-serve'), '--library-root', library, '--allow-mount-changes',
  ]
}

export function defaultDataDirectory(): string {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Dinkster Desktop')
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'dinkster-desktop')
}

async function probeLoopbackPort(port: number): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback port probe did not bind')
    return address.port
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

export async function availableLoopbackPort(): Promise<number> {
  return probeLoopbackPort(0)
}

export async function assertLoopbackPortAvailable(port: number): Promise<void> {
  try {
    await probeLoopbackPort(port)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`Dinkster backend port ${port} is already owned by another process`)
    }
    throw error
  }
}

function assertSupervisorStartup(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Dinkster startup was cancelled')
}

class SupervisorIdentityError extends Error {}

export async function waitForSupervisorReady(options: {
  readonly port: number
  readonly instance: string
  readonly variant: EngineAccelerator | undefined
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  readonly requestTimeoutMs?: number
  exitCode(): number | null | undefined
  update(status: LifecycleStatus): void
}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000)
  while (Date.now() < deadline) {
    assertSupervisorStartup(options.signal)
    if (options.exitCode() !== null) {
      throw new Error(`Dinkster supervisor exited with code ${String(options.exitCode())}`)
    }
    let status: {
      state?: string
      detail?: string
      instance?: string
      progress?: { done?: number; total?: number; phase?: string }
    } | undefined
    try {
      const remaining = deadline - Date.now()
      const requestSignal = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(Math.max(1, Math.min(options.requestTimeoutMs ?? 5000, remaining))),
      ])
      const response = await fetch(`http://127.0.0.1:${options.port}/supervisor/status`, { signal: requestSignal })
      if (response.ok) status = await response.json() as typeof status
    } catch {
      assertSupervisorStartup(options.signal)
    }
    if (status) {
      assertSupervisorStartup(options.signal)
      if (options.exitCode() !== null) {
        throw new Error(`Dinkster supervisor exited with code ${String(options.exitCode())}`)
      }
      if (status.instance !== options.instance) {
        throw new SupervisorIdentityError('Dinkster supervisor identity did not match the launched process')
      }
      if (status.state === 'ready') {
        options.update({ phase: 'running', detail: 'Dinkster is running locally', ...(options.variant ? { variant: options.variant } : {}) })
        return
      }
      if (status.state === 'failed') throw new Error(status.detail ?? 'Dinkster engine failed to start')
      const progress = status.progress
      const detail = progress?.done !== undefined && progress.total !== undefined
        ? `${progress.phase ?? 'Preparing engine'} (${progress.done}/${progress.total})`
        : status.detail || 'Waiting for the local Dinkster engine'
      options.update({ phase: 'starting', detail, ...(options.variant ? { variant: options.variant } : {}) })
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await delay(Math.min(250, remaining), undefined, { signal: options.signal })
  }
  throw new Error('Dinkster engine did not become ready within 10 minutes')
}

/** Launches an already provisioned checkout; project environments use dinkster-env. */
export class EngineRuntime extends EventEmitter {
  private current: LifecycleStatus = { phase: 'idle', detail: 'Waiting to start' }
  private child: ChildProcess | undefined
  private readonly processes = new Set<ChildProcess>()
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private startupAbort: AbortController | undefined
  private stopping = false
  private supervisorInstance: string | undefined

  constructor(private readonly options: EngineRuntimeOptions) {
    super()
  }

  get status(): LifecycleStatus {
    return this.current
  }

  async ownsBackend(): Promise<boolean> {
    const child = this.child
    const instance = this.supervisorInstance
    if (this.current.phase !== 'running' || !child?.pid || child.exitCode !== null || !instance || this.stopping) return false
    try {
      const response = await fetch(`http://127.0.0.1:${this.options.port ?? 3639}/supervisor/status`, {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      })
      if (!response.ok) return false
      const status = await response.json() as { state?: string; instance?: string }
      return this.child === child && child.exitCode === null && this.supervisorInstance === instance
        && !this.stopping && this.current.phase === 'running' && status.state === 'ready' && status.instance === instance
    } catch {
      return false
    }
  }

  private update(status: LifecycleStatus): void {
    this.current = status
    diagnosticCall('runtime-status-dispatch', () => this.emit('status', status))
  }

  private track(child: ChildProcess): void {
    this.processes.add(child)
    child.once('exit', () => this.processes.delete(child))
  }

  start(): Promise<void> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start())
    if (this.startPromise) return this.startPromise
    this.stopping = false
    this.startupAbort = new AbortController()
    this.startPromise = this.startInner(this.startupAbort.signal)
      .catch(async (error: unknown) => {
        if (error instanceof SupervisorIdentityError) {
          await Promise.allSettled([...this.processes].map((child) => this.terminate(child)))
          this.child = undefined
        }
        if (!this.stopping) {
          const message = error instanceof Error ? error.message : String(error)
          this.update({ phase: 'failed', detail: 'Dinkster could not start', error: message })
        }
        throw error
      })
      .finally(() => {
        this.startPromise = undefined
        this.startupAbort = undefined
      })
    return this.startPromise
  }

  private async startInner(signal: AbortSignal): Promise<void> {
    if (this.child?.pid !== undefined && this.child.exitCode === null) {
      this.update({ phase: 'starting', detail: 'Restarting the local Dinkster engine' })
      const response = await fetch(`http://127.0.0.1:${this.options.port ?? 3639}/supervisor/engine/restart`, {
        method: 'POST',
        signal,
      })
      if (!response.ok) throw new Error(`Dinkster supervisor restart failed with status ${response.status}`)
      if (!this.supervisorInstance) throw new Error('Dinkster supervisor identity is unavailable')
      await this.waitForSupervisor(this.options.port ?? 3639, this.supervisorInstance, undefined, signal)
      return
    }
    this.update({ phase: 'detecting', detail: 'Checking this computer' })
    const port = this.options.port ?? 3639
    await assertLoopbackPortAvailable(port)
    this.assertStarting(signal)
    const variant = this.options.variant ?? detectEngineAccelerator()
    this.assertStarting(signal)
    const source = await this.ensureSource(variant, signal)
    this.assertStarting(signal)
    const supervisor = executable(source, 'dinkster-supervisor')
    if (!existsSync(supervisor)) throw new Error(`locked environment did not create ${supervisor}`)

    const library = join(this.options.dataDirectory, 'library')
    await mkdir(library, { recursive: true })
    const env = engineProcessEnvironment(variant)
    env['DINKSTER_EXECUTION_PYTHON'] = executable(source, 'python')
    env['UV_PROJECT_ENVIRONMENT'] = join(source, '.venv')
    delete env['UV_CONSTRAINT']
    delete env['UV_TORCH_BACKEND']
    const constraints = join(source, '.dinkster-native', 'constraints.txt')
    if (torchBackend(variant) !== undefined && existsSync(constraints)) {
      env['UV_CONSTRAINT'] = constraints
      env['UV_TORCH_BACKEND'] = await readFile(join(source, '.dinkster-native', 'torch-backend'), 'utf8')
    }
    this.assertStarting(signal)
    this.update({ phase: 'starting', detail: 'Starting the local Dinkster engine', variant })
    this.assertStarting(signal)
    const instance = randomUUID()
    // Another process may acquire the port while the checkout is inspected.
    await assertLoopbackPortAvailable(port)
    this.assertStarting(signal)
    this.child = spawn(supervisor, supervisorArguments(source, library, port, instance), {
      cwd: source,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.supervisorInstance = instance
    this.track(this.child)
    this.child.stdout?.on('data', (chunk: Buffer) => diagnosticCall('runtime-log-dispatch', () => this.emit('log', chunk.toString())))
    this.child.stderr?.on('data', (chunk: Buffer) => diagnosticCall('runtime-log-dispatch', () => this.emit('log', chunk.toString())))
    await new Promise<void>((resolve, reject) => {
      this.child!.once('spawn', resolve)
      this.child!.once('error', reject)
    })
    await delay(100, undefined, { signal })
    this.assertStarting(signal)
    if (this.child.exitCode !== null) {
      throw new Error(`Dinkster supervisor exited with code ${String(this.child.exitCode)}`)
    }
    await this.waitForSupervisor(port, instance, variant, signal)
  }

  private assertStarting(signal: AbortSignal): void {
    if (this.stopping || signal.aborted) throw new Error('Dinkster startup was cancelled')
  }

  private async waitForSupervisor(
    port: number,
    instance: string,
    variant: EngineAccelerator | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await waitForSupervisorReady({
      port,
      instance,
      variant,
      signal,
      exitCode: () => this.child?.exitCode,
      update: (status) => this.update(status),
    })
  }

  private async ensureSource(variant: EngineAccelerator, signal: AbortSignal): Promise<string> {
    if (this.options.sourceDirectory) {
      this.assertStarting(signal)
      return this.options.sourceDirectory
    }

    const releases = join(this.options.dataDirectory, 'engine', 'releases')
    const commit = this.options.releaseCommit ?? ENGINE_RELEASE.commit
    const legacyDestination = join(releases, commit)
    const destination = join(releases, `${commit}-${variant}`)
    const candidates = variant === 'cuda'
      ? [legacyDestination, join(releases, `${commit}-nvidia`), destination]
      : [legacyDestination, destination]
    for (const candidate of candidates) {
      const marker = join(candidate, '.dinkster-desktop-release.json')
      let installed: { commit?: string; variant?: string }
      try {
        installed = JSON.parse(await readFile(marker, 'utf8')) as typeof installed
      } catch {
        // Missing or incomplete releases are ignored.
        continue
      }
      if (installed?.commit === commit && decodeEngineAccelerator(installed.variant) === variant) {
        return candidate
      }
    }
    throw new Error('No provisioned checkout is available. Use the project manager and dinkster-env to install an environment, or prepare DINKSTER_ENGINE_SOURCE before launching development mode.')
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.startupAbort?.abort()
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.processes].map((child) => this.terminate(child)))
      await Promise.allSettled(this.startPromise ? [this.startPromise] : [])
      await Promise.allSettled([...this.processes].map((child) => this.terminate(child)))
      this.child = undefined
      this.update({ phase: 'stopped', detail: 'Dinkster has stopped' })
    })().finally(() => {
      this.stopPromise = undefined
    })
    return this.stopPromise
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      await Promise.race([
        new Promise<void>((resolve) => killer.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ])
      if (killer.exitCode === null) killer.kill()
      return
    }
    try { process.kill(-child.pid, 'SIGTERM') } catch { return }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* The process exited between checks. */ }
    }
  }
}
