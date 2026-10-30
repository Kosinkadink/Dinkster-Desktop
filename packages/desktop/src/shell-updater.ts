import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import { configuredUpdateFeed } from './update-feed.js'

const MARKER_VERSION = 1
const MAX_INSTALL_ATTEMPTS = 3

export interface ShellUpdaterTarget {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<{ readonly updateInfo?: { readonly version: string } } | null>
  downloadUpdate(): Promise<readonly string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface ShellUpdateStatus {
  readonly state: 'idle' | 'checking' | 'ready' | 'current' | 'installing' | 'failed'
  readonly detail: string
}

interface AttemptMarker {
  readonly version: number
  readonly pending?: {
    readonly version: string
    readonly attempts: number
  }
}

export interface ShellUpdaterOptions {
  readonly target: ShellUpdaterTarget
  readonly dataDirectory: string
  readonly currentVersion: string
  readonly updateFeed: string | undefined
  readonly packaged: boolean
}

function markerPath(dataDirectory: string): string {
  return join(dataDirectory, 'updates', 'shell-attempts.json')
}

function decodeMarker(value: unknown): AttemptMarker | undefined {
  if (!value || typeof value !== 'object') return undefined
  const marker = value as Record<string, unknown>
  if (marker['version'] !== MARKER_VERSION) return undefined
  const pendingValue = marker['pending']
  if (pendingValue === undefined) return { version: MARKER_VERSION }
  if (!pendingValue || typeof pendingValue !== 'object') return undefined
  const pending = pendingValue as Record<string, unknown>
  const version = pending['version']
  const attempts = pending['attempts']
  if (typeof version !== 'string' || !version || typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) {
    return undefined
  }
  return { version: MARKER_VERSION, pending: { version, attempts } }
}

async function readMarker(path: string): Promise<AttemptMarker | 'corrupt'> {
  try {
    const decoded = decodeMarker(JSON.parse(await readFile(path, 'utf8')))
    return decoded ?? 'corrupt'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: MARKER_VERSION }
    return 'corrupt'
  }
}

export class ShellUpdater {
  private statusValue: ShellUpdateStatus = { state: 'idle', detail: 'Updates have not been checked' }
  private readonly marker: string
  private startPromise: Promise<ShellUpdateStatus> | undefined

  constructor(private readonly options: ShellUpdaterOptions) {
    this.marker = markerPath(options.dataDirectory)
    options.target.autoDownload = false
    options.target.autoInstallOnAppQuit = false
  }

  get status(): ShellUpdateStatus {
    return this.statusValue
  }

  /** The renderer can observe this status but cannot initiate an update. */
  manualStatus(): ShellUpdateStatus {
    return this.status
  }

  async start(): Promise<ShellUpdateStatus> {
    this.startPromise ??= this.startOnce()
    return this.startPromise
  }

  private async startOnce(): Promise<ShellUpdateStatus> {
    const feed = configuredUpdateFeed(this.options.updateFeed)
    if (!feed) return this.setStatus('idle', 'The production update feed will be enabled with public releases')
    if (!this.options.packaged) return this.setStatus('current', 'Update checks are available in installed builds')

    const marker = await readMarker(this.marker)
    if (marker === 'corrupt') return this.setStatus('failed', 'Update retry state is invalid; installation is blocked')

    const pending = marker.pending
    if (pending?.version === this.options.currentVersion) {
      await this.writeMarker({ version: MARKER_VERSION })
    }

    return this.downloadStartupUpdate(pending)
  }

  private async downloadStartupUpdate(previous: AttemptMarker['pending']): Promise<ShellUpdateStatus> {
    this.setStatus('checking', 'Checking for a Dinkster Desktop update')
    let result: { readonly updateInfo?: { readonly version: string } } | null
    try {
      result = await this.options.target.checkForUpdates()
    } catch {
      return this.setStatus('failed', 'Unable to check for a Dinkster Desktop update')
    }
    const version = result?.updateInfo?.version
    if (!version || version === this.options.currentVersion) return this.setStatus('current', 'Dinkster Desktop is up to date')
    if (previous?.version === version && previous.attempts >= MAX_INSTALL_ATTEMPTS) {
      return this.setStatus('failed', `Dinkster Desktop ${version} failed to install three times`)
    }
    try {
      const installers = await this.options.target.downloadUpdate()
      await this.retainInstallers(version, installers)
      if (previous?.version === version) {
        const next = { version, attempts: previous.attempts + 1 }
        await this.writeMarker({ version: MARKER_VERSION, pending: next })
        this.setStatus('installing', `Installing Dinkster Desktop ${version} on this startup`)
        this.options.target.quitAndInstall(false, true)
        return this.status
      }
      await this.writeMarker({ version: MARKER_VERSION, pending: { version, attempts: 0 } })
      return this.setStatus('ready', `Dinkster Desktop ${version} is ready to install on the next startup`)
    } catch {
      return this.setStatus('failed', 'Unable to download a Dinkster Desktop update')
    }
  }

  private async writeMarker(marker: AttemptMarker): Promise<void> {
    await writeFileAtomic(this.marker, `${JSON.stringify(marker)}\n`)
  }

  private async retainInstallers(version: string, installers: readonly string[]): Promise<void> {
    const directory = join(this.options.dataDirectory, 'updates', 'installers', version)
    await mkdir(directory, { recursive: true })
    await Promise.all(installers.map((installer) => copyFile(installer, join(directory, basename(installer)))))
  }

  private setStatus(state: ShellUpdateStatus['state'], detail: string): ShellUpdateStatus {
    this.statusValue = { state, detail }
    return this.status
  }
}
