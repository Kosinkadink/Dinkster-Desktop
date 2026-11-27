import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { acquireEnvironmentTools, type EnvironmentToolsInput } from './environment-tools.js'
import { download, verifyFile } from './io.js'
import type { DesktopServices } from './services.js'

const execute = promisify(execFile)
const home = '/home/dinkster'
const ownerFile = '/etc/dinkster-desktop-owner'
const configuration = '[automount]\nenabled=false\n[interop]\nenabled=false\nappendWindowsPath=false\n[user]\ndefault=dinkster'
// Ubuntu-24.04 amd64 entry in Microsoft's WSL distributions/DistributionInfo.json.
const rootfs = {
  url: 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl',
  sha256: 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e',
  size: 388975696,
}

export interface WslStatus {
  readonly available: boolean
  readonly ready: boolean
  readonly distribution: string
  readonly detail: string
}

export interface WslProgress {
  readonly stage: string
  readonly completed: number
  readonly total: number | null
}

export interface WslJob {
  readonly id: string
  readonly operation: 'prepare' | 'copy-models'
  readonly state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  readonly progress: WslProgress
  readonly result?: WslStatus | string
  readonly error?: string
}

export function wslLocation(path: string): { distribution: string; path: string } | undefined {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\(Dinkster-Desktop-[a-f0-9]{12})(?:\\(.*))?$/i.exec(path)
  if (!match) return undefined
  const parts = (match[2] ?? '').split('\\')
  if (parts.some((part) => part === '.' || part === '..' || /[/:\x00-\x1f]/.test(part))) throw new Error('Invalid WSL path')
  return { distribution: match[1]!, path: `/${parts.filter(Boolean).join('/')}` }
}

export function wslWindowsPath(distribution: string, path: string): string {
  if (!/^Dinkster-Desktop-[a-f0-9]{12}$/i.test(distribution) || !posix.isAbsolute(path)
    || /[\\:\x00-\x1f]/.test(path) || path.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid WSL path')
  return `\\\\wsl.localhost\\${distribution}${path.replaceAll('/', '\\')}`
}

export function wslLinuxPath(distribution: string, path: string): string {
  const location = wslLocation(path)
  if (location?.distribution.toLowerCase() !== distribution.toLowerCase()) {
    throw new Error('Choose a folder on this Desktop WSL disk, or copy it into WSL first')
  }
  return location.path
}

function decode(output: Buffer): string {
  return output.toString(output.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').trim()
}

/** Owns one private distribution; never adopts or reconfigures a user's distribution. */
export class WslHost {
  readonly distribution: string
  private readonly commands = new Map<string, Promise<string>>()
  private readonly jobs = new Map<string, { owner: string; value: WslJob }>()
  private readonly pendingCleanup = new Set<() => Promise<void>>()
  private active: { controller: AbortController; done: Promise<void> } | undefined

  constructor(private readonly directory: string, private readonly bundledTools: EnvironmentToolsInput) {
    this.distribution = `Dinkster-Desktop-${createHash('sha256').update(win32.resolve(directory).toLowerCase()).digest('hex').slice(0, 12)}`
  }

  startPrepare(owner: string): WslJob {
    return this.startJob(owner, 'prepare', (signal, progress) => this.prepare(signal, progress))
  }

  startCopy(owner: string, source: string): WslJob {
    return this.startJob(owner, 'copy-models', (signal, progress) => this.copyModels(source, signal, progress))
  }

  job(owner: string, id: string): WslJob {
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner) throw new Error('Unknown WSL job for this window')
    return job.value
  }

  cancelJob(owner: string, id: string): WslJob {
    const value = this.job(owner, id)
    if (value.state === 'running') {
      this.jobs.get(id)!.value = { ...value, state: 'cancelling' }
      this.active!.controller.abort()
    }
    return this.job(owner, id)
  }

  cancelOwner(owner: string): void {
    for (const { owner: jobOwner, value } of this.jobs.values()) {
      if (jobOwner === owner && value.state === 'running') this.cancelJob(owner, value.id)
    }
  }

  async close(): Promise<void> {
    this.active?.controller.abort()
    await this.active?.done
    for (const action of this.pendingCleanup) await this.cleanup(action)
  }

  private async cleanup(action: () => Promise<void>): Promise<void> {
    this.pendingCleanup.add(action)
    await action()
    this.pendingCleanup.delete(action)
  }

  private startJob(owner: string, operation: WslJob['operation'], action: (signal: AbortSignal, progress: (value: WslProgress) => void) => Promise<WslStatus | string>): WslJob {
    if (this.active) throw new Error('Another WSL operation is still running')
    if (this.pendingCleanup.size) throw new Error('WSL cleanup is incomplete; close Desktop to retry cleanup before starting another operation')
    const id = randomUUID()
    const controller = new AbortController()
    const entry = { owner, value: { id, operation, state: 'running', progress: { stage: 'checking', completed: 0, total: null } } as WslJob }
    this.jobs.set(id, entry)
    while (this.jobs.size > 16) this.jobs.delete(this.jobs.keys().next().value!)
    const done = Promise.resolve().then(async () => {
      try {
        const result = await action(controller.signal, (progress) => { entry.value = { ...entry.value, progress } })
        entry.value = { ...entry.value, state: 'completed', result }
      } catch (error) {
        entry.value = { ...entry.value, state: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
          ...(error instanceof Error && error.name === 'AbortError' ? {} : { error: error instanceof Error ? error.message : String(error) }) }
      } finally { this.active = undefined }
    })
    this.active = { controller, done }
    return entry.value
  }

  private async wsl(args: readonly string[], signal?: AbortSignal): Promise<string> {
    try {
      const result = await execute('wsl.exe', [...args], {
        // Environment history and restore results grow with sealed software inventories.
        encoding: 'buffer', windowsHide: true, timeout: 30 * 60_000, maxBuffer: Infinity, ...(signal ? { signal } : {}),
      })
      return decode(result.stdout)
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: Buffer | string }
      if (Buffer.isBuffer(failure.stdout)) failure.stdout = decode(failure.stdout)
      // WSL can return valid help text with exit code 0xffffffff; capability checks still inspect it.
      if (args.length === 1 && args[0] === '--help' && failure.code === 4294967295 && typeof failure.stdout === 'string') return failure.stdout
      throw error
    }
  }

  private command(user: 'root' | 'dinkster', ...args: string[]): Promise<string> {
    return this.wsl(['--distribution', this.distribution, '--user', user, '--cd', user === 'root' ? '/' : home, '--exec', '/usr/bin/env', '-i',
      `HOME=${user === 'root' ? '/root' : home}`, 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...args])
  }

  private async removePreparation(location: string): Promise<void> {
    // A failed import can register before wsl.exe returns an error. Check its
    // actual disk path, not just the name, before deleting a registration.
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'; @(if (Test-Path $key) { Get-ChildItem $key | Get-ItemProperty | Select-Object DistributionName,BasePath }) | ConvertTo-Json -Compress`],
    { encoding: 'buffer', windowsHide: true, timeout: 30_000 })
    const text = decode(stdout)
    const registrations: { DistributionName: string; BasePath: string }[] = text ? [JSON.parse(text)].flat() : []
    const canonical = (path: string) => win32.resolve(path.replace(/^\\\\\?\\/, '')).toLowerCase()
    const disk = join(location, 'disk')
    const owned = registrations.filter((entry) => canonical(entry.BasePath) === canonical(disk))
    if (owned.some((entry) => entry.DistributionName !== this.distribution)
      || registrations.some((entry) => entry.DistributionName === this.distribution && canonical(entry.BasePath) !== canonical(disk))) {
      throw new Error('WSL registration ownership changed; its disk was not removed')
    }
    if (owned.length) await this.wsl(['--unregister', this.distribution])
    await rm(location, { recursive: true, force: true })
  }

  async status(): Promise<WslStatus> {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      return { available: false, ready: false, distribution: this.distribution, detail: 'The WSL2 engine option needs Windows x64 and the Linux x64 environment tools.' }
    }
    try {
      await this.wsl(['--version'])
    } catch {
      return { available: false, ready: false, distribution: this.distribution,
        detail: 'WSL2 is not installed or enabled. In Administrator PowerShell run wsl --install --no-distribution, restart Windows if requested, then reopen Desktop.' }
    }
    const help = await this.wsl(['--help'])
    if (!help.includes('--name') || !help.includes('--location')) {
      return { available: false, ready: false, distribution: this.distribution, detail: 'Update WSL with wsl --update to support a private named distribution, then reopen Desktop.' }
    }
    const names = (await this.wsl(['--list', '--quiet'])).split(/\r?\n/)
    if (!names.some((name) => name.trim().toLowerCase() === this.distribution.toLowerCase())) {
      return { available: true, ready: false, distribution: this.distribution, detail: 'Prepare a private Ubuntu WSL2 distribution. Existing distributions and Windows settings are left unchanged.' }
    }
    try {
      if (await this.command('root', 'cat', ownerFile) !== this.distribution) throw new Error('ownership')
      if (await this.command('root', 'cat', '/etc/wsl.conf') !== configuration) throw new Error('private WSL configuration')
      await this.command('dinkster', '/bin/sh', '-ec', '! mountpoint -q /mnt/c')
      const kernel = await this.command('dinkster', 'uname', '-r')
      if (!kernel.toLowerCase().includes('wsl2')) throw new Error('WSL2 kernel')
      await this.command('dinkster', '/usr/bin/bwrap', '--version')
      return { available: true, ready: true, distribution: this.distribution, detail: 'Private WSL2 distribution ready. Packs, models and libraries stay on its Linux disk.' }
    } catch {
      return { available: true, ready: false, distribution: this.distribution,
        detail: 'The private distribution is incomplete or not owned by this Desktop installation. Desktop will not adopt or overwrite an unrecognized distribution.' }
    }
  }

  async prepare(signal?: AbortSignal, progress: (value: WslProgress) => void = () => {}): Promise<WslStatus> {
    signal?.throwIfAborted()
    const status = await this.status()
    if (!status.available) throw new Error(status.detail)
    if (status.ready) return status
    const names = (await this.wsl(['--list', '--quiet'])).split(/\r?\n/)
    const exists = names.some((name) => name.trim().toLowerCase() === this.distribution.toLowerCase())
    if (exists) {
      if (await this.command('root', 'cat', ownerFile).catch(() => '') !== this.distribution) throw new Error(status.detail)
      throw new Error('The existing private distribution is incomplete. It was not changed; repair it before preparing WSL again.')
    }
    signal?.throwIfAborted()
    const parent = join(this.directory, 'wsl')
    await mkdir(parent, { recursive: true })
    const location = await mkdtemp(join(parent, 'prepare-'))
    let importing = false
    try {
      const archive = join(location, 'ubuntu.wsl')
      progress({ stage: 'downloading-distribution', completed: 0, total: rootfs.size })
      await download(rootfs.url, archive, signal, rootfs.size, (completed) => {
        progress({ stage: 'downloading-distribution', completed, total: rootfs.size })
      })
      await verifyFile(archive, rootfs.sha256)
      signal?.throwIfAborted()
      progress({ stage: 'installing-distribution', completed: 0, total: 3 })
      // Registration must finish before cancellation can safely unregister exactly
      // the distribution this operation created, rather than an in-flight install.
      await mkdir(join(location, 'disk'))
      importing = true
      await this.wsl(['--import', this.distribution, join(location, 'disk'), archive, '--version', '2'])
      await rm(archive)
      signal?.throwIfAborted()
      await this.command('root', '/bin/sh', '-c', 'printf "%s\\n" "$1" > /etc/dinkster-desktop-owner', 'dinkster-owner', this.distribution)
      progress({ stage: 'configuring-distribution', completed: 1, total: 3 })
      signal?.throwIfAborted()
      await this.wsl(['--distribution', this.distribution, '--user', 'root', '--cd', '/', '--exec', '/usr/bin/env', '-i',
        'HOME=/root', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/bin/sh', '-ec', `
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends bubblewrap ca-certificates
id dinkster >/dev/null 2>&1 || useradd --create-home --shell /bin/bash dinkster
mkdir -p /home/dinkster/projects /home/dinkster/models /home/dinkster/tools
chown dinkster:dinkster /home/dinkster/projects /home/dinkster/models /home/dinkster/tools
printf '%s\\n' '[automount]' 'enabled=false' '[interop]' 'enabled=false' 'appendWindowsPath=false' '[user]' 'default=dinkster' > /etc/wsl.conf
`], signal)
      signal?.throwIfAborted()
      await this.wsl(['--terminate', this.distribution])
      progress({ stage: 'checking-distribution', completed: 2, total: 3 })
      const ready = await this.status()
      if (!ready.ready) throw new Error(ready.detail)
      signal?.throwIfAborted()
      progress({ stage: 'ready', completed: 3, total: 3 })
      return ready
    } catch (error) {
      progress({ stage: 'removing-distribution', completed: 0, total: null })
      try {
        // Unregister stops guest commands even if cancellation only stopped the
        // Windows client. Before import, only our temporary download exists.
        await this.cleanup(() => importing ? this.removePreparation(location) : rm(location, { recursive: true, force: true }))
      } catch (cleanup) { throw new AggregateError([error, cleanup], 'WSL preparation failed and its new distribution could not be removed') }
      throw error
    }
  }

  projectRoot(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new Error('Invalid WSL project id')
    return wslWindowsPath(this.distribution, `${home}/projects/${id}`)
  }

  async configureHome(): Promise<void> {
    const python = await this.tools(this.bundledTools)
    const path = join(this.directory, 'wsl-context.json')
    const pending = `${path}-${randomUUID()}.pending`
    try {
      await writeFile(pending, JSON.stringify({ distribution: this.distribution, python }), { flag: 'wx' })
      await rename(pending, path)
    } finally { await rm(pending, { force: true }) }
  }

  private async tools(input: EnvironmentToolsInput): Promise<string> {
    const key = input.sha256
    let pending = this.commands.get(key)
    if (!pending) {
      pending = this.installTools(input).catch((error: unknown) => { this.commands.delete(key); throw error })
      this.commands.set(key, pending)
    }
    return pending
  }

  private async installTools(input: EnvironmentToolsInput): Promise<string> {
    const status = await this.status()
    if (!status.ready) throw new Error(status.detail)
    const tools = await acquireEnvironmentTools({ ...input, platform: 'linux', cacheRoot: wslWindowsPath(this.distribution, `${home}/tools/${input.sha256}`) })
    const python = wslLinuxPath(this.distribution, tools.python)
    const target = posix.dirname(posix.dirname(python))
    await this.command('dinkster', '/bin/sh', '-ec', 'chmod -R u+rwX "$1"; chmod u+x "$1"/bin/*', 'dinkster-tools', target)
    return python
  }

  async run(args: readonly string[], input = this.bundledTools, services: DesktopServices = 'production'): Promise<string> {
    const python = await this.tools(input)
    // Resolve bundled subprocess tools before the private distro's system utilities.
    return this.command('dinkster', '/usr/bin/env',
      `PATH=${posix.dirname(python)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      `DINKSTER_SERVICES=${services}`,
      python, '-I', '-m', 'dinkster_supervisor.environment', ...args)
  }

  async copyModels(source: string, signal?: AbortSignal, progress: (value: WslProgress) => void = () => {}): Promise<string> {
    signal?.throwIfAborted()
    const status = await this.status()
    if (!status.ready) throw new Error(status.detail)
    if (!win32.isAbsolute(source) || wslLocation(source)) throw new Error('Choose an existing Windows model folder')
    const sourceInfo = await lstat(source)
    if (sourceInfo.isSymbolicLink()) throw new Error('Model folders must not contain links')
    if (!sourceInfo.isDirectory()) throw new Error('Choose an existing Windows model folder')
    const name = win32.basename(source)
    if (!name || name === '.' || name === '..' || /[/:\\\x00-\x1f]/.test(name)) throw new Error('Invalid model folder name')
    const target = `${home}/models/${name}`
    const destination = wslWindowsPath(this.distribution, target)
    try {
      await lstat(destination)
      throw new Error('A model folder with this name already exists on the WSL disk')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const stage = wslWindowsPath(this.distribution, `${target}-${randomUUID()}.copying`)
    const files: { source: string; relative: string; size: number }[] = []
    const directories: string[] = []
    const scan = async (folder: string, relative: string): Promise<void> => {
      signal?.throwIfAborted()
      directories.push(relative)
      for (const name of await readdir(folder)) {
        const path = win32.join(folder, name)
        const child = win32.join(relative, name)
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error('Model folders must not contain links')
        if (info.isDirectory()) await scan(path, child)
        else if (info.isFile()) files.push({ source: path, relative: child, size: info.size })
        else throw new Error('Model folders must contain only regular files and directories')
      }
    }
    progress({ stage: 'scanning-models', completed: 0, total: null })
    await scan(source, '')
    let completed = 0
    const total = files.reduce((sum, file) => sum + file.size, 0)
    progress({ stage: 'copying-models', completed, total })
    await mkdir(stage)
    try {
      for (const directory of directories.slice(1)) await mkdir(win32.join(stage, directory))
      for (const file of files) {
        signal?.throwIfAborted()
        if ((await lstat(file.source)).isSymbolicLink()) throw new Error('Model folders must not contain links')
        const input = createReadStream(file.source)
        input.on('data', (chunk) => { completed += chunk.length; progress({ stage: 'copying-models', completed, total }) })
        await pipeline(input, createWriteStream(win32.join(stage, file.relative), { flags: 'wx' }), ...(signal ? [{ signal }] : []))
      }
      signal?.throwIfAborted()
      await rename(stage, wslWindowsPath(this.distribution, target))
    } catch (error) {
      progress({ stage: 'removing-partial-copy', completed, total })
      await this.cleanup(() => rm(stage, { recursive: true, force: true }))
      throw error
    }
    return target
  }
}
