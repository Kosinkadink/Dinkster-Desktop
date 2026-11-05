import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import extract from 'extract-zip'
import { download, verifyFile } from './io.js'

/** Inputs identify a verified engine or independently published tools release. */
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
  if (manifest.format === 'dinkster.engine/1' && inputLabel === undefined) return manifest.artifacts
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

export async function acquireEnvironmentTools(input: EnvironmentToolsInput): Promise<{ python: string; directory: string; persistent: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('tools require an immutable manifest SHA256')
  if (input.cacheRoot && !isAbsolute(input.cacheRoot)) throw new Error('tools cache must be absolute')
  if (input.cacheRoot) await mkdir(input.cacheRoot, { recursive: true })
  const directory = await mkdtemp(join(input.cacheRoot ?? tmpdir(), 'dinkster-tools-'))
  try {
    const manifestPath = join(directory, 'engine.json')
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
    const cached = input.cacheRoot ? join(input.cacheRoot, row.sha256) : undefined
    if (cached) {
      try {
        if (await readFile(join(cached, 'complete'), 'utf8') === row.sha256 && (await stat(join(cached, 'payload', interpreter))).isFile()) {
          console.info(`Reusing environment tools ${row.sha256}`)
          await rm(directory, { recursive: true, force: true })
          return { python: join(cached, 'payload', interpreter), directory: cached, persistent: true }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
      // Publish only a fully checked extraction; failed replacements leave the old tree intact.
      await rm(cached, { recursive: true, force: true })
      await rename(directory, cached)
      for (const entry of await readdir(input.cacheRoot)) {
        if (/^[a-f0-9]{64}$/.test(entry) && entry !== row.sha256) await rm(join(input.cacheRoot, entry), { recursive: true, force: true })
      }
      console.info(`Extracted environment tools ${row.sha256}`)
      return { python: join(cached, 'payload', interpreter), directory: cached, persistent: true }
    }
    return { python, directory, persistent: false }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
