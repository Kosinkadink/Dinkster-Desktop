import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { acquireEnvironmentTools, type EnvironmentToolsInput } from './environment-tools.js'
import type { DesktopServices } from './services.js'

const execute = promisify(execFile)
const home = '/home/dinkster'
const ownerFile = '/etc/dinkster-desktop-owner'
const configuration = '[automount]\nenabled=false\n[interop]\nenabled=false\nappendWindowsPath=false\n[user]\ndefault=dinkster'

export interface WslStatus {
  readonly available: boolean
  readonly ready: boolean
  readonly distribution: string
  readonly detail: string
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

  constructor(private readonly directory: string, private readonly bundledTools: EnvironmentToolsInput) {
    this.distribution = `Dinkster-Desktop-${createHash('sha256').update(win32.resolve(directory).toLowerCase()).digest('hex').slice(0, 12)}`
  }

  private async wsl(args: readonly string[]): Promise<string> {
    try {
      const result = await execute('wsl.exe', [...args], {
        // Environment history and restore results grow with sealed software inventories.
        encoding: 'buffer', windowsHide: true, timeout: 30 * 60_000, maxBuffer: Infinity,
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

  async prepare(): Promise<WslStatus> {
    const status = await this.status()
    if (!status.available) throw new Error(status.detail)
    if (status.ready) return status
    const names = (await this.wsl(['--list', '--quiet'])).split(/\r?\n/)
    const exists = names.some((name) => name.trim().toLowerCase() === this.distribution.toLowerCase())
    if (exists) {
      if (await this.command('root', 'cat', ownerFile).catch(() => '') !== this.distribution) throw new Error(status.detail)
    } else {
      const location = join(this.directory, 'wsl', this.distribution)
      await mkdir(dirname(location), { recursive: true })
      await this.wsl(['--install', 'Ubuntu-24.04', '--name', this.distribution, '--location', location, '--version', '2', '--no-launch'])
      await this.command('root', '/bin/sh', '-c', 'printf "%s\\n" "$1" > /etc/dinkster-desktop-owner', 'dinkster-owner', this.distribution)
    }
    await this.command('root', '/bin/sh', '-ec', `
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends bubblewrap ca-certificates
id dinkster >/dev/null 2>&1 || useradd --create-home --shell /bin/bash dinkster
mkdir -p /home/dinkster/projects /home/dinkster/models /home/dinkster/tools
chown dinkster:dinkster /home/dinkster/projects /home/dinkster/models /home/dinkster/tools
printf '%s\\n' '[automount]' 'enabled=false' '[interop]' 'enabled=false' 'appendWindowsPath=false' '[user]' 'default=dinkster' > /etc/wsl.conf
`)
    await this.wsl(['--terminate', this.distribution])
    const ready = await this.status()
    if (!ready.ready) throw new Error(ready.detail)
    return ready
  }

  projectRoot(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new Error('Invalid WSL project id')
    return wslWindowsPath(this.distribution, `${home}/projects/${id}`)
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

  async copyModels(source: string): Promise<string> {
    const status = await this.status()
    if (!status.ready) throw new Error(status.detail)
    if (!win32.isAbsolute(source) || wslLocation(source) || !(await stat(source)).isDirectory()) throw new Error('Choose an existing Windows model folder')
    const name = win32.basename(source)
    if (!name || name === '.' || name === '..' || /[/:\\\x00-\x1f]/.test(name)) throw new Error('Invalid model folder name')
    const target = `${home}/models/${name}`
    const destination = wslWindowsPath(this.distribution, target)
    try {
      await lstat(destination)
      throw new Error('A model folder with this name already exists on the WSL disk')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const stage = wslWindowsPath(this.distribution, `${target}-${randomUUID()}.copying`)
    try {
      await cp(source, stage, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, dereference: false,
        filter: async (path) => { if ((await lstat(path)).isSymbolicLink()) throw new Error('Model folders must not contain links'); return true } })
      await rename(stage, wslWindowsPath(this.distribution, target))
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }
    return target
  }
}
