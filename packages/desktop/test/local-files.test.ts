import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assetLocations, fileCapabilities, grantedFile, importNativeFile, requireLocalFiles, resolveDroppedPath, revealGrantedFile, revealModelLocation } from '../src/local-files.js'
import type { DesktopFileImportProgress } from '../src/types.js'

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

  it('opens only an operator-registered model location and rechecks revocation before opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dinkster-model-location-'))
    const folder = join(root, 'existing models')
    await mkdir(folder)
    let status = 200
    let locations: unknown = [{ id: 'studio', path: folder }]
    let revoke = false
    let requests = 0
    const server = createServer((request, response) => {
      expect(request.url).toBe('/api/models/settings?project=work')
      requests++
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ locations: revoke && requests % 2 === 0 ? [] : locations }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server unavailable')
    const url = `http://127.0.0.1:${address.port}`
    const opened: string[] = []
    let authorized = true
    const shell = { openExternal: async (value: string) => { opened.push(value) } }
    const authorize = async () => { if (!authorized) throw new Error('managed context changed') }
    try {
      await revealModelLocation(url, 'studio', 'work', shell, authorize)
      expect(opened).toEqual([pathToFileURL(await realpath(folder)).href])
      opened.length = 0
      for (const invalid of [folder, '../studio', { id: 'studio', path: folder }, null]) {
        await expect(revealModelLocation(url, invalid, 'work', shell, authorize)).rejects.toThrow('Invalid model location')
      }
      for (const denied of [401, 403, 404, 500]) {
        status = denied
        await expect(revealModelLocation(url, 'studio', 'work', shell, authorize)).rejects.toThrow('copy the server path')
      }
      status = 200
      for (const invalid of [[], [{ id: 'other', path: folder }], [{ id: 'studio', path: 'relative' }], [{ id: 'studio', path: folder }, { id: 'studio', path: folder }]]) {
        locations = invalid
        await expect(revealModelLocation(url, 'studio', 'work', shell, authorize)).rejects.toThrow('copy the server path')
      }
      locations = [{ id: 'studio', path: folder }]
      requests = 0
      revoke = true
      await expect(revealModelLocation(url, 'studio', 'work', shell, authorize)).rejects.toThrow('copy the server path')
      revoke = false
      authorized = false
      await expect(revealModelLocation(url, 'studio', 'work', shell, authorize)).rejects.toThrow('copy the server path')
      expect(opened).toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves mounted drops without exposing paths or confusing errors with upload refusal', async () => {
    const path = join(tmpdir(), 'read only mount', 'dropped file.txt')
    const asset = { digest: `blake3:${'a2'.repeat(32)}`, name: 'dropped file.txt', size: 17, mediaType: 'text/plain', virtualPath: 'mounts/input/dropped file.txt' }
    let probeStatus = 200
    const locations = { mounts: [], activeMounts: [], restartRequired: false, pendingRemovals: [] }
    let capability: unknown = { ...locations, resolvePath: true }
    let status = 200
    let body: unknown = { status: 'resolved', asset }
    let authorized = true
    let revoke = false
    let request: unknown
    let receivedPath = false
    const server = createServer(async (incoming, response) => {
      if (incoming.method === 'GET') {
        expect(incoming.url).toBe('/api/mounts/locations')
        response.writeHead(probeStatus, { 'content-type': 'application/json' }).end(JSON.stringify(capability))
        return
      }
      expect(incoming.method).toBe('POST')
      expect(incoming.url).toBe('/api/mounts/resolve-path')
      let text = ''
      for await (const chunk of incoming) text += chunk
      request = JSON.parse(text)
      receivedPath = true
      if (revoke) authorized = false
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server unavailable')
    const url = `http://127.0.0.1:${address.port}`
    const authorize = async () => { if (!authorized) throw new Error('project or backend changed') }
    try {
      expect(await resolveDroppedPath(url, path, 'work', authorize)).toEqual({ status: 'resolved', asset })
      expect(request).toEqual({ path, project: 'work', scope: 'local' })
      body = { status: 'resolved', asset: { ...asset, size: 0 } }
      expect(await resolveDroppedPath(url, path, 'work', authorize)).toEqual(body)
      body = { status: 'refused', reason: 'not-resolvable' }
      expect(await resolveDroppedPath(url, path, 'work', authorize)).toEqual(body)
      for (const denied of [401, 403, 404, 405, 500]) {
        probeStatus = denied
        receivedPath = false
        await expect(resolveDroppedPath(url, path, 'work', authorize)).rejects.toThrow('no upload fallback')
        expect(receivedPath).toBe(false)
      }
      probeStatus = 200
      for (const unsupported of [locations, { ...locations, resolvePath: false }]) {
        capability = unsupported
        receivedPath = false
        expect(await resolveDroppedPath(url, path, 'work', authorize)).toEqual({ status: 'refused', reason: 'unsupported-backend' })
        expect(receivedPath).toBe(false)
      }
      for (const malformed of [{}, { ...locations, resolvePath: 'true' }, { ...locations, resolvePath: null }, { resolvePath: true }]) {
        capability = malformed
        receivedPath = false
        await expect(resolveDroppedPath(url, path, 'work', authorize)).rejects.toThrow('no upload fallback')
        expect(receivedPath).toBe(false)
      }
      capability = { ...locations, resolvePath: true }
      for (const denied of [400, 401, 403, 404, 405, 500]) {
        status = denied
        body = { error: path }
        await expect(resolveDroppedPath(url, path, 'work', authorize)).rejects.toThrow('no upload fallback')
      }
      status = 200
      for (const malformed of [
        null, { status: 'refused', reason: 'other' },
        { status: 'refused', reason: 'not-resolvable', path },
        { status: 'resolved', asset: { ...asset, path } },
        { status: 'resolved', asset: { ...asset, virtualPath: path } },
        { status: 'resolved', asset: { ...asset, virtualPath: 'mounts/input/../secret' } },
        { status: 'resolved', asset: { ...asset, digest: 'blake3:bad' } },
        ...[-1, true, '17', 1.5].map((size) => ({ status: 'resolved', asset: { ...asset, size } })),
      ]) {
        body = malformed
        const error = await resolveDroppedPath(url, path, 'work', authorize).catch((error: Error) => error)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).not.toContain(path)
      }
      body = { status: 'resolved', asset }
      revoke = true
      await expect(resolveDroppedPath(url, path, 'work', authorize)).rejects.toThrow('no upload fallback')
      authorized = true
      await expect(resolveDroppedPath(url, '../relative', 'work', authorize)).rejects.toThrow('Invalid')
      await expect(resolveDroppedPath(url, path, '../project', authorize)).rejects.toThrow('Invalid')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('imports native files only with current project authority and explicit engine support', async () => {
    const path = join(tmpdir(), 'private source', 'picked video.webm')
    const destination = { name: 'picked video.webm', mediaType: 'video/webm', kind: 'media/video', mount: 'imports', folder: 'clips' }
    const asset = { digest: `blake3:${'b3'.repeat(32)}`, name: 'picked video.webm', size: 500_000_000, mediaType: 'video/webm', virtualPath: 'mounts/imports/clips/picked video.webm' }
    let supported: unknown = true
    let authorized = true
    let revoke = false
    let status = 201
    let body: unknown = { asset, kind: 'media/video' }
    let received: { query: Record<string, string>; body: unknown } | undefined
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mounts: [], activeMounts: [], restartRequired: false, pendingRemovals: [], importFile: supported }))
        return
      }
      const url = new URL(request.url!, 'http://localhost')
      expect(url.pathname).toBe('/api/mounts/import-file')
      let text = ''
      for await (const chunk of request) text += chunk
      received = { query: Object.fromEntries(url.searchParams), body: JSON.parse(text) }
      if (revoke) authorized = false
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server unavailable')
    const url = `http://127.0.0.1:${address.port}`
    const authorize = async () => { if (!authorized) throw new Error('project changed') }
    try {
      expect(await importNativeFile(url, path, destination, 'work', authorize)).toEqual({ status: 'imported', asset })
      expect(received).toEqual({ query: { scope: 'local', project: 'work', name: destination.name, kind: 'media/video', mount: 'imports', folder: 'clips' }, body: { path, mediaType: 'video/webm' } })
      for (const unsupported of [false, undefined]) {
        supported = unsupported
        received = undefined
        expect(await importNativeFile(url, path, destination, 'work', authorize)).toEqual({ status: 'refused', reason: 'unsupported-backend' })
        expect(received).toBeUndefined()
      }
      supported = 'true'
      await expect(importNativeFile(url, path, destination, 'work', authorize)).rejects.toThrow('Native file import failed')
      expect(received).toBeUndefined()
      supported = true
      expect(await importNativeFile(url, path, destination, 'work', authorize, 'private-engine')).toEqual({ status: 'refused', reason: 'not-native-file' })
      expect(received).toBeUndefined()
      const generic = { name: asset.name, mediaType: 'application/octet-stream' }
      body = { asset: { ...asset, mediaType: generic.mediaType }, digest: asset.digest }
      expect(await importNativeFile(url, path, generic, 'work', authorize)).toEqual({ status: 'imported', asset: { ...asset, mediaType: generic.mediaType } })
      const latent = { name: 'sample.latent', kind: 'data/latent', mediaType: 'application/x-comfy-latent' }
      body = { asset: { ...asset, name: latent.name, mediaType: latent.mediaType, virtualPath: '' }, kind: latent.kind }
      expect(await importNativeFile(url, path, latent, 'work', authorize)).toEqual({ status: 'imported', asset: { ...asset, name: latent.name, mediaType: latent.mediaType, virtualPath: '' } })
      for (const failure of [403, 413, 500]) {
        status = failure
        body = { error: path }
        const error = await importNativeFile(url, path, destination, 'work', authorize).catch((error: Error) => error)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).not.toContain(path)
      }
      status = 201
      for (const malformed of [{ asset: { ...asset, path }, kind: 'media/video' }, { asset: { ...asset, virtualPath: path }, kind: 'media/video' }, { asset, kind: 'media/image' }]) {
        body = malformed
        await expect(importNativeFile(url, path, destination, 'work', authorize)).rejects.toThrow('Native file import failed')
      }
      body = { asset, kind: 'media/video' }
      revoke = true
      await expect(importNativeFile(url, path, destination, 'work', authorize)).rejects.toThrow('Native file import failed')
      authorized = true
      received = undefined
      await expect(importNativeFile(url, path, { ...destination, project: 'other' }, 'work', authorize)).rejects.toThrow('Invalid')
      expect(received).toBeUndefined()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('delivers staged import progress before completion and aborts the active response without exposing paths', async () => {
    const path = join(tmpdir(), 'private source', 'picked.bin')
    const destination = { name: 'caf\u00e9.bin', mediaType: 'application/octet-stream' }
    const asset = { digest: `blake3:${'b4'.repeat(32)}`, ...destination, size: 57, virtualPath: `mounts/imports/${destination.name}` }
    let capability: unknown = true
    let posts = 0
    let records: unknown[] = []
    let finish: (() => void) | undefined
    let disconnected: (() => void) | undefined
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mounts: [], activeMounts: [], restartRequired: false, pendingRemovals: [], importFile: true, importProgress: capability }))
        return
      }
      posts++
      for await (const _chunk of request) { /* The import body is path metadata, not file bytes. */ }
      if (request.headers.accept !== 'application/x-ndjson') {
        response.writeHead(406).end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      const closed = disconnected
      response.once('close', () => closed?.())
      finish = () => {
        const bytes = Buffer.from(records.map((event) => JSON.stringify(event)).join('\n') + '\n')
        const split = bytes.indexOf(Buffer.from('\u00e9')) + 1
        response.write(bytes.subarray(0, split))
        setImmediate(() => response.end(bytes.subarray(split)))
      }
      response.write(JSON.stringify({ type: 'progress', phase: 'copying', received: 23, total: 57, path }) + '\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server unavailable')
    const url = `http://127.0.0.1:${address.port}`
    const progress: DesktopFileImportProgress[] = []
    const run = (controller = new AbortController(), onProgress = (value: DesktopFileImportProgress) => { progress.push(value); const end = finish; finish = undefined; end?.() }) =>
      importNativeFile(url, path, destination, 'work', async () => {}, undefined, { signal: controller.signal, onProgress })
    try {
      records = [
        { type: 'progress', phase: 'copying', received: 57, total: 57 },
        { type: 'progress', phase: 'publishing', received: 57, total: 57 },
        { type: 'result', status: 201, body: { asset, digest: asset.digest } },
      ]
      const controller = new AbortController()
      expect(await run(controller, (value) => {
        progress.push(value)
        if (value.received === 23) finish!()
      })).toEqual({ status: 'imported', asset })
      expect(progress).toEqual([
        { phase: 'copying', received: 23, total: 57 },
        { phase: 'copying', received: 57, total: 57 },
        { phase: 'publishing', received: 57, total: 57 },
      ])
      for (const unsupported of [undefined, false]) {
        capability = unsupported
        const before = posts
        expect(await run()).toEqual({ status: 'refused', reason: 'unsupported-backend' })
        expect(posts).toBe(before)
      }
      capability = true
      for (const invalid of [
        [{ type: 'result', status: 413, body: { error: path } }],
        [{ type: 'progress', phase: 'copying', received: 22, total: 57 }],
        [{ type: 'progress', phase: 'copying', received: 24, total: -1 }],
        [{ type: 'result', status: 201, body: { asset: { ...asset, path }, digest: asset.digest } }],
        [{ type: 'progress', phase: 'publishing', received: 57, total: 57 }],
      ]) {
        records = invalid
        const error = await run().catch((error: Error) => error)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toContain('Native file import failed')
        expect(String(error)).not.toContain(path)
      }
      const closed = new Promise<void>((resolve) => { disconnected = resolve })
      const stopped = new AbortController()
      await expect(run(stopped, () => stopped.abort())).rejects.toThrow('Native file import cancelled')
      await closed
      const before = posts
      await expect(run(stopped)).rejects.toThrow('Native file import cancelled')
      expect(posts).toBe(before)
    } finally {
      server.closeAllConnections()
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
        openExternal: async (url: string) => { opened.push(url) },
      }
      expect(await revealGrantedFile(file, [granted], shell, async () => {}, 'win32')).toEqual({ mode: 'selected' })
      expect(selected).toEqual([await realpath(file)])
      expect(await revealGrantedFile(file, [granted], shell, async () => {}, 'linux')).toEqual({ mode: 'folder' })
      expect(opened).toEqual([pathToFileURL(await realpath(granted)).href])
      await expect(revealGrantedFile(file, [granted], { ...shell, openExternal: async () => { throw new Error('failed') } }, async () => {}, 'linux')).rejects.toThrow('file manager')
      await expect(revealGrantedFile(file, [granted], shell, async () => { throw new Error('revoked') }, 'win32')).rejects.toThrow('revoked')
      expect(selected).toHaveLength(1)
      await expect(revealGrantedFile(file, [granted], shell, async () => { await rm(file) }, 'win32')).rejects.toThrow('missing')
      expect(selected).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
