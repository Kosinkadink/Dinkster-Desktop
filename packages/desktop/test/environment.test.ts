import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentClient, type EnvironmentOperation, type EnvironmentRequest } from '../src/environment.js'
import { channelTools } from '../src/environment-channel.js'
import { acquireEnvironmentTools } from '../src/environment-tools.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function nativeToolsName(): string {
  const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
  return `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
}

function toolsArtifacts(row: { name: string; size: number; sha256: string }): typeof row[] {
  return ['linux-x86_64', 'windows-x86_64', 'macos-arm64'].map((platform) => ({ ...row, name: `dinkster-tools-${platform}.zip` }))
}

function independentManifest(artifacts: { name: string; size: number; sha256: string }[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'dinkster.tools/1',
    repository: 'Kosinkadink/Dinkster',
    commit: 'a'.repeat(40),
    version: '1.2.3',
    builtAt: '2026-11-05T18:36:00Z',
    label: '2026-11-05-1.2.3',
    artifacts,
    ...overrides,
  })
}

async function commandFixture(): Promise<{ root: string; client: EnvironmentClient }> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-env-'))
  roots.push(root)
  const script = join(root, 'command.cjs')
  await writeFile(script, `
    const fs = require('node:fs'); const path = require('node:path');
    const args = process.argv.slice(2);
    const root = args[args.indexOf('--root') + 1]; const operation = args[args.indexOf('--root') + 2];
    fs.writeFileSync(path.join(root, 'arguments.json'), JSON.stringify(args));
    const error = args.includes('--repair') ? 'generation drift needs offline repair' : undefined;
    console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,
      status:error ? 'error' : args.includes('--plan') ? 'planned' : operation === 'doctor' ? 'clean' : 'applied',
      root, current: 2, plan: ['reuse the shared wheel store'],
      url: operation === 'update' ? 'http://127.0.0.1:44002' : 'http://127.0.0.1:44001',
      engines: [{name:'main',generation:2,state:operation === 'stop' ? 'stopped' : 'ready',
        url:operation === 'update' ? 'http://127.0.0.1:44002' : 'http://127.0.0.1:44001'}], ...(error ? {error} : {})}));
    if (error) process.exitCode = 1;
  `)
  return { root, client: new EnvironmentClient(process.execPath, [script]) }
}

describe('Desktop dinkster-env command client', () => {
  it('refuses a channel above the running Desktop before invoking any command, without gating offline operations', async () => {
    const { root } = await commandFixture()
    const script = join(root, 'command.cjs')
    const client = new EnvironmentClient(process.execPath, [script], undefined, undefined, '0.2.0')
    await mkdir(join(root, 'channels'))
    const channel = join(root, 'channels', 'main.json')
    await writeFile(join(root, 'project.json'), JSON.stringify({ channel: 'main', mirrors: [root] }))
    await writeFile(channel, JSON.stringify({ format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.1', signature: null }))
    for (const operation of ['setup', 'update', 'catalog'] as const) {
      await expect(client.run({ root, operation })).rejects.toThrow('DesktopVersionTooOld: channel requires Desktop 0.2.1')
      await expect(stat(join(root, 'arguments.json'))).rejects.toThrow()
    }
    await rm(channel)
    for (const operation of ['start', 'status', 'doctor', 'stop'] as const) {
      expect((await client.run({ root, operation }, true)).operation).toBe(operation)
    }
    for (const minimumDesktopVersion of ['0.2.0', '0.1.99']) {
      await writeFile(channel, JSON.stringify({ format: 'dinkster.channel/1', minimumDesktopVersion }))
      expect((await client.run({ root, operation: 'update' })).status).toBe('planned')
    }
    await client.dispose()
  })

  it.each(['DINKSTER_TOOLS_SHA256', 'DINKSTER_TOOLS_MANIFEST_SHA256'])('honors %s and command overrides instead of opening the packaged payload', async (sha256Variable) => {
    const { root } = await commandFixture()
    const missingBundle = { manifest: join(root, 'missing-bundle'), sha256: 'b'.repeat(64), release: root }
    const manifest = join(root, 'override.json')
    await writeFile(manifest, '{}')
    vi.stubEnv('DINKSTER_TOOLS_MANIFEST', manifest)
    vi.stubEnv(sha256Variable, 'a'.repeat(64))
    vi.stubEnv('DINKSTER_TOOLS_RELEASE', root)
    const overridden = new EnvironmentClient(undefined, undefined, undefined, missingBundle)
    await expect(overridden.run({ root, operation: 'status' })).rejects.toThrow('checksum mismatch')
    await overridden.dispose()
    vi.stubEnv('DINKSTER_ENV', process.execPath)
    const command = new EnvironmentClient(undefined, [join(root, 'command.cjs')], undefined, missingBundle)
    expect((await command.run({ root, operation: 'status' })).current).toBe(2)
    await command.dispose()
  })

  it('selects a channel tools pin before the packaged payload for a supported channel', async () => {
    const { root } = await commandFixture()
    await mkdir(join(root, 'channels'))
    const manifest = join(root, 'newer-tools.json')
    await writeFile(manifest, '{}')
    await writeFile(join(root, 'channels', 'main.json'), JSON.stringify({
      format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0', signature: null,
      tools: { manifest, sha256: 'a'.repeat(64), release: root },
    }))
    const client = new EnvironmentClient(undefined, undefined, undefined,
      { manifest: join(root, 'bundle-must-not-open'), sha256: 'b'.repeat(64), release: root }, '0.2.0')
    // A checksum error from the channel's real file, not ENOENT from the bundle,
    // proves selection and that the channel pin still goes through verification.
    await expect(client.run({ root, operation: 'setup', channel: 'main', mirrors: [root] })).rejects.toThrow('checksum mismatch')
    await expect(stat(join(root, 'arguments.json'))).rejects.toThrow()
    await client.dispose()
  })

  it('drains a running command before disposal and refuses commands after closing', async () => {
    const { root } = await commandFixture()
    let release!: ServerResponse
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const server = createServer((_request, response) => { release = response; entered() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('command fixture did not bind')
    const client = new EnvironmentClient(process.execPath, ['-e', `fetch('http://127.0.0.1:${address.port}').then(r=>r.text()).then(console.log)`, '--'])
    const pending = client.run({ root, operation: 'status' })
    try {
      await started
      let disposed = false
      const closing = client.dispose().then(() => { disposed = true })
      await setImmediate()
      expect(disposed).toBe(false)
      await expect(client.run({ root, operation: 'status' })).rejects.toThrow('client is closed')
      release.end(JSON.stringify({ format: 'dinkster.environment-result/1', operation: 'status', status: 'clean', root, current: null, plan: [] }))
      expect((await pending).status).toBe('clean')
      await closing
      expect(disposed).toBe(true)
    } finally {
      release?.end()
      await pending.catch(() => undefined)
      await client.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('extracts only the size/hash-pinned native tools row and retains executable permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'))
    roots.push(root)
    // Ordinary stored ZIP with python/bin/python3 and python/python.exe, both mode 0755.
    const archive = Buffer.from('UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAcHl0aG9uL2Jpbi9weXRob24zZml4dHVyZVBLAwQUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAHB5dGhvbi9weXRob24uZXhlZml4dHVyZVBLAQIUAxQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAAAAAAAAAAADtgQAAAABweXRob24vYmluL3B5dGhvbjNQSwECFAMUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAAAAAAAAAAAA7YE3AAAAcHl0aG9uL3B5dGhvbi5leGVQSwUGAAAAAAIAAgB/AAAAbQAAAAAA', 'base64')
    const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
    const name = `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
    const row = { name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
    await writeFile(join(root, name), archive)
    const manifest = join(root, 'tools-manifest.json')
    async function input(artifacts = [row], overrides = {}) {
      const bytes = independentManifest([...toolsArtifacts(row).filter((entry) => entry.name !== row.name), ...artifacts], overrides)
      await writeFile(manifest, bytes)
      return { manifest, sha256: createHash('sha256').update(bytes).digest('hex'), release: root }
    }
    const pin = await input()
    const tools = await acquireEnvironmentTools(pin)
    roots.push(tools.directory)
    expect(await readFile(tools.python, 'utf8')).toBe('fixture')
    if (process.platform !== 'win32') expect((await stat(tools.python)).mode & 0o777).toBe(0o755)
    const cacheRoot = join(root, 'desktop-cache')
    const cached = await acquireEnvironmentTools({ ...pin, cacheRoot })
    const label = `2026-11-05-1.2.3-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}`
    expect(cached.directory).toBe(join(cacheRoot, label))
    expect(await readFile(join(cached.directory, 'complete'), 'utf8')).toBe(row.sha256)
    expect(cached.persistent).toBe(true)
    const originalTime = (await stat(cached.python)).mtimeMs
    await rm(join(root, name))
    const reused = await acquireEnvironmentTools({ ...pin, cacheRoot })
    expect(reused).toEqual(cached)
    expect((await stat(reused.python)).mtimeMs).toBe(originalTime)
    const relabeled = await input([row], { builtAt: '2026-11-06T18:36:00Z', label: '2026-11-06-1.2.3' })
    expect(await acquireEnvironmentTools({ ...relabeled, cacheRoot })).toEqual(cached)
    // An existing digest-only extraction is reused in place, without its ZIP.
    const legacyRoot = join(root, 'legacy-cache')
    await mkdir(legacyRoot)
    const legacy = join(legacyRoot, row.sha256)
    await rename(cached.directory, legacy)
    expect((await acquireEnvironmentTools({ ...relabeled, cacheRoot: legacyRoot })).directory).toBe(legacy)
    await rename(legacy, cached.directory)
    // ZIP timestamp changes its digest without changing file bytes or CRCs.
    const replacement = Buffer.from(archive)
    replacement[10] = 1
    await writeFile(join(root, name), replacement)
    const replacementRow = { ...row, sha256: createHash('sha256').update(replacement).digest('hex') }
    const replacementPin = await input([replacementRow])
    await writeFile(join(root, name), archive)
    await expect(acquireEnvironmentTools({ ...replacementPin, cacheRoot })).rejects.toThrow('checksum mismatch')
    expect(await readFile(cached.python, 'utf8')).toBe('fixture')
    await expect(stat(join(cacheRoot, `${label}--2`))).rejects.toThrow()
    await writeFile(join(root, name), replacement)
    const [replaced, simultaneous] = await Promise.all([
      acquireEnvironmentTools({ ...replacementPin, cacheRoot }),
      acquireEnvironmentTools({ ...replacementPin, cacheRoot }),
    ])
    expect(simultaneous).toEqual(replaced)
    expect(replaced.directory).toBe(join(cacheRoot, `${label}--2`))
    expect(await readFile(replaced.python, 'utf8')).toBe('fixture')
    await expect(stat(cached.python)).rejects.toThrow()
    expect(await readFile(join(cached.directory, 'complete'), 'utf8')).toBe(row.sha256)
    // Restoring evicted content uses its first allocation, not the latest label.
    await writeFile(join(root, name), archive)
    expect((await acquireEnvironmentTools({ ...await input([row], { builtAt: '2026-11-07T18:36:00Z', label: '2026-11-07-1.2.3' }), cacheRoot })).directory).toBe(cached.directory)
    expect(await readFile(cached.python, 'utf8')).toBe('fixture')
    // Reservations at and beyond --10 must still resolve by full identity.
    await rename(cached.directory, join(cacheRoot, `${label.toUpperCase()}--10`))
    expect((await acquireEnvironmentTools({ ...await input(), cacheRoot })).directory).toBe(join(cacheRoot, `${label.toUpperCase()}--10`))
    await rename(join(cacheRoot, `${label.toUpperCase()}--10`), cached.directory)
    const blocked = join(cacheRoot, '2026-11-08-1.2.3-LINUX-x86_64')
    await symlink(root, blocked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(acquireEnvironmentTools({ ...await input(), cacheRoot })).rejects.toThrow('real directory')
    await rm(blocked)
    await writeFile(join(cached.directory, 'complete'), 'invalid')
    await expect(acquireEnvironmentTools({ ...await input(), cacheRoot })).rejects.toThrow('identity metadata')
    await writeFile(join(cached.directory, 'complete'), row.sha256)
    await input()
    await expect(acquireEnvironmentTools({ ...pin, sha256: 'a'.repeat(64) })).rejects.toThrow('checksum mismatch')
    await expect(acquireEnvironmentTools(await input([{ ...row, size: row.size + 1 }]))).rejects.toThrow('size mismatch')
    await expect(acquireEnvironmentTools(await input([{ ...row, sha256: 'b'.repeat(64) }]))).rejects.toThrow('checksum mismatch')
    await expect(acquireEnvironmentTools(await input([row, row]))).rejects.toThrow('manifest artifacts')
    expect(await readFile(tools.python, 'utf8')).toBe('fixture')
  })

  it('uses an independent channel tools manifest without an engine ZIP and refuses changed publication inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-independent-tools-'))
    roots.push(root)
    const archive = Buffer.from('UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAcHl0aG9uL2Jpbi9weXRob24zZml4dHVyZVBLAwQUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAHB5dGhvbi9weXRob24uZXhlZml4dHVyZVBLAQIUAxQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAAAAAAAAAAADtgQAAAABweXRob24vYmluL3B5dGhvbjNQSwECFAMUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAAAAAAAAAAAA7YE3AAAAcHl0aG9uL3B5dGhvbi5leGVQSwUGAAAAAAIAAgB/AAAAbQAAAAAA', 'base64')
    const row = { name: nativeToolsName(), size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
    const artifacts = [row, ...toolsArtifacts(row).filter((entry) => entry.name !== row.name)]
    const manifest = independentManifest(artifacts)
    const sha256 = createHash('sha256').update(manifest).digest('hex')
    const label = `2026-11-05-1.2.3-${sha256.slice(0, 8)}`
    const release = join(root, 'tools', label)
    await mkdir(join(root, 'channels'), { recursive: true })
    await mkdir(release, { recursive: true })
    await writeFile(join(release, 'tools-manifest.json'), manifest)
    await writeFile(join(release, row.name), archive)
    await writeFile(join(root, 'channels', 'main.json'), JSON.stringify({
      format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0', signature: null,
      tools: { label, manifest: join(release, 'tools-manifest.json'), sha256, release },
    }))

    const input = await channelTools({ root, operation: 'setup', channel: 'main', mirrors: [root] }, '0.2.0')
    expect(input).toEqual({ label, manifest: join(release, 'tools-manifest.json'), sha256, release })
    const tools = await acquireEnvironmentTools(input!)
    roots.push(tools.directory)
    expect(await readFile(tools.python, 'utf8')).toBe('fixture')

    await expect(acquireEnvironmentTools({ ...input!, sha256: 'b'.repeat(64) })).rejects.toThrow('checksum mismatch')
    const wrongSize = independentManifest([{ ...artifacts[0]!, size: row.size + 1 }, ...artifacts.slice(1)])
    const wrongSizeSha256 = createHash('sha256').update(wrongSize).digest('hex')
    await writeFile(join(release, 'tools-manifest.json'), wrongSize)
    await expect(acquireEnvironmentTools({ ...input!, label: `2026-11-05-1.2.3-${wrongSizeSha256.slice(0, 8)}`, sha256: wrongSizeSha256 })).rejects.toThrow('size mismatch')
    await writeFile(join(release, 'tools-manifest.json'), manifest)
    await expect(acquireEnvironmentTools({ ...input!, label: `2026-11-05-1.2.3-${'a'.repeat(8)}` })).rejects.toThrow('identity')
    for (const overrides of [
      { builtAt: '2026-11-04T18:36:00Z' },
      { version: 'not-a-version' },
      { format: 'dinkster.engine/1' },
    ]) {
      const invalid = independentManifest(artifacts, overrides)
      await writeFile(join(release, 'tools-manifest.json'), invalid)
      await expect(acquireEnvironmentTools({ ...input!, sha256: createHash('sha256').update(invalid).digest('hex') })).rejects.toThrow('identity')
      if (overrides.format === 'dinkster.engine/1') {
        await expect(acquireEnvironmentTools({ ...input!, label: undefined, sha256: createHash('sha256').update(invalid).digest('hex') })).rejects.toThrow('identity')
      }
    }
    const localVersion = independentManifest(artifacts, { version: '1.2.3+build5', builtAt: '2026-11-05T18:36:00+00:00' })
    const localSha256 = createHash('sha256').update(localVersion).digest('hex')
    await writeFile(join(release, 'tools-manifest.json'), localVersion)
    const localTools = await acquireEnvironmentTools({ ...input!, label: `2026-11-05-1.2.3-${localSha256.slice(0, 8)}`, sha256: localSha256 })
    roots.push(localTools.directory)
    expect(await readFile(localTools.python, 'utf8')).toBe('fixture')
    await writeFile(join(release, 'tools-manifest.json'), manifest)
    const wrongArchive = Buffer.from(archive)
    wrongArchive[10] = 1
    await writeFile(join(release, row.name), wrongArchive)
    await expect(acquireEnvironmentTools(input!)).rejects.toThrow('checksum mismatch')
  })

  it('extracts deflated interpreter streams larger than a stream buffer without truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'))
    roots.push(root)
    const bytes = Buffer.from('compressed interpreter\n'.repeat(16384))
    const compressed = deflateRawSync(bytes)
    const local: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const path of ['python/bin/python3', 'python/python.exe']) {
      const name = Buffer.from(path)
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(8, 8)
      header.writeUInt32LE(crc32(bytes), 14)
      header.writeUInt32LE(compressed.length, 18)
      header.writeUInt32LE(bytes.length, 22)
      header.writeUInt16LE(name.length, 26)
      local.push(header, name, compressed)
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50)
      record.writeUInt16LE(0x0314, 4)
      header.copy(record, 6, 4, 30)
      record.writeUInt32LE((0o100755 << 16) >>> 0, 38)
      record.writeUInt32LE(offset, 42)
      central.push(record, name)
      offset += header.length + name.length + compressed.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50)
    end.writeUInt16LE(2, 8)
    end.writeUInt16LE(2, 10)
    end.writeUInt32LE(Buffer.concat(central).length, 12)
    end.writeUInt32LE(offset, 16)
    const archive = Buffer.concat([...local, ...central, end])
    const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
    const name = `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
    await writeFile(join(root, name), archive)
    const manifest = join(root, 'tools-manifest.json')
    const document = independentManifest(toolsArtifacts({ name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }))
    await writeFile(manifest, document)
    const tools = await acquireEnvironmentTools({ manifest, sha256: createHash('sha256').update(document).digest('hex'), release: root })
    roots.push(tools.directory)
    expect(await readFile(tools.python)).toEqual(bytes)
  })

  it('refuses traversal and links in an otherwise correctly pinned tools ZIP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'))
    roots.push(root)
    const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as 'win32' | 'linux' | 'darwin']
    const name = `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
    for (const encoded of [
      'UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAATAAAAcHl0aG9uLy4uLy4uL2VzY2FwZWZpeHR1cmVQSwECFAMUAAAAAAAAACEA7kDlBQcAAAAHAAAAEwAAAAAAAAAAAAAApIEAAAAAcHl0aG9uLy4uLy4uL2VzY2FwZVBLBQYAAAAAAQABAEEAAAA4AAAAAAA=',
      'UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAALAAAAcHl0aG9uL2xpbmtmaXh0dXJlUEsBAhQDFAAAAAAAAAAhAO5A5QUHAAAABwAAAAsAAAAAAAAAAAAAAP+hAAAAAHB5dGhvbi9saW5rUEsFBgAAAAABAAEAOQAAADAAAAAAAA==',
    ]) {
      const archive = Buffer.from(encoded, 'base64')
      await writeFile(join(root, name), archive)
      const bytes = independentManifest(toolsArtifacts({ name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }))
      const manifest = join(root, 'tools-manifest.json')
      await writeFile(manifest, bytes)
      await expect(acquireEnvironmentTools({ manifest, sha256: createHash('sha256').update(bytes).digest('hex'), release: root })).rejects.toThrow(/invalid relative path|unsafe tools ZIP/)
    }
    await expect(stat(join(root, 'escape'))).rejects.toThrow()
  })

  it.each(['linux', 'win32', 'darwin'])('checks tools ZIP duplicates using %s path identity', async (platform) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-tools-'))
    roots.push(root)
    // Stored ZIP: both interpreter paths and the published 2621A/2621a terminfo pair.
    const pair = Buffer.from('UEsDBBQAAAAAAAAAIQC3JjKwCwAAAAsAAAASAAAAcHl0aG9uL2Jpbi9weXRob24zaW50ZXJwcmV0ZXJQSwMEFAAAAAAAAAAhALcmMrALAAAACwAAABEAAABweXRob24vcHl0aG9uLmV4ZWludGVycHJldGVyUEsDBBQAAAAAAAAAIQCc319uBQAAAAUAAAAdAAAAcHl0aG9uL3NoYXJlL3Rlcm1pbmZvLzIvMjYyMUF1cHBlclBLAwQUAAAAAAAAACEAI3uaDgUAAAAFAAAAHQAAAHB5dGhvbi9zaGFyZS90ZXJtaW5mby8yLzI2MjFhbG93ZXJQSwECFAMUAAAAAAAAACEAtyYysAsAAAALAAAAEgAAAAAAAAAAAAAA7YEAAAAAcHl0aG9uL2Jpbi9weXRob24zUEsBAhQDFAAAAAAAAAAhALcmMrALAAAACwAAABEAAAAAAAAAAAAAAO2BOwAAAHB5dGhvbi9weXRob24uZXhlUEsBAhQDFAAAAAAAAAAhAJzfX24FAAAABQAAAB0AAAAAAAAAAAAAAO2BdQAAAHB5dGhvbi9zaGFyZS90ZXJtaW5mby8yLzI2MjFBUEsBAhQDFAAAAAAAAAAhACN7mg4FAAAABQAAAB0AAAAAAAAAAAAAAO2BtQAAAHB5dGhvbi9zaGFyZS90ZXJtaW5mby8yLzI2MjFhUEsFBgAAAAAEAAQAFQEAAPUAAAAAAA==', 'base64')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
    Object.defineProperty(process, 'platform', { value: platform })
    Object.defineProperty(process, 'arch', { value: platform === 'darwin' ? 'arm64' : 'x64' })
    try {
      const os = { linux: 'linux', win32: 'windows', darwin: 'macos' }[platform]
      const name = `dinkster-tools-${os}-${process.arch === 'x64' ? 'x86_64' : 'arm64'}.zip`
      for (const exactDuplicate of [false, true]) {
        // Change both ZIP name records, leaving file contents and their CRCs intact.
        const archive = exactDuplicate ? Buffer.from(pair.toString('latin1').replaceAll('2621a', '2621A'), 'latin1') : pair
        await writeFile(join(root, name), archive)
        const bytes = independentManifest(toolsArtifacts({ name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }))
        const manifest = join(root, 'tools-manifest.json')
        await writeFile(manifest, bytes)
        const pending = acquireEnvironmentTools({ manifest, sha256: createHash('sha256').update(bytes).digest('hex'), release: root })
        if (platform === 'linux' && !exactDuplicate) {
          const tools = await pending
          roots.push(tools.directory)
          expect(await readFile(tools.python, 'utf8')).toBe('interpreter')
          if (descriptor.value === 'linux') {
            expect(await readFile(join(tools.directory, 'payload/python/share/terminfo/2/2621A'), 'utf8')).toBe('upper')
            expect(await readFile(join(tools.directory, 'payload/python/share/terminfo/2/2621a'), 'utf8')).toBe('lower')
          }
        } else await expect(pending).rejects.toThrow('unsafe tools ZIP entry')
      }
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
      Object.defineProperty(process, 'arch', archDescriptor)
    }
  })

  it('plans by default and passes explicit confirmation without changing artifact formats', async () => {
    const { root, client } = await commandFixture()
    const request = { root, operation: 'setup' as const, channel: 'main' as const, variant: 'win-nvidia-cu126', mirrors: [join(root, 'offline mirror'), 'https://releases.dinkster.org'], data: join(root, 'wheel store'), port: 44000, engine: 'compute', gpus: ['1'] }
    const plan = await client.run(request)
    expect(plan.status).toBe('planned')
    expect(plan.plan).toEqual(['reuse the shared wheel store'])
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'setup', '--channel', 'main', '--variant', 'win-nvidia-cu126',
      '--mirror', join(root, 'offline mirror'), '--mirror', 'https://releases.dinkster.org',
      '--data', join(root, 'wheel store'), '--port', '44000', '--engine', 'compute', '--gpu', '1', '--json', '--plan',
    ])
    const applied = await client.run(request, true)
    expect(applied.status).toBe('applied')
    expect(applied.url).toBe('http://127.0.0.1:44001')
    const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
    expect(args).toContain('--yes')
    expect(args).not.toContain('--plan')
  })

  it('delegates update, rollback and move, while doctor stays read-only', async () => {
    const { root, client } = await commandFixture()
    for (const operation of ['update', 'rollback', 'move', 'doctor'] as const) {
      const result = await client.run({ root, operation, ...(operation === 'move' ? { destination: join(root, 'moved project') } : {}) }, true)
      expect(result.operation).toBe(operation)
      expect(result.status).toBe(operation === 'doctor' ? 'clean' : 'applied')
      const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
      expect(args.includes('--yes')).toBe(operation !== 'doctor')
      if (operation === 'move') expect(args[3]).toBe(join(root, 'moved project'))
    }
    await expect(client.run({ root, operation: 'doctor', repair: true }, true)).rejects.toThrow('generation drift needs offline repair')
  })

  it('delegates cleanup preference and retry, preserving deferred status and warnings', async () => {
    const { root } = await commandFixture()
    const cleanup = {
      policy: { automatic: false, previousSuccessfulActivations: 1, minimumAgeSeconds: 0 },
      generations: [{ generation: 7, status: 'deferred', reasons: ['unreadable history'] }],
      quarantine: [{ journal: '600.json', stage: 'complete', generations: [2] }],
      warnings: ['generation 2 awaits deletion'],
      lastAttempt: { status: 'deferred', warnings: ['sharing violation'] },
    }
    const response = join(root, 'response.json')
    const script = join(root, 'cleanup.cjs')
    await writeFile(response, JSON.stringify(cleanup))
    await writeFile(script, `
      const fs=require('node:fs');const args=process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(join(root, 'arguments.json'))},JSON.stringify(args));
      const operation=args[2];const cleanup=JSON.parse(fs.readFileSync(${JSON.stringify(response)}));
      console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,root:${JSON.stringify(root)},current:3,plan:[],cleanup,
        status:operation==='status'?'clean':args.includes('--plan')?'planned':'deferred',
        ...(args.includes('--yes')?{cleanupAttempt:cleanup.lastAttempt}:{})}));
    `)
    const client = new EnvironmentClient(process.execPath, [script])
    for (const automaticCleanup of [undefined, false, true]) {
      const request = { root, operation: 'cleanup' as const, ...(automaticCleanup === undefined ? {} : { automaticCleanup }) }
      expect((await client.run(request)).cleanup).toEqual(cleanup)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
        '--root', root, 'cleanup', ...(automaticCleanup === undefined ? [] : ['--automatic', automaticCleanup ? 'on' : 'off']), '--json', '--plan',
      ])
    }
    for (const keepPreviousGenerations of [1, 2, 100]) {
      expect((await client.run({ root, operation: 'cleanup', keepPreviousGenerations })).cleanup).toEqual(cleanup)
      expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
        '--root', root, 'cleanup', '--keep-previous', String(keepPreviousGenerations), '--json', '--plan',
      ])
    }
    for (const keepPreviousGenerations of [0, -1, 101, 1.5, NaN, true, '2']) {
      await expect(client.run({ root, operation: 'cleanup', keepPreviousGenerations } as unknown as EnvironmentRequest)).rejects.toThrow('retained generation count')
    }
    await expect(client.run({ root, operation: 'status', keepPreviousGenerations: 2 })).rejects.toThrow('retained generation count')
    const retried = await client.run({ root, operation: 'cleanup' }, true)
    expect(retried.status).toBe('deferred')
    expect(retried.cleanupAttempt).toEqual(cleanup.lastAttempt)
    expect((await client.run({ root, operation: 'status' })).cleanup).toEqual(cleanup)
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'status', '--json'])
    await writeFile(response, JSON.stringify({ generations: [], quarantine: [], warnings: ['corrupt policy; cleanup deferred'] }))
    expect((await client.run({ root, operation: 'status' })).cleanup?.warnings).toEqual(['corrupt policy; cleanup deferred'])
    for (const malformed of [{ ...cleanup, policy: { ...cleanup.policy, automatic: 'false' } },
      ...[0, 101].map((previousSuccessfulActivations) => ({ ...cleanup, policy: { ...cleanup.policy, previousSuccessfulActivations } })),
      { ...cleanup, lastAttempt: { status: 'deferred', warnings: [false] } }]) {
      await writeFile(response, JSON.stringify(malformed))
      await expect(client.run({ root, operation: 'status' })).rejects.toThrow('cleanup response')
    }
    await expect(client.run({ root, operation: 'status', automaticCleanup: false })).rejects.toThrow('preference requires cleanup')
  })

  it('preserves validated user-defined base metadata and refuses malformed labels', async () => {
    const { root } = await commandFixture()
    const script = join(root, 'custom.cjs')
    const base = { variant: 'studio-cuda', origin: 'user-defined', torchVersion: '2.14.1+cu130', torchIndex: 'https://download.pytorch.org/whl/cu130' }
    const response = { format: 'dinkster.environment-result/1', operation: 'doctor', status: 'clean', root, current: 1, plan: [], base }
    const client = new EnvironmentClient(process.execPath, [script])
    await writeFile(script, `console.log(${JSON.stringify(JSON.stringify(response))});`)
    expect((await client.run({ root, operation: 'doctor' })).base).toEqual(base)
    const engine = { release: `sha256:${'b'.repeat(64)}`, version: '0.4.2', label: '2026-11-02-0.4.2' }
    for (const label of [null, '2026-11-01-py3.14.10-torch2.14.1-cu130-12345678']) {
      const labelled = { ...response, base: { ...base, label }, engine }
      await writeFile(script, `console.log(${JSON.stringify(JSON.stringify(labelled))});`)
      expect(await client.run({ root, operation: 'doctor' })).toEqual(labelled)
    }
    for (const invalid of [null, { ...base, origin: 'local' }, { ...base, origin: ['user-defined'] }, { ...base, torchVersion: 2.14 }, { ...base, torchIndex: [] }, { ...base, variant: undefined }, { ...base, label: 7 }, { ...base, label: '' }]) {
      await writeFile(script, `console.log(${JSON.stringify(JSON.stringify({ ...response, base: invalid }))});`)
      await expect(client.run({ root, operation: 'doctor' })).rejects.toThrow('unsupported dinkster-env base response')
    }
    for (const invalid of [null, { ...engine, release: 'sha256:bad' }, { ...engine, version: '' }, { ...engine, label: [] }, { ...engine, label: '' }]) {
      await writeFile(script, `console.log(${JSON.stringify(JSON.stringify({ ...response, engine: invalid }))});`)
      await expect(client.run({ root, operation: 'doctor' })).rejects.toThrow('unsupported dinkster-env engine response')
    }
  })

  it.each([
    { os: 'windows', arch: 'x86_64' },
    { os: 'linux', arch: 'x86_64' },
    { os: 'macos', arch: 'arm64' },
  ])('reads $os catalog discovery without confirmation and preserves producer manifests', async (platform) => {
    const { root } = await commandFixture()
    const base = `sha256:${'a'.repeat(64)}`
    const manifest = { format: 'dinkster.base/1', id: base, variant: 'custom-base', platform,
      nvidia: { minimumDriver: '580.10.1', minimumComputeCapability: '7.5', maximumExclusiveComputeCapability: null }, parts: [], python: '3.14.10' }
    const response = { format: 'dinkster.environment-result/1', operation: 'catalog', status: 'clean', root, current: null, plan: [], channel: 'main',
      channelManifest: { format: 'dinkster.channel/1', base: { 'custom-base': base } }, variants: [{ variant: 'custom-base', base, manifest, downloadBytes: 123456789 }] }
    const script = join(root, 'catalog.cjs')
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'catalog-args.json'))},JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(response))});`)
    const client = new EnvironmentClient(process.execPath, [script])
    expect(await client.run({ root, operation: 'catalog', channel: 'main', mirrors: [join(root, 'mirror')] }, true)).toEqual(response)
    expect(JSON.parse(await readFile(join(root, 'catalog-args.json'), 'utf8'))).toEqual(['--root', root, 'catalog', '--channel', 'main', '--mirror', join(root, 'mirror'), '--json'])
    for (const invalid of [
      { ...manifest, platform: undefined },
      { ...manifest, platform: { os: 'macos', arch: 'x86_64' } },
      { ...manifest, platform: { os: 'linux', arch: 'arm64' } },
      { ...manifest, nvidia: { ...manifest.nvidia, minimumDriver: 580 } },
      { ...manifest, nvidia: { ...manifest.nvidia, maximumExclusiveComputeCapability: '10.x' } },
      { ...manifest, id: `sha256:${'b'.repeat(64)}` },
    ]) {
      await writeFile(script, `console.log(${JSON.stringify(JSON.stringify({ ...response, variants: [{ ...response.variants[0], manifest: invalid }] }))});`)
      await expect(client.run({ root, operation: 'catalog' })).rejects.toThrow('unsupported dinkster-env catalog response')
    }
  })

  it('starts and stops named engines with scoped devices and consumes new supervisor URLs', async () => {
    const { root, client } = await commandFixture()
    const started = await client.run({ root, operation: 'start', engine: 'main', port: 44000, gpus: ['1', 'GPU-1234-abcd'] }, true)
    expect(started.engines).toEqual([{ name: 'main', generation: 2, state: 'ready', url: 'http://127.0.0.1:44001' }])
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'start', '--port', '44000', '--engine', 'main', '--gpu', '1', '--gpu', 'GPU-1234-abcd', '--json', '--yes',
    ])
    const updated = await client.run({ root, operation: 'update' }, true)
    expect(updated.url).toBe('http://127.0.0.1:44002')
    expect(updated.engines?.[0]?.url).toBe('http://127.0.0.1:44002')
    await client.run({ root, operation: 'status' })
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'status', '--json'])
    const stopped = await client.run({ root, operation: 'stop', engine: 'main' }, true)
    expect(stopped.engines?.[0]?.state).toBe('stopped')
    await expect(client.run({ root, operation: 'start', engine: '--other' }, true)).rejects.toThrow('invalid engine name')
    await expect(client.run({ root, operation: 'start', gpus: ['display adapter'] }, true)).rejects.toThrow('invalid GPU device')
  })

  it('rejects nonzero responses even when their status claims success, and surfaces drift details', async () => {
    const { root } = await commandFixture()
    for (const status of ['applied', 'drift']) {
      const client = new EnvironmentClient(process.execPath, ['-e', `console.log(JSON.stringify({
        format:'dinkster.environment-result/1',operation:'doctor',status:'${status}',
        root:${JSON.stringify(root)},current:2,plan:[],changes:['constraints.txt has drifted']
      }));process.exitCode=1;`, '--'])
      await expect(client.run({ root, operation: 'doctor' })).rejects.toThrow('constraints.txt has drifted')
    }
  })

  it('rejects unsafe requests and malformed responses instead of treating them as applied', async () => {
    const { root, client } = await commandFixture()
    await expect(client.run({ root: 'relative', operation: 'setup' })).rejects.toThrow('must be absolute')
    await expect(client.run({ root, operation: 'move' })).rejects.toThrow('absolute destination')
    await expect(client.run({ root, operation: 'setup', variant: '--cpu' })).rejects.toThrow('invalid environment variant')
    await expect(client.run({ root, operation: 'setup', port: 0 })).rejects.toThrow('invalid supervisor port')
    await expect(client.run({ root, operation: 'other' as EnvironmentOperation })).rejects.toThrow('unsupported')
    const malformed = new EnvironmentClient(process.execPath, ['-e', 'console.log(JSON.stringify({format:"other"}));', '--'])
    await expect(malformed.run({ root, operation: 'doctor' })).rejects.toThrow('unsupported dinkster-env response')
    await expect(new EnvironmentClient(join(root, 'absent-command')).run({ root, operation: 'doctor' })).rejects.toThrow('not installed')
  })
})
