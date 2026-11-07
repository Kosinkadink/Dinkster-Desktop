import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import extract from 'extract-zip'
import { download, verifyFile } from './io.js'

/** Inputs identify a verified independently published tools release. */
export interface EnvironmentToolsInput {
  readonly label?: string
  readonly manifest: string
  readonly sha256: string
  readonly release: string
  readonly cacheRoot?: string
}

function source(location: string): URL | string {
  if (isAbsolute(location)) return location
  const url = new URL(location)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('tools inputs require an absolute path or credential-free HTTPS')
  return url
}

async function acquire(location: string, target: string, maximumBytes: number): Promise<void> {
  const input = source(location)
  if (typeof input === 'string') {
    if ((await stat(input)).size > maximumBytes) throw new Error('tools input exceeds the declared size')
    await copyFile(input, target)
  } else await download(input.href, target, undefined, maximumBytes)
}

type ToolsArtifact = { name: string; size: number; sha256: string }
type ToolsManifest = {
  format?: string
  repository?: string
  commit?: string
  version?: string
  builtAt?: string
  label?: string
  artifacts?: ToolsArtifact[]
}

function validArtifact(row: ToolsArtifact | undefined): row is ToolsArtifact {
  return !!row && typeof row.name === 'string' && Number.isSafeInteger(row.size) && row.size > 0 && /^[a-f0-9]{64}$/.test(row.sha256)
}

export function validateToolsManifest(manifest: ToolsManifest, manifestSha256: string, inputLabel: string | undefined): ToolsArtifact[] {
  if (!Array.isArray(manifest.artifacts)) throw new Error('unsupported tools manifest')
  if (manifest.format !== 'dinkster.tools/1'
    || manifest.repository !== 'Kosinkadink/Dinkster'
    || typeof manifest.commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.commit)
    || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/.test(manifest.version)
    || typeof manifest.builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|\+00:00)$/.test(manifest.builtAt) || Number.isNaN(Date.parse(manifest.builtAt))
    || typeof manifest.label !== 'string' || !/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9.+_-]+$/.test(manifest.label)
    || manifest.label !== `${new Date(manifest.builtAt).toISOString().slice(0, 10)}-${manifest.version.split('+')[0]}`
    || (inputLabel !== undefined && inputLabel !== `${manifest.label}-${manifestSha256.slice(0, 8)}`)) {
    throw new Error('invalid independent tools manifest identity')
  }
  const expected = ['dinkster-tools-linux-x86_64.zip', 'dinkster-tools-windows-x86_64.zip', 'dinkster-tools-macos-arm64.zip']
  if (manifest.artifacts.length !== expected.length || expected.some((name) => manifest.artifacts?.filter((row) => row.name === name).length !== 1)
    || manifest.artifacts.some((row) => !validArtifact(row))) throw new Error('invalid independent tools manifest artifacts')
  return manifest.artifacts
}

// Electron's user-data instance lock excludes other Desktop writers. Serialize
// requests within that instance as well, including failed acquisitions.
let cacheWriter: Promise<unknown> = Promise.resolve()

export function acquireEnvironmentTools(input: EnvironmentToolsInput): Promise<{ python: string; directory: string; persistent: boolean }> {
  if (!input.cacheRoot) return acquireTools(input)
  const pending = cacheWriter.then(() => acquireTools(input))
  cacheWriter = pending.catch(() => undefined)
  return pending
}

async function acquireTools(input: EnvironmentToolsInput): Promise<{ python: string; directory: string; persistent: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('tools require an immutable manifest SHA256')
  if (input.cacheRoot && !isAbsolute(input.cacheRoot)) throw new Error('tools cache must be absolute')
  if (input.cacheRoot) {
    await mkdir(input.cacheRoot, { recursive: true })
    if (!(await lstat(input.cacheRoot)).isDirectory()) throw new Error('tools cache must be a real directory')
  }
  const directory = await mkdtemp(join(input.cacheRoot ?? tmpdir(), 'dinkster-tools-'))
  try {
    const manifestPath = join(directory, 'tools-manifest.json')
    await acquire(input.manifest, manifestPath, 8 * 1024 * 1024)
    await verifyFile(manifestPath, input.sha256)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ToolsManifest
    const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
    const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch as 'x64' | 'arm64']
    if (!os || !arch) throw new Error('unsupported tools platform')
    const artifacts = validateToolsManifest(manifest, input.sha256, input.label)
    const name = `dinkster-tools-${os}-${arch}.zip`
    const rows = artifacts.filter((row) => row.name === name)
    const row = rows[0]
    if (rows.length !== 1 || !validArtifact(row)) throw new Error('tools manifest has no unique pinned native tools archive')
    const interpreter = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'
    const allocations: { name: string; sha256: string }[] = []
    let cached: string | undefined
    if (input.cacheRoot) {
      const entries = await readdir(input.cacheRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!/^(?:[a-f0-9]{64}|\d{4}-\d{2}-\d{2}-.+-(?:linux|windows|macos)-(?:x86_64|arm64)(?:--(?:[2-9]|[1-9]\d+))?)$/i.test(entry.name)) continue
        if (!entry.isDirectory()) throw new Error('tools allocation must be a real directory')
        const marker = join(input.cacheRoot, entry.name, 'complete')
        try {
          if (!(await lstat(marker)).isFile()) throw new Error('invalid tools identity metadata')
          const sha256 = await readFile(marker, 'utf8')
          if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid tools identity metadata')
          allocations.push({ name: entry.name, sha256 })
          if (sha256 === row.sha256) {
            if (cached) throw new Error('duplicate tools identity metadata')
            cached = join(input.cacheRoot, entry.name)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (cached) {
        try {
          const payload = join(cached, 'payload')
          if (!(await lstat(payload)).isDirectory() || !(await lstat(join(payload, 'python'))).isDirectory()
            || (process.platform !== 'win32' && !(await lstat(join(payload, 'python', 'bin'))).isDirectory())
            || !(await lstat(join(payload, interpreter))).isFile()) throw new Error('unsafe cached tools interpreter')
          console.info(`Reusing environment tools ${cached}`)
          await rm(directory, { recursive: true, force: true })
          return { python: join(payload, interpreter), directory: cached, persistent: true }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      } else {
        const label = `${manifest.label!.slice(0, 120)}-${os}-${arch}`
        const occupied = new Set(entries.map((entry) => entry.name.toLowerCase()))
        let name = label
        for (let suffix = 2; occupied.has(name.toLowerCase()); suffix++) name = `${label}--${suffix}`
        cached = join(input.cacheRoot, name)
      }
    }
    const release = source(input.release)
    const archive = join(directory, name)
    await acquire(typeof release === 'string' ? join(release, name) : new URL(name, `${release.href.replace(/\/$/, '')}/`).href, archive, row.size)
    if ((await stat(archive)).size !== row.size) throw new Error('tools archive size mismatch')
    await verifyFile(archive, row.sha256)
    const payload = join(directory, 'payload')
    await mkdir(payload)
    const entries = new Set<string>()
    await extract(archive, {
      dir: payload,
      onEntry(entry) {
        const name = entry.fileName
        const key = (process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name).replace(/\/$/, '')
        const type = (entry.externalFileAttributes >>> 16) & 0o170000
        if (!name.startsWith('python/') || name.includes('\\') || name.includes(':') || name.split('/').some((part) => part === '.' || part === '..')
          || (type !== 0 && type !== 0o100000 && type !== 0o040000) || entries.has(key)) throw new Error('unsafe tools ZIP entry')
        entries.add(key)
      },
    })
    const python = join(payload, interpreter)
    if (!(await stat(python)).isFile()) throw new Error('tools archive lacks its interpreter')
    if (cached && input.cacheRoot) {
      await writeFile(join(directory, 'complete'), row.sha256)
      // A checked tree is its own recovery record. Never rename an existing
      // interpreter; evicted identities retain their original folder reservation.
      if (allocations.some((entry) => join(input.cacheRoot!, entry.name) === cached)) {
        await rm(join(cached, 'payload'), { recursive: true, force: true })
        await rename(payload, join(cached, 'payload'))
        await rm(directory, { recursive: true, force: true })
      } else await rename(directory, cached)
      for (const entry of allocations) {
        const previous = join(input.cacheRoot, entry.name)
        if (previous === cached) continue
        await rm(join(previous, 'payload'), { recursive: true, force: true })
        for (const artifact of ['linux-x86_64', 'windows-x86_64', 'macos-arm64']) {
          await rm(join(previous, `dinkster-tools-${artifact}.zip`), { force: true })
        }
      }
      console.info(`Extracted environment tools ${cached}`)
      return { python: join(cached, 'payload', interpreter), directory: cached, persistent: true }
    }
    return { python, directory, persistent: false }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
