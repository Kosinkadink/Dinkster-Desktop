import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  compareShellVersions,
  createMirrorFetcher,
  meetsMinimumShellVersion,
  resolveMirrorTarget,
  validateMirrorBaseUrl,
} from '../src/r2-mirror.js'

const BASE = 'https://mirror.example.test/dinkster'

interface RecordedRequest {
  readonly url: string
  readonly init?: RequestInit
}

function fetchRecorder(routes: ReadonlyMap<string, (url: string) => Response>) {
  const log: RecordedRequest[] = []
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requested = String(url instanceof Request ? url.url : url)
    log.push({ url: requested, init })
    const route = routes.get(requested)
    if (!route) throw new Error(`unexpected mirror request to ${requested}`)
    return route(requested)
  }
  return { log, fetchFn }
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

describe('mirror base URL validation', () => {
  it('accepts HTTPS production bases and loopback HTTP test bases', () => {
    expect(validateMirrorBaseUrl('https://mirror.example.test/dinkster/')).toBe('https://mirror.example.test/dinkster')
    expect(validateMirrorBaseUrl('http://127.0.0.1:8443/mirror')).toBe('http://127.0.0.1:8443/mirror')
    expect(validateMirrorBaseUrl('http://localhost:8443')).toBe('http://localhost:8443')
  })

  it('rejects plain HTTP, credentials, query strings, and fragments', () => {
    expect(() => validateMirrorBaseUrl('http://mirror.example.test/dinkster')).toThrow('HTTPS')
    expect(() => validateMirrorBaseUrl('https://user:secret@mirror.example.test/dinkster')).toThrow('credentials')
    expect(() => validateMirrorBaseUrl('https://mirror.example.test/dinkster?channel=stable')).toThrow('query')
    expect(() => validateMirrorBaseUrl('https://mirror.example.test/dinkster#stable')).toThrow('fragment')
    expect(() => validateMirrorBaseUrl('')).toThrow('must not be empty')
  })
})

describe('mirror target resolution', () => {
  it('allows mirror-relative targets nested under the base path', () => {
    expect(resolveMirrorTarget(BASE, 'channels/stable.json')).toBe(`${BASE}/channels/stable.json`)
    expect(resolveMirrorTarget(BASE, '/dinkster/engine/abc123/cell.json')).toBe(`${BASE}/engine/abc123/cell.json`)
    // Stays inside the base, so an internal .. segment is harmless.
    expect(resolveMirrorTarget(BASE, 'channels/../channels/stable.json')).toBe(`${BASE}/channels/stable.json`)
  })

  it('rejects absolute, protocol-relative, cross-origin, and escaping targets', () => {
    expect(() => resolveMirrorTarget(BASE, 'https://evil.example.test/channels/stable.json')).toThrow('relative')
    expect(() => resolveMirrorTarget(BASE, '//evil.example.test/channels/stable.json')).toThrow('relative')
    expect(() => resolveMirrorTarget(BASE, 'http://127.0.0.1:8443/mirror/channels/stable.json')).toThrow('relative')
    expect(() => resolveMirrorTarget(BASE, 'file:///etc/passwd')).toThrow('relative')
    // Even a same-origin absolute URL is not a mirror-relative resource.
    expect(() => resolveMirrorTarget(BASE, 'https://mirror.example.test/other/channels/stable.json')).toThrow(
      'relative',
    )
    expect(() => resolveMirrorTarget(BASE, '../outside.json')).toThrow('base path')
    expect(() => resolveMirrorTarget(BASE, 'channels/../../outside.json')).toThrow('base path')
  })
})

describe('mirror JSON fetching', () => {
  it('fetches a same-origin nested document and records the complete request log', async () => {
    const recorder = fetchRecorder(
      new Map([
        [`${BASE}/channels/stable.json`, () => Response.json({ ok: true })],
      ]),
    )
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    await expect(mirror.fetchJson('channels/stable.json')).resolves.toEqual({ ok: true })
    expect(recorder.log.map((request) => request.url)).toEqual([`${BASE}/channels/stable.json`])
    expect(recorder.log[0]?.init?.redirect).toBe('manual')
  })

  it('rejects non-OK responses and invalid JSON', async () => {
    const recorder = fetchRecorder(
      new Map([
        [`${BASE}/channels/missing.json`, () => new Response(null, { status: 404 })],
        [`${BASE}/channels/broken.json`, () => new Response('not json {')],
      ]),
    )
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    await expect(mirror.fetchJson('channels/missing.json')).rejects.toThrow('(404)')
    await expect(mirror.fetchJson('channels/broken.json')).rejects.toThrow()
    expect(recorder.log.map((request) => request.url)).toEqual([
      `${BASE}/channels/missing.json`,
      `${BASE}/channels/broken.json`,
    ])
  })
})

describe('mirror redirect handling', () => {
  it('follows a same-origin redirect that stays under the base path', async () => {
    const recorder = fetchRecorder(
      new Map([
        [`${BASE}/engine/old/cell.json`, () => redirect('/dinkster/engine/new/cell.json')],
        [`${BASE}/engine/new/cell.json`, () => Response.json({ moved: true })],
      ]),
    )
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    await expect(mirror.fetchJson('engine/old/cell.json')).resolves.toEqual({ moved: true })
    expect(recorder.log.map((request) => request.url)).toEqual([
      `${BASE}/engine/old/cell.json`,
      `${BASE}/engine/new/cell.json`,
    ])
  })

  it('rejects redirects to another origin and records no request to that host', async () => {
    const recorder = fetchRecorder(
      new Map([
        [`${BASE}/channels/stable.json`, () => redirect('https://evil.example.test/channels/stable.json')],
      ]),
    )
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    await expect(mirror.fetchJson('channels/stable.json')).rejects.toThrow('mirror origin')
    expect(recorder.log.map((request) => request.url)).toEqual([`${BASE}/channels/stable.json`])
  })

  it('rejects relative redirects that escape the base path', async () => {
    const recorder = fetchRecorder(
      new Map([
        [`${BASE}/channels/stable.json`, () => redirect('../../escaped.json')],
        [`${BASE}/channels/stable.json-2`, () => redirect('/other/escaped.json')],
      ]),
    )
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    await expect(mirror.fetchJson('channels/stable.json')).rejects.toThrow('base path')
    await expect(mirror.fetchJson('channels/stable.json-2')).rejects.toThrow('base path')
    expect(recorder.log.map((request) => request.url)).toEqual([
      `${BASE}/channels/stable.json`,
      `${BASE}/channels/stable.json-2`,
    ])
  })
})

describe('mirror byte fetching with SHA-256 verification', () => {
  const payload = 'archive-bytes'
  const digest = createHash('sha256').update(payload).digest('hex')

  it('returns verified bytes and records the complete request log', async () => {
    const recorder = fetchRecorder(
      new Map([[`${BASE}/engine/abc123/base.whl`, () => new Response(payload)]]),
    )
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    await expect(mirror.fetchBytes('engine/abc123/base.whl', digest.toUpperCase())).resolves.toEqual(
      new TextEncoder().encode(payload),
    )
    expect(recorder.log.map((request) => request.url)).toEqual([`${BASE}/engine/abc123/base.whl`])
  })

  it('rejects a checksum mismatch without returning the payload', async () => {
    const recorder = fetchRecorder(
      new Map([[`${BASE}/engine/abc123/corrupted.whl`, () => new Response(payload)]]),
    )
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    const wrongDigest = createHash('sha256').update('other bytes').digest('hex')
    await expect(mirror.fetchBytes('engine/abc123/corrupted.whl', wrongDigest)).rejects.toThrow('checksum mismatch')
    expect(recorder.log.map((request) => request.url)).toEqual([`${BASE}/engine/abc123/corrupted.whl`])
  })

  it('rejects malformed digests before issuing any request', async () => {
    const recorder = fetchRecorder(new Map())
    const mirror = createMirrorFetcher(BASE, recorder.fetchFn)
    await expect(mirror.fetchBytes('engine/abc123/base.whl', 'not-a-digest')).rejects.toThrow('invalid SHA-256')
    expect(recorder.log).toEqual([])
  })
})

describe('minimum shell version gate', () => {
  it('orders lower, equal, and higher versions', () => {
    expect(compareShellVersions('0.2.0', '0.3.0')).toBeLessThan(0)
    expect(compareShellVersions('0.3.0', '0.3.0')).toBe(0)
    expect(compareShellVersions('0.4.0', '0.3.0')).toBeGreaterThan(0)
    expect(compareShellVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareShellVersions('1.0', '1.0.0')).toBe(0)
  })

  it('accepts the running shell at, above, and below the minimum', () => {
    expect(meetsMinimumShellVersion('0.2.9', '0.3.0')).toBe(false)
    expect(meetsMinimumShellVersion('0.3.0', '0.3.0')).toBe(true)
    expect(meetsMinimumShellVersion('0.3.1', '0.3.0')).toBe(true)
  })

  it('rejects malformed versions', () => {
    expect(() => compareShellVersions('abc', '0.3.0')).toThrow('invalid shell version')
    expect(() => compareShellVersions('0.3.0-beta', '0.3.0')).toThrow('invalid shell version')
  })
})
