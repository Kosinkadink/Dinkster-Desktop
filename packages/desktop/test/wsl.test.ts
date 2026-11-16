import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
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
  return { ...module, isAbsolute: module.win32.isAbsolute }
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
    try {
      const result = await client.run({ root: guest.projectRoot('studio'),
        operation: channelSelected ? 'update' : 'status',
        ...(channelSelected ? { channel: 'nightly' as const, mirrors: ['https://channel.invalid'] } : {}) })
      expect(JSON.parse(result.sourceDescription!)).toEqual(channelSelected ? channelTools : tools)
      expect(result.root).toBe(guest.projectRoot('studio'))
    } finally {
      await client.dispose()
      delete trustedChannelKeys[keyId]
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
