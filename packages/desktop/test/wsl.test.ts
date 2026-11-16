import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { revealModelLocation } from '../src/local-files.js'
import { WslHost, wslLinuxPath, wslLocation, wslWindowsPath } from '../src/wsl.js'
import { EnvironmentClient } from '../src/environment.js'
import type { EnvironmentToolsInput } from '../src/environment-tools.js'

const trustedChannelKeys = vi.hoisted(() => ({} as Record<string, string>))
vi.mock('../src/channel-signatures.js', async (original) => {
  const actual = await original<typeof import('../src/channel-signatures.js')>()
  return { ...actual, verifyChannel: (text: string, channel: string) => actual.verifyChannel(text, channel, trustedChannelKeys) }
})

vi.mock('node:path', async (original) => {
  const module = await original<typeof import('node:path')>()
  return { ...module, isAbsolute: (path: string) => module.win32.isAbsolute(path) || module.posix.isAbsolute(path),
    join: (...parts: string[]) => parts[0]?.startsWith('\\\\') ? module.win32.join(...parts) : module.join(...parts) }
})

const filesystemPaths = vi.hoisted(() => new Map<string, string>())
const guestDisk = vi.hoisted(() => ({ prefix: '', root: '', map(path: unknown): unknown {
  // The guest probe sees distinct names even when the fixture disk is on NTFS.
  return typeof path === 'string' && this.prefix && path.startsWith(this.prefix)
    ? this.root + path.slice(this.prefix.length).replaceAll('\\', '/').replace(/\/case-check\/UPPER$/, '/case-check/upper-distinct') : path
} }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const mapped = Object.fromEntries(['copyFile', 'lstat', 'mkdir', 'mkdtemp', 'readFile', 'readdir', 'rename', 'rm', 'stat', 'writeFile']
    .map((name) => [name, (...args: unknown[]) => Reflect.apply(actual[name as keyof typeof actual] as Function, actual, args.map((arg) => guestDisk.map(arg)))]))
  return { ...actual, ...mapped,
    mkdtemp: async (path: string) => {
      const local = await actual.mkdtemp(guestDisk.map(path) as string)
      return path.startsWith('\\\\') ? guestDisk.prefix + local.slice(guestDisk.root.length).replaceAll('/', '\\') : local
    },
    realpath: (path: string) => actual.realpath(filesystemPaths.get(path) ?? path) }
})
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, createReadStream: (path: string) => actual.createReadStream(guestDisk.map(path) as string) }
})
vi.mock('extract-zip', async (original) => {
  const actual = await original<{ default: typeof import('extract-zip') }>()
  return { default: (path: string, options: Parameters<typeof actual.default>[1]) => actual.default(guestDisk.map(path) as string,
    { ...options, dir: guestDisk.map(options.dir) as string }) }
})

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...module, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', architecture)
  execute.mockReset()
  filesystemPaths.clear()
  guestDisk.prefix = ''
  guestDisk.root = ''
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const distribution = 'Dinkster-Desktop-012345abcdef'

describe('private WSL readiness', () => {
  const tools = { manifest: 'https://example.invalid/tools.json', sha256: 'a'.repeat(64), release: 'https://example.invalid/release' }

  function host(): WslHost {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    return new WslHost('C:\\Desktop data', tools)
  }

  it('keeps fallback and selected tools interpreters usable across overlapping operations', async () => {
    host()
    const root = await mkdtemp(join(tmpdir(), 'dinkster-wsl-tools-'))
    const archive = Buffer.from('UEsDBBQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAcHl0aG9uL2Jpbi9weXRob24zZml4dHVyZVBLAwQUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAHB5dGhvbi9weXRob24uZXhlZml4dHVyZVBLAQIUAxQAAAAAAAAAIQDuQOUFBwAAAAcAAAASAAAAAAAAAAAAAADtgQAAAABweXRob24vYmluL3B5dGhvbjNQSwECFAMUAAAAAAAAACEA7kDlBQcAAAAHAAAAEQAAAAAAAAAAAAAA7YE3AAAAcHl0aG9uL3B5dGhvbi5leGVQSwUGAAAAAAIAAgB/AAAAbQAAAAAA', 'base64')
    const pins: EnvironmentToolsInput[] = []
    for (const [index, version] of ['1.2.3', '1.2.4'].entries()) {
      const release = join(root, version)
      await mkdir(release)
      const bytes = Buffer.from(archive)
      const marker = Buffer.from(index === 0 ? 'fallbak' : 'selectd')
      for (let offset = 0; offset < bytes.length - 4; offset++) {
        if (bytes.readUInt32LE(offset) === 0x04034b50) bytes.writeUInt32LE(crc32(marker), offset + 14)
        if (bytes.readUInt32LE(offset) === 0x02014b50) bytes.writeUInt32LE(crc32(marker), offset + 16)
        if (bytes.subarray(offset, offset + 7).toString() === 'fixture') marker.copy(bytes, offset)
      }
      const artifacts = ['linux-x86_64', 'windows-x86_64', 'macos-arm64'].map((platform) => ({
        name: `dinkster-tools-${platform}.zip`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      }))
      await writeFile(join(release, artifacts[0]!.name), bytes)
      const manifest = JSON.stringify({ format: 'dinkster.tools/1', repository: 'Kosinkadink/Dinkster', commit: 'a'.repeat(40),
        version, builtAt: '2026-11-05T18:36:00Z', label: `2026-11-05-${version}`, artifacts })
      await writeFile(join(release, 'tools-manifest.json'), manifest)
      pins.push({ manifest: join(release, 'tools-manifest.json'), release, sha256: createHash('sha256').update(manifest).digest('hex') })
    }
    const service = new WslHost('C:\\Desktop data', pins[0]!)
    guestDisk.prefix = `\\\\wsl.localhost\\${service.distribution}`
    guestDisk.root = join(root, 'disk')
    let resume!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => { entered = resolve })
    const released = new Promise<void>((resolve) => { resume = resolve })
    execute.mockImplementation(async (file: string, args: string[]) => {
      expect(file).toBe('wsl.exe')
      const output = (text: string) => ({ stdout: Buffer.from(text) })
      if (args[0] === '--version') return output('WSL version')
      if (args[0] === '--help') return output('--name --location')
      if (args[0] === '--list') return output(service.distribution)
      if (args.includes('/etc/dinkster-desktop-owner')) return output(service.distribution)
      if (args.includes('/etc/wsl.conf')) return output('[automount]\nenabled=false\n[interop]\nenabled=false\nappendWindowsPath=false\n[user]\ndefault=dinkster')
      if (args.includes('uname')) return output('wsl2')
      if (args.includes('/usr/bin/bwrap') || args.includes('! mountpoint -q /mnt/c') || args.includes('dinkster-tools')) return output('')
      const python = args.find((arg) => arg.endsWith('/bin/python3'))
      if (!python) throw new Error('unexpected guest command')
      const interpreter = join(guestDisk.root, python)
      expect(await readFile(interpreter, 'utf8')).toBe(args.at(-1) === 'selected' ? 'selectd' : 'fallbak')
      if (args.at(-1) === 'hold') {
        entered()
        await released
        // A supervisor can need its interpreter again after another pin installs.
        expect(await readFile(interpreter, 'utf8')).toBe('fallbak')
      }
      return output('usable')
    })
    const active = service.run(['hold'])
    try {
      await Promise.race([paused, active])
      expect(await service.run(['selected'], pins[1]!)).toBe('usable')
      resume()
      expect(await active).toBe('usable')
      expect(await service.run(['fallback'])).toBe('usable')
    } finally {
      resume()
      try { await active } finally { await rm(root, { recursive: true, force: true }) }
    }
  })

  it.each([false, true])('ignores host tools overrides for WSL with channel selection %s', async (channelSelected) => {
    host()
    const channelTools = { manifest: 'https://channel.invalid/tools.json', sha256: 'b'.repeat(64), release: 'https://channel.invalid/release' }
    const override = { manifest: 'https://host.invalid/tools.json', sha256: 'c'.repeat(64), release: 'https://host.invalid/release' }
    for (const [key, value] of Object.entries({
      DINKSTER_TOOLS_MANIFEST: override.manifest,
      DINKSTER_TOOLS_MANIFEST_SHA256: override.sha256,
      DINKSTER_TOOLS_RELEASE: override.release,
    })) vi.stubEnv(key, value)
    vi.stubEnv('DINKSTER_ENV', undefined)
    vi.stubEnv('DINKSTER_TOOLS_PYTHON', undefined)

    const key = generateKeyPairSync('ed25519')
    const publicBytes = key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    const keyId = `sha256:${createHash('sha256').update(publicBytes).digest('hex')}`
    trustedChannelKeys[keyId] = publicBytes.toString('base64')
    const signed = JSON.stringify({ channel: 'nightly', format: 'dinkster.channel/1', minimumDesktopVersion: '0.2.0',
      tools: { manifest: channelTools.manifest, release: channelTools.release, sha256: channelTools.sha256 } })
    const envelope = JSON.stringify({ signatures: [{ keyId, signature: sign(null, Buffer.from(signed), key.privateKey).toString('base64') }], signed: JSON.parse(signed) })
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url) !== 'https://channel.invalid/channels/nightly.json') throw new Error('unexpected download')
      return new Response(envelope)
    })

    // Stand in for the guest process: its response identifies the complete tools
    // input it booted, while retaining the real client's selection and decoding.
    class Guest extends WslHost {
      override async run(args: readonly string[], input: EnvironmentToolsInput = tools): Promise<string> {
        return JSON.stringify({ format: 'dinkster.environment-result/1', operation: args[2],
          status: 'clean', root: args[1], current: null, plan: [], sourceDescription: JSON.stringify(input) })
      }
    }
    const guest = new Guest('C:\\Desktop data', tools)
    const client = new EnvironmentClient(undefined, undefined, undefined, undefined, '0.2.0', guest)
    const root = await mkdtemp(join(tmpdir(), 'dinkster-wsl-channel-'))
    guestDisk.prefix = `\\\\wsl.localhost\\${guest.distribution}`
    guestDisk.root = root
    try {
      await mkdir(guest.projectRoot('studio'), { recursive: true })
      await writeFile(join(guest.projectRoot('studio'), 'project.json'), '{}')
      const result = await client.run({ root: guest.projectRoot('studio'),
        operation: channelSelected ? 'update' : 'status',
        ...(channelSelected ? { channel: 'nightly' as const, mirrors: ['https://channel.invalid'] } : {}) })
      expect(JSON.parse(result.sourceDescription!)).toEqual(channelSelected ? channelTools : tools)
      expect(result.root).toBe(guest.projectRoot('studio'))
    } finally {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
      delete trustedChannelKeys[keyId]
    }
  })

  it('opens the registered WSL model folder through its private disk and rechecks revocation', async () => {
    const service = host()
    const root = await mkdtemp(join(tmpdir(), 'dinkster-wsl-model-location-'))
    const folder = join(root, 'copied models')
    await mkdir(folder)
    // Map only the expected Windows UNC lookup onto a real test directory.
    filesystemPaths.set(`\\\\wsl.localhost\\${service.distribution}\\home\\dinkster\\models\\copied`, folder)
    let revoke = false
    let requests = 0
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      locations: revoke && ++requests === 2 ? [] : [{ id: 'copied', path: '/home/dinkster/models/copied' }],
    })))
    const opened: string[] = []
    const shell = { openExternal: async (url: string) => { opened.push(url) } }
    try {
      await revealModelLocation('http://127.0.0.1:5011', 'copied', 'studio', shell, async () => {}, service.distribution)
      expect(opened).toEqual([pathToFileURL(await realpath(folder)).href])
      opened.length = 0
      revoke = true
      await expect(revealModelLocation('http://127.0.0.1:5011', 'copied', 'studio', shell, async () => {}, service.distribution)).rejects.toThrow('copy the server path')
      expect(opened).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports missing WSL without installing it or selecting a user distribution', async () => {
    const service = host()
    execute.mockRejectedValue(new Error('not installed'))
    expect(await service.status()).toMatchObject({ available: false, ready: false, detail: expect.stringContaining('wsl --install --no-distribution') })
    await expect(service.prepare()).rejects.toThrow('wsl --install --no-distribution')
    execute.mockResolvedValue({ stdout: Buffer.from('Ubuntu-24.04\r\n', 'utf16le') })
    expect(await service.status()).toMatchObject({ available: false, ready: false, detail: expect.stringContaining('wsl --update') })
  })

  it('requires supported help switches and keeps operational failures strict', async () => {
    const service = host()
    let help = '--name'
    execute.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: Buffer.from('WSL version') }
      if (args[0] === '--help') throw Object.assign(new Error('help exit'), { code: 4294967295, stdout: Buffer.from(help, 'utf16le') })
      throw Object.assign(new Error('list failed'), { code: 4294967295, stdout: Buffer.from('Ubuntu-24.04', 'utf16le') })
    })
    expect(await service.status()).toMatchObject({ available: false, ready: false, detail: expect.stringContaining('wsl --update') })
    help = '--name --location'
    await expect(service.status()).rejects.toThrow('list failed')
  })

  it('uses selected Linux readiness and sandbox start for a WSL project', async () => {
    const service = host()
    const sandbox = { format: 'dinkster.sandbox-readiness/1', available: false, detail: 'Linux user namespaces are disabled' }
    const run = vi.spyOn(service, 'run').mockImplementation(async (args) => JSON.stringify({
      format: 'dinkster.environment-result/1', operation: args[2], status: 'clean',
      root: '/home/dinkster/projects/studio', current: 2, plan: [],
      ...(args[2] === 'doctor' ? { sandbox } : { engines: [{ name: 'main', generation: 2, state: 'ready', sandboxPacks: true }] }),
    }))
    const client = new EnvironmentClient('dinkster-env', [], undefined, undefined, undefined, service)
    try {
      const root = service.projectRoot('studio')
      expect((await client.run({ root, operation: 'doctor', sandbox: true })).sandbox).toEqual(sandbox)
      expect(run.mock.calls[0]?.[0]).toEqual(['--root', '/home/dinkster/projects/studio', 'doctor', '--sandbox', '--json'])
      expect((await client.run({ root, operation: 'start', sandboxPacks: true }, true)).engines?.[0]?.sandboxPacks).toBe(true)
      expect(run.mock.calls[1]?.[0]).toEqual(['--root', '/home/dinkster/projects/studio', 'start', '--sandbox-packs', '--json', '--yes'])
    } finally {
      run.mockRestore()
      await client.dispose()
    }
  })

  it('accepts Windows WSL aliases but refuses a response for another Linux project', async () => {
    const service = host()
    let responseRoot = '/home/dinkster/projects/studio'
    const run = vi.spyOn(service, 'run').mockImplementation(async () => JSON.stringify({
      format: 'dinkster.environment-result/1', operation: 'status', status: 'clean',
      root: responseRoot, current: null, plan: [],
    }))
    const client = new EnvironmentClient('dinkster-env', [], undefined, undefined, undefined, service)
    try {
      const canonical = service.projectRoot('studio')
      const alias = canonical.replace('wsl.localhost', 'wsl$').replace(service.distribution, service.distribution.toUpperCase())
      expect((await client.run({ root: canonical, operation: 'status' })).root).toBe(canonical)
      expect((await client.run({ root: alias, operation: 'status' })).root).toBe(alias)
      responseRoot = '/home/dinkster/projects/Studio'
      await expect(client.run({ root: alias, operation: 'status' })).rejects.toThrow('different project root')
    } finally {
      run.mockRestore()
      await client.dispose()
    }
  })

  it('decodes UTF-16LE distro lists and refuses to adopt an unowned private name', async () => {
    const service = host()
    let owned = false
    execute.mockImplementation(async (file: string, args: string[]) => {
      if (file !== 'wsl.exe') throw new Error('not a WSL command')
      const output = (text: string) => ({ stdout: Buffer.from(text, 'utf16le') })
      if (args[0] === '--version') return output('WSL version: 2.6.3.0')
      if (args[0] === '--help') throw Object.assign(new Error('help exit'), { code: 4294967295, ...output('--name --location --no-launch --version') })
      if (args[0] === '--list') return output(`Ubuntu-24.04\r\n${service.distribution}\r\n`)
      if (args.includes('/etc/dinkster-desktop-owner')) return output(owned ? service.distribution : 'another-owner')
      if (args.includes('/etc/wsl.conf')) return output('[automount]\nenabled=false\n[interop]\nenabled=false\nappendWindowsPath=false\n[user]\ndefault=dinkster')
      if (args.includes('uname')) return output('6.6.87.2-microsoft-standard-WSL2')
      if (args.includes('/usr/bin/bwrap') || args.includes('! mountpoint -q /mnt/c')) return output('')
      throw new Error('attempted an unexpected mutation')
    })
    expect(await service.status()).toMatchObject({ available: true, ready: false, detail: expect.stringContaining('not owned') })
    await expect(service.prepare()).rejects.toThrow('not owned')
    owned = true
    expect(await service.status()).toMatchObject({ available: true, ready: true })
  })
})

describe('private WSL disk paths', () => {
  it('round trips Linux-disk project paths without treating a Windows drive as Linux storage', () => {
    const linux = '/home/dinkster/projects/studio one/models'
    const native = `\\\\wsl.localhost\\${distribution}\\home\\dinkster\\projects\\studio one\\models`
    expect(wslWindowsPath(distribution, linux)).toBe(native)
    expect(wslLocation(native)).toEqual({ distribution, path: linux })
    expect(wslLinuxPath(distribution, native)).toBe(linux)
    expect(wslLinuxPath(distribution, native.replace('wsl.localhost', 'wsl$'))).toBe(linux)
    expect(wslLocation('C:\\models')).toBeUndefined()
    expect(() => wslLinuxPath(distribution, 'C:\\models')).toThrow('copy it into WSL')
    expect(() => wslLinuxPath(distribution, native.replace('012345abcdef', 'abcdef012345'))).toThrow('copy it into WSL')
    expect(wslLocation('\\\\wsl.localhost\\Ubuntu\\home\\user')).toBeUndefined()
  })

  it('rejects traversal and Windows alternate streams instead of translating them across the boundary', () => {
    for (const suffix of ['home\\..\\mnt\\c', 'home/../../mnt/c', 'home\\models:secret', 'home\\bad\0name']) {
      expect(() => wslLocation(`\\\\wsl.localhost\\${distribution}\\${suffix}`)).toThrow('Invalid WSL path')
    }
    for (const linux of ['relative', '/home/../mnt/c', '/home/./models', '/home/models:secret', '/home\\models', '/home/invalid\0name']) {
      expect(() => wslWindowsPath(distribution, linux)).toThrow('Invalid WSL path')
    }
    expect(() => wslWindowsPath('Ubuntu', '/home/user')).toThrow('Invalid WSL path')
  })
})
