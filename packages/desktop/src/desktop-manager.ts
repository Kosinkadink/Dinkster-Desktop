import { open, readdir, readFile, rename, rm, stat, statfs, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ENGINE_RELEASE } from './release.js'
import {
  decodeEngineAccelerator,
  persistedEngineAccelerator,
  type EngineAccelerator,
} from './accelerator.js'

export type EngineVariant = EngineAccelerator

export interface EngineSelection {
  readonly commit: string
  readonly variant: EngineVariant
  readonly followPackaged?: boolean
}

export interface InstalledEngineRelease extends EngineSelection {
  readonly bytes: number
  readonly active: boolean
}

export interface EngineOperation {
  readonly id: string
  readonly kind: 'environment-change' | 'packaged-update' | 'snapshot-restore'
  readonly previous: EngineSelection
  readonly target: EngineSelection
  readonly startedAt: string
}

export interface InstallSnapshot {
  readonly format: 1
  readonly createdAt: string
  readonly reason: 'manual' | 'pre-update' | 'post-update'
  readonly selection: EngineSelection
  readonly dependencies: readonly { readonly name: string; readonly version: string }[]
}

export interface SystemCheck {
  readonly platform: string
  readonly architecture: string
  readonly freeBytes: number
  readonly totalBytes: number
  readonly engineReady: boolean
  readonly engineDetail: string
  readonly gpu: { readonly available: boolean; readonly name?: string; readonly driver?: string; readonly memoryMiB?: number }
}

const selectionFile = (dataDirectory: string): string => join(dataDirectory, 'engine', 'selection.json')
const operationFile = (dataDirectory: string): string => join(dataDirectory, 'engine', 'operation.json')

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function readStoredEngineSelection(
  dataDirectory: string,
  diagnostic?: (message: string) => void,
): Promise<EngineSelection | undefined> {
  try {
    const value = JSON.parse(await readFile(selectionFile(dataDirectory), 'utf8')) as Partial<EngineSelection>
    if (typeof value.commit === 'string') {
      return {
        commit: value.commit,
        variant: persistedEngineAccelerator(value.variant, diagnostic),
        ...(value.followPackaged === true ? { followPackaged: true } : {}),
      }
    }
  } catch {
    // Missing or invalid preferences use the release packaged with the shell.
  }
  return undefined
}

export async function readEngineSelection(dataDirectory: string, fallbackVariant: EngineVariant): Promise<EngineSelection> {
  return await readStoredEngineSelection(dataDirectory) ?? { commit: ENGINE_RELEASE.commit, variant: fallbackVariant }
}

export async function writeEngineSelection(dataDirectory: string, selection: EngineSelection): Promise<void> {
  await writeJsonAtomic(selectionFile(dataDirectory), selection)
}

export async function readEngineOperation(
  dataDirectory: string,
  diagnostic?: (message: string) => void,
): Promise<EngineOperation | undefined> {
  try {
    const value = JSON.parse(await readFile(operationFile(dataDirectory), 'utf8')) as Partial<EngineOperation>
    if (typeof value.id === 'string' && typeof value.startedAt === 'string' &&
      (value.kind === 'environment-change' || value.kind === 'packaged-update' || value.kind === 'snapshot-restore') &&
      value.previous && value.target && typeof value.previous.commit === 'string' && typeof value.target.commit === 'string') {
      return {
        id: value.id,
        kind: value.kind,
        startedAt: value.startedAt,
        previous: {
          commit: value.previous.commit,
          variant: persistedEngineAccelerator(value.previous.variant, diagnostic),
          ...(value.previous.followPackaged === true ? { followPackaged: true } : {}),
        },
        target: {
          commit: value.target.commit,
          variant: persistedEngineAccelerator(value.target.variant, diagnostic),
          ...(value.target.followPackaged === true ? { followPackaged: true } : {}),
        },
      }
    }
  } catch {
    // Missing or invalid journals cannot supersede the last committed selection.
  }
  return undefined
}

export async function writeEngineOperation(dataDirectory: string, operation: EngineOperation): Promise<void> {
  await writeJsonAtomic(operationFile(dataDirectory), operation)
}

export async function clearEngineOperation(dataDirectory: string): Promise<void> {
  await rm(operationFile(dataDirectory), { force: true })
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

export async function listEngineReleases(dataDirectory: string, active: EngineSelection): Promise<readonly InstalledEngineRelease[]> {
  const root = join(dataDirectory, 'engine', 'releases')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const releases: InstalledEngineRelease[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith('.installing')) continue
    const path = join(root, entry.name)
    try {
      const marker = JSON.parse(await readFile(join(path, '.dinkster-desktop-release.json'), 'utf8')) as Partial<EngineSelection>
      const variant = decodeEngineAccelerator(marker.variant)
      if (typeof marker.commit !== 'string' || variant === undefined) continue
      releases.push({
        commit: marker.commit,
        variant,
        bytes: await directoryBytes(path),
        active: marker.commit === active.commit && variant === active.variant,
      })
    } catch {
      // Incomplete directories are not selectable releases.
    }
  }
  return releases.sort((left, right) => Number(right.active) - Number(left.active) || left.commit.localeCompare(right.commit))
}

export async function desktopStorageBytes(dataDirectory: string): Promise<number> {
  try {
    return await directoryBytes(dataDirectory)
  } catch {
    return 0
  }
}

async function releaseDirectory(dataDirectory: string, selection: EngineSelection): Promise<string | undefined> {
  const releases = join(dataDirectory, 'engine', 'releases')
  let entries
  try { entries = await readdir(releases, { withFileTypes: true }) } catch { return undefined }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(releases, entry.name)
    try {
      const marker = JSON.parse(await readFile(join(path, '.dinkster-desktop-release.json'), 'utf8')) as Partial<EngineSelection>
      if (marker.commit === selection.commit && decodeEngineAccelerator(marker.variant) === selection.variant) return path
    } catch { /* Ignore incomplete releases. */ }
  }
  return undefined
}

async function installedDependencies(root: string | undefined): Promise<readonly { name: string; version: string }[]> {
  if (!root) return []
  const sitePackages = process.platform === 'win32'
    ? join(root, '.venv', 'Lib', 'site-packages')
    : join(root, '.venv', 'lib')
  const metadata: string[] = []
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth < 0) return
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isFile() && entry.name === 'METADATA' && path.endsWith('.dist-info')) metadata.push(child)
      else if (entry.isDirectory()) await visit(child, depth - 1)
    }
  }
  await visit(sitePackages, process.platform === 'win32' ? 1 : 3)
  const dependencies: { name: string; version: string }[] = []
  for (const path of metadata) {
    const text = await readFile(path, 'utf8')
    const name = /^Name:\s*(.+)$/mi.exec(text)?.[1]?.trim()
    const version = /^Version:\s*(.+)$/mi.exec(text)?.[1]?.trim()
    if (name && version) dependencies.push({ name, version })
  }
  return dependencies.sort((left, right) => left.name.localeCompare(right.name))
}

export async function createInstallSnapshot(
  dataDirectory: string,
  selection: EngineSelection,
  reason: InstallSnapshot['reason'],
): Promise<InstallSnapshot> {
  const snapshot: InstallSnapshot = {
    format: 1,
    createdAt: new Date().toISOString(),
    reason,
    selection,
    dependencies: await installedDependencies(await releaseDirectory(dataDirectory, selection)),
  }
  const name = `${snapshot.createdAt.replace(/[:.]/g, '-')}-${reason}.json`
  await writeJsonAtomic(join(dataDirectory, 'engine', 'snapshots', name), snapshot)
  return snapshot
}

export function parseInstallSnapshot(value: unknown): InstallSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('snapshot must be an object')
  const row = value as Record<string, unknown>
  const selection = row['selection'] as Record<string, unknown> | undefined
  const dependencies = row['dependencies']
  const variant = decodeEngineAccelerator(selection?.['variant'])
  if (row['format'] !== 1 || typeof row['createdAt'] !== 'string' ||
    (row['reason'] !== 'manual' && row['reason'] !== 'pre-update' && row['reason'] !== 'post-update') ||
    !selection || typeof selection['commit'] !== 'string' ||
    variant === undefined || !Array.isArray(dependencies) ||
    !dependencies.every((entry) => typeof entry === 'object' && entry !== null &&
      typeof (entry as Record<string, unknown>)['name'] === 'string' && typeof (entry as Record<string, unknown>)['version'] === 'string')) {
    throw new Error('snapshot has an unsupported or malformed install-state format')
  }
  return {
    ...(value as InstallSnapshot),
    selection: {
      commit: selection['commit'],
      variant,
      ...(selection['followPackaged'] === true ? { followPackaged: true } : {}),
    },
  }
}

export async function readInstallSnapshot(path: string): Promise<InstallSnapshot> {
  return parseInstallSnapshot(JSON.parse(await readFile(path, 'utf8')))
}

export async function writeInstallSnapshot(path: string, snapshot: InstallSnapshot): Promise<void> {
  await writeJsonAtomic(path, snapshot)
}

export async function systemCheck(
  dataDirectory: string,
  selection: EngineSelection,
  gpu: SystemCheck['gpu'],
): Promise<SystemCheck> {
  await mkdir(dataDirectory, { recursive: true })
  const disk = await statfs(dataDirectory, { bigint: true })
  const root = await releaseDirectory(dataDirectory, selection)
  const bin = root ? process.platform === 'win32' ? join(root, '.venv', 'Scripts') : join(root, '.venv', 'bin') : undefined
  const required = bin ? [
    join(bin, process.platform === 'win32' ? 'dinkster-supervisor.exe' : 'dinkster-supervisor'),
    join(bin, process.platform === 'win32' ? 'dinkster-serve.exe' : 'dinkster-serve'),
  ] : []
  const executableChecks = await Promise.all(required.map(async (path) => {
    try { return (await stat(path)).isFile() } catch { return false }
  }))
  const engineReady = root !== undefined && executableChecks.every(Boolean)
  return {
    platform: process.platform,
    architecture: process.arch,
    freeBytes: Number(disk.bavail * disk.bsize),
    totalBytes: Number(disk.blocks * disk.bsize),
    engineReady,
    engineDetail: engineReady
      ? `Locked ${selection.variant} environment executables are installed`
      : root ? 'Selected environment is incomplete' : 'Selected environment is not installed',
    gpu,
  }
}

export function redactDiagnosticText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:token|password|passwd|secret|api[_-]?key|access[_-]?token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:--)?(?:token|password|passwd|secret|api[_-]?key)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:token|password|secret|apiKey|accessToken)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
}
