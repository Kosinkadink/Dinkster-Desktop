import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import extract from 'extract-zip'
import { download, verifyFile } from './io.js'

/** Inputs identify the publisher's existing engine manifest and release directory. */
export interface EnvironmentToolsInput {
  readonly manifest: string
  readonly sha256: string
  readonly release: string
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

export async function acquireEnvironmentTools(input: EnvironmentToolsInput): Promise<{ python: string; directory: string }> {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('tools require an immutable engine manifest SHA256')
  const directory = await mkdtemp(join(tmpdir(), 'dinkster-tools-'))
  try {
    const manifestPath = join(directory, 'engine.json')
    await acquire(input.manifest, manifestPath, 8 * 1024 * 1024)
    await verifyFile(manifestPath, input.sha256)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { format?: string; artifacts?: { name: string; size: number; sha256: string }[] }
    const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
    const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch as 'x64' | 'arm64']
    if (!os || !arch || manifest.format !== 'dinkster.engine/1' || !Array.isArray(manifest.artifacts)) throw new Error('unsupported tools engine manifest or platform')
    const name = `dinkster-tools-${os}-${arch}.zip`
    const rows = manifest.artifacts.filter((row) => row.name === name)
    const row = rows[0]
    if (rows.length !== 1 || !row || !Number.isSafeInteger(row.size) || row.size <= 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('engine manifest has no unique pinned native tools archive')
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
        const key = name.replace(/\/$/, '').toLowerCase()
        const type = (entry.externalFileAttributes >>> 16) & 0o170000
        if (!name.startsWith('python/') || name.includes('\\') || name.includes(':') || name.split('/').some((part) => part === '.' || part === '..')
          || (type !== 0 && type !== 0o100000 && type !== 0o040000) || entries.has(key)) throw new Error('unsafe tools ZIP entry')
        entries.add(key)
      },
    })
    const python = join(payload, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3')
    if (!(await stat(python)).isFile()) throw new Error('tools archive lacks its interpreter')
    return { python, directory }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
