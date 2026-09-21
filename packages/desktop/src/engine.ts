import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import extract from 'extract-zip'
import * as tar from 'tar'
import { download, verifyFile } from './io.js'
import { ENGINE_RELEASE, supportedPlatform, syncArguments, torchBackend } from './release.js'
import {
  decodeEngineAccelerator,
  detectEngineAccelerator,
  engineProcessEnvironment,
  type EngineAccelerator,
} from './accelerator.js'
import type { LifecycleStatus } from './types.js'

export interface EngineRuntimeOptions {
  readonly dataDirectory: string
  readonly sourceArchive?: string
  readonly sourceDirectory?: string
  readonly aimdoWheel?: string
  readonly uvExecutable?: string
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

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  onLine: (line: string) => void,
  onSpawn: (child: ChildProcess) => void,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      ...(env ? { env } : {}),
    })
    onSpawn(child)
    const abort = () => {
      if (child.exitCode === null) child.kill()
    }
    signal.addEventListener('abort', abort, { once: true })
    let stderr = ''
    const consume = (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = `${stderr}${text}`.slice(-8000)
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim())
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.once('error', reject)
    child.once('exit', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        reject(new Error('Dinkster startup was cancelled'))
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`${basename(command)} exited with code ${String(code)}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

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

  private update(status: LifecycleStatus): void {
    this.current = status
    this.emit('status', status)
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
    const uv = this.options.uvExecutable ?? await this.ensureUv(signal)
    const env = this.environment(source, uv, variant)
    const constraints = join(source, '.dinkster-native', 'constraints.txt')
    if (torchBackend(variant) !== undefined && existsSync(constraints)) {
      env['UV_CONSTRAINT'] = constraints
      env['UV_TORCH_BACKEND'] = await readFile(join(source, '.dinkster-native', 'torch-backend'), 'utf8')
    }
    this.assertStarting(signal)
    if ((this.options.releaseCommit ?? ENGINE_RELEASE.commit) === ENGINE_RELEASE.commit) {
      this.update({ phase: 'installing', detail: 'Preparing the default node catalogs', variant })
      await run(uv, ['run', '--no-sync', 'dinkster-pack', 'prepare-catalogs', '--defaults', '--library-root', library], source, (detail) => {
        this.update({ phase: 'installing', detail, variant })
      }, (child) => this.track(child), signal, env)
    }
    this.assertStarting(signal)
    this.update({ phase: 'starting', detail: 'Starting the local Dinkster engine', variant })
    this.assertStarting(signal)
    const instance = randomUUID()
    // Another process may acquire the port during environment setup.
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
    this.child.stdout?.on('data', (chunk: Buffer) => this.emit('log', chunk.toString()))
    this.child.stderr?.on('data', (chunk: Buffer) => this.emit('log', chunk.toString()))
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
      await this.sync(this.options.sourceDirectory, variant, signal)
      return this.options.sourceDirectory
    }

    const releases = join(this.options.dataDirectory, 'engine', 'releases')
    const commit = this.options.releaseCommit ?? ENGINE_RELEASE.commit
    const legacyDestination = join(releases, commit)
    const destination = join(releases, `${commit}-${variant}`)
    const nativePins = this.nativePins(variant)
    const candidates = variant === 'cuda'
      ? [legacyDestination, join(releases, `${commit}-nvidia`), destination]
      : [legacyDestination, destination]
    for (const candidate of candidates) {
      const marker = join(candidate, '.dinkster-desktop-release.json')
      let installed: { commit?: string; variant?: string; nativeProfile?: string }
      try {
        installed = JSON.parse(await readFile(marker, 'utf8')) as typeof installed
      } catch {
        // Missing or incomplete releases are ignored.
        continue
      }
      if (installed?.commit === commit && decodeEngineAccelerator(installed.variant) === variant) {
        if (commit === ENGINE_RELEASE.commit && nativePins.nativeProfile && installed.nativeProfile !== nativePins.nativeProfile) {
          throw new Error('The installed backend has a different native runtime profile. This Desktop release must pin a new backend revision; the existing environment has not been changed.')
        }
        return candidate
      }
    }
    if (commit !== ENGINE_RELEASE.commit) {
      throw new Error(`the selected Dinkster release ${commit.slice(0, 12)} is no longer installed`)
    }
    const marker = join(destination, '.dinkster-desktop-release.json')
    if (!this.options.sourceArchive) throw new Error('no packaged Dinkster engine source was found')
    this.update({ phase: 'installing', detail: 'Preparing the locked Dinkster release', variant })
    await verifyFile(this.options.sourceArchive, ENGINE_RELEASE.sourceSha256)
    const staging = `${destination}.installing`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await extract(this.options.sourceArchive, { dir: staging })
    await mkdir(dirname(destination), { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await rename(join(staging, `dinkster-backend-${commit}`), destination)
    await rm(staging, { recursive: true, force: true })
    try {
      this.assertStarting(signal)
      await this.sync(destination, variant, signal)
      await writeFile(marker, JSON.stringify({
        commit,
        variant,
        ...nativePins,
      }, null, 2))
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
    return destination
  }

  private async sync(source: string, variant: EngineAccelerator, signal: AbortSignal): Promise<void> {
    const uv = this.options.uvExecutable ?? await this.ensureUv(signal)
    this.assertStarting(signal)
    this.update({ phase: 'installing', detail: `Installing the locked ${variant.toUpperCase()} environment`, variant })
    await run(uv, syncArguments(variant), source, (detail) => {
      this.update({ phase: 'installing', detail, variant })
    }, (child) => this.track(child), signal, this.environment(source, uv, variant))
    await this.installNative(source, uv, variant, signal)
  }

  private nativePins(variant: EngineAccelerator) {
    const enabled = this.options.aimdoWheel && torchBackend(variant) !== undefined
    return {
      nativeProfile: enabled ? ENGINE_RELEASE.nativeProfile : undefined,
      aimdoSha256: enabled ? ENGINE_RELEASE.aimdo.sha256 : undefined,
      cudaTorchSha256: enabled && variant === 'cuda'
        ? ENGINE_RELEASE.cudaTorch.sha256 : undefined,
    }
  }

  private async installNative(source: string, uv: string, variant: EngineAccelerator, signal: AbortSignal): Promise<void> {
    const backend = torchBackend(variant)
    if (!this.options.aimdoWheel || backend === undefined) return
    this.assertStarting(signal)
    await verifyFile(this.options.aimdoWheel, ENGINE_RELEASE.aimdo.sha256)
    const wheels = [this.options.aimdoWheel]
    if (this.nativePins(variant).cudaTorchSha256) {
      const pin = ENGINE_RELEASE.cudaTorch
      const wheel = join(this.options.dataDirectory, 'engine', 'native', pin.sha256, pin.archive)
      if (!existsSync(wheel)) {
        this.update({ phase: 'downloading', detail: `Downloading Windows CUDA Torch ${pin.version}`, variant })
        await download(pin.url, wheel, signal)
      }
      try {
        await verifyFile(wheel, pin.sha256)
      } catch (error) {
        await rm(wheel, { force: true })
        throw error
      }
      wheels.push(wheel)
    }
    this.assertStarting(signal)
    this.update({ phase: 'installing', detail: 'Installing the pinned native runtime', variant })
    await run(uv, [
      'pip', 'install', '--python', executable(source, 'python'),
      '--reinstall', '--no-index', '--no-deps', ...wheels,
    ], source, (detail) => {
      this.update({ phase: 'installing', detail, variant })
    }, (child) => this.track(child), signal, this.environment(source, uv, variant))
    if (this.nativePins(variant).cudaTorchSha256) {
      await run(uv, ['run', '--no-sync', 'python', '-c',
        `import torch; assert torch.__version__ == ${JSON.stringify(ENGINE_RELEASE.cudaTorch.version)}, torch.__version__; assert torch.version.cuda == ${JSON.stringify(ENGINE_RELEASE.cudaTorch.cudaVersion)}, torch.version.cuda`,
      ], source, (detail) => {
        this.update({ phase: 'installing', detail, variant })
      }, (child) => this.track(child), signal, this.environment(source, uv, variant))
    }
    const native = join(source, '.dinkster-native')
    await mkdir(native, { recursive: true })
    const aimdo = join(native, ENGINE_RELEASE.aimdo.archive)
    await copyFile(this.options.aimdoWheel, aimdo)
    await writeFile(join(native, 'constraints.txt'), [
      `torch==${ENGINE_RELEASE.cudaTorch.version.split('+')[0]}+${backend}`,
      `torchvision==${ENGINE_RELEASE.cudaTorch.torchvisionVersion}+${backend}`,
      `comfy-aimdo @ ${pathToFileURL(aimdo).href}`,
      '',
    ].join('\n'))
    await writeFile(join(native, 'torch-backend'), backend)
  }

  private environment(source: string, uv: string, variant: EngineAccelerator): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...engineProcessEnvironment(variant),
      UV_CACHE_DIR: join(this.options.dataDirectory, 'cache', 'uv'),
      UV_PROJECT_ENVIRONMENT: join(source, '.venv'),
      DINKSTER_COMFYUI_PYTHON: executable(source, 'python'),
    }
    delete env['UV_CONSTRAINT']
    delete env['UV_TORCH_BACKEND']
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    env[pathKey] = [dirname(uv), env[pathKey]].filter(Boolean).join(delimiter)
    return env
  }

  private async ensureUv(signal: AbortSignal): Promise<string> {
    const platform = supportedPlatform()
    const release = ENGINE_RELEASE.uv[platform]
    const root = join(this.options.dataDirectory, 'tools', `uv-${ENGINE_RELEASE.uvVersion}`)
    const result = join(root, release.executable)
    if (existsSync(result)) {
      try {
        await verifyFile(result, release.executableSha256)
        return result
      } catch {
        // A changed tool is replaced from the pinned release archive.
      }
    }
    const archive = join(root, release.archive)
    this.update({ phase: 'downloading', detail: `Downloading uv ${ENGINE_RELEASE.uvVersion}` })
    await download(
      `https://releases.astral.sh/github/uv/releases/download/${ENGINE_RELEASE.uvVersion}/${release.archive}`,
      archive,
      signal,
    )
    this.assertStarting(signal)
    await verifyFile(archive, release.sha256)
    if (archive.endsWith('.zip')) await extract(archive, { dir: root })
    else await tar.x({ file: archive, cwd: root, strict: true })
    if (!existsSync(result)) throw new Error(`uv archive did not contain ${release.executable}`)
    await verifyFile(result, release.executableSha256)
    return result
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
