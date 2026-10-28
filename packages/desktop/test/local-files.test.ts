import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetLocations, fileCapabilities, grantedFile, requireLocalFiles, revealGrantedFile } from '../src/local-files.js'

describe('local file authority', () => {
  it('binds capabilities and requests to the running managed connection only', () => {
    const managed = 'http://127.0.0.1:5011'
    expect(fileCapabilities(`${managed}/`, managed, true)).toEqual({ nativeFolderChoice: true, reveal: false })
    expect(fileCapabilities(`${managed}/`, managed, true, true).reveal).toBe(true)
    expect(() => requireLocalFiles(managed, managed, true)).not.toThrow()
    for (const url of [undefined, '', 'http://localhost:5011', 'http://127.0.0.1:5012', 'https://server.invalid', `${managed}/remote`, `${managed}?backend=remote`, 'http://user:password@127.0.0.1:5011']) {
      expect(fileCapabilities(url, managed, true)).toEqual({ nativeFolderChoice: false, reveal: false })
      expect(fileCapabilities(url, managed, true, true).reveal).toBe(false)
      expect(() => requireLocalFiles(url, managed, true)).toThrow('shell-managed backend')
    }
    expect(fileCapabilities(managed, managed, false).reveal).toBe(false)
    expect(fileCapabilities(managed, undefined, true).nativeFolderChoice).toBe(false)
  })

  it('uses exact scoped identity and active grants, distinguishing empty success from denied or unsupported lookup', async () => {
    const vault = join(tmpdir(), 'vault')
    const active = join(tmpdir(), 'active')
    const pending = join(tmpdir(), 'pending')
    const file = join(active, 'named upload.png')
    const asset = { digest: `blake3:${'a1'.repeat(32)}`, scope: 'local', project: 'work' }
    let status = 200
    let body: unknown = {
      vault, locations: [{ storage: 'mount', mount: 'imports', virtualPath: 'mounts/imports/named upload.png', path: file }],
      activeMounts: [{ id: 'imports', path: active }], mounts: [{ id: 'imports', path: pending }],
    }
    let request: URL | undefined
    const server = createServer((incoming, response) => {
      request = new URL(incoming.url!, 'http://localhost')
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server unavailable')
    const url = `http://127.0.0.1:${address.port}`
    try {
      expect(await assetLocations(url, asset, 'work')).toEqual([{ path: file, root: active }])
      expect(request!.pathname).toBe('/api/mounts/locations')
      expect(Object.fromEntries(request!.searchParams)).toEqual(asset)
      for (const invalid of [file, { ...asset, path: file }, { ...asset, project: 'other' }, { ...asset, scope: 'remote' }, { ...asset, digest: 'blake3:abc' }]) {
        await expect(assetLocations(url, invalid, 'work')).rejects.toThrow('identity')
      }
      body = { vault, locations: [], activeMounts: [] }
      expect(await assetLocations(url, asset, 'work')).toEqual([])
      for (const denied of [400, 403, 404, 500]) {
        status = denied
        await expect(assetLocations(url, asset, 'work')).rejects.toThrow(`HTTP ${denied}`)
      }
      status = 200
      for (const invalid of [
        { locations: [], activeMounts: [] },
        { vault, activeMounts: [] },
        { vault, locations: [{ storage: 'mount', mount: 'revoked', path: file }], activeMounts: [], mounts: [{ id: 'revoked', path: pending }] },
      ]) {
        body = invalid
        await expect(assetLocations(url, asset, 'work')).rejects.toThrow()
      }
      body = { vault, locations: [{ storage: 'vault', path: join(vault, 'blob') }], activeMounts: [] }
      expect(await assetLocations(url, asset, 'work')).toEqual([{ root: vault, path: join(vault, 'blob') }])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('reveals exact existing granted files and refuses sibling paths and escaping links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop files '))
    try {
      const granted = join(root, 'mounted network folder')
      const sibling = join(root, 'mounted network folder-other')
      await mkdir(granted)
      await mkdir(sibling)
      const file = join(granted, 'output image.png')
      const outside = join(sibling, 'private.txt')
      await writeFile(file, 'image')
      await writeFile(outside, 'private')
      expect(await grantedFile(file, [granted])).toBe(await realpath(file))
      for (const invalid of [outside, granted, join(granted, 'missing'), '../private', null]) {
        await expect(grantedFile(invalid, [granted])).rejects.toThrow()
      }
      // Junctions exercise Windows directory redirection without symlink privileges.
      await symlink(sibling, join(granted, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(grantedFile(join(granted, 'escape', 'private.txt'), [granted])).rejects.toThrow('outside')
      const selected: string[] = []
      const opened: string[] = []
      const shell = {
        showItemInFolder: (path: string) => { selected.push(path) },
        openPath: async (path: string) => { opened.push(path); return '' },
      }
      expect(await revealGrantedFile(file, [granted], shell, async () => {}, 'win32')).toEqual({ mode: 'selected' })
      expect(selected).toEqual([await realpath(file)])
      expect(await revealGrantedFile(file, [granted], shell, async () => {}, 'linux')).toEqual({ mode: 'folder' })
      expect(opened).toEqual([await realpath(granted)])
      await expect(revealGrantedFile(file, [granted], { ...shell, openPath: async () => 'failed' }, async () => {}, 'linux')).rejects.toThrow('file manager')
      await expect(revealGrantedFile(file, [granted], shell, async () => { throw new Error('revoked') }, 'win32')).rejects.toThrow('revoked')
      expect(selected).toHaveLength(1)
      await expect(revealGrantedFile(file, [granted], shell, async () => { await rm(file) }, 'win32')).rejects.toThrow('missing')
      expect(selected).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
