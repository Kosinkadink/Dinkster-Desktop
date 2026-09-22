import { createHash } from 'node:crypto'

/**
 * Request boundary for the R2 release mirror.
 *
 * Everything Desktop downloads during install and update (channel documents,
 * engine manifests, base archives, code-layer files) must come from the
 * configured mirror base URL and no other host. This module resolves
 * mirror-relative targets, rejects anything outside the configured base
 * (absolute URLs, cross-origin targets, path escapes, redirect escapes), and
 * verifies byte payloads against caller-supplied SHA-256 digests. It never
 * attaches credentials and imposes no document schema: callers own the
 * channel and manifest field definitions.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface MirrorRequestOptions {
  readonly fetch?: FetchLike
  readonly signal?: AbortSignal
}

export interface MirrorFetcher {
  /** Resolve a mirror-relative target to the absolute URL it would request. */
  resolve(target: string): string
  /** Fetch and parse a JSON document served under the mirror base. */
  fetchJson(target: string, options?: MirrorRequestOptions): Promise<unknown>
  /** Fetch bytes and verify their SHA-256 digest before returning them. */
  fetchBytes(target: string, expectedSha256: string, options?: MirrorRequestOptions): Promise<Uint8Array>
}

const MAX_REDIRECTS = 5

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Validate a mirror base URL: HTTPS, or loopback HTTP for tests only. */
export function validateMirrorBaseUrl(raw: string): string {
  const candidate = raw.trim()
  if (!candidate) throw new Error('the mirror base URL must not be empty')
  const url = new URL(candidate)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('the mirror base URL must use HTTPS or loopback HTTP')
  }
  if (url.username || url.password) throw new Error('the mirror base URL cannot contain credentials')
  if (url.search) throw new Error('the mirror base URL cannot contain a query string')
  if (url.hash) throw new Error('the mirror base URL cannot contain a fragment')
  return url.toString().replace(/\/$/, '')
}

/** Reject a resolved URL that leaves the configured mirror base. */
function requireUnderBase(base: string, resolved: URL): void {
  if (resolved.origin !== new URL(base).origin) {
    throw new Error(`mirror request escaped the mirror origin: ${resolved.toString()}`)
  }
  const basePath = new URL(`${base}/`).pathname
  if (!resolved.pathname.startsWith(basePath)) {
    throw new Error(`mirror request escaped the mirror base path: ${resolved.toString()}`)
  }
}

/**
 * Resolve a mirror-relative target under the base and reject anything that
 * leaves it: absolute or protocol-relative targets, other origins, and paths
 * that escape the base path. The base must already be validated.
 */
export function resolveMirrorTarget(base: string, target: string): string {
  if (target.includes('://') || target.startsWith('//')) {
    throw new Error(`mirror target must be relative to the mirror base, got ${JSON.stringify(target)}`)
  }
  const resolved = new URL(target, `${base}/`)
  requireUnderBase(base, resolved)
  return resolved.toString()
}

async function requestUnderMirror(
  base: string,
  target: string,
  requestFetch: FetchLike,
  signal?: AbortSignal,
): Promise<{ response: Response; url: string }> {
  let url = resolveMirrorTarget(base, target)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await requestFetch(url, { redirect: 'manual', ...(signal ? { signal } : {}) })
    if (!isRedirectStatus(response.status)) return { response, url }
    const location = response.headers.get('location')
    response.body?.cancel()
    if (!location) throw new Error(`mirror redirect from ${url} without a location header`)
    // Each hop resolves against the URL that returned it and is re-checked
    // against the configured base, so a redirect chain can only move between
    // mirror-relative resources.
    const next = new URL(location, url)
    requireUnderBase(base, next)
    url = next.toString()
  }
  throw new Error(`mirror request to ${target} exceeded ${MAX_REDIRECTS} redirects`)
}

function normalizeSha256(expected: string): string {
  const digest = expected.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`invalid SHA-256 digest: ${JSON.stringify(expected)}`)
  }
  return digest
}

export function createMirrorFetcher(baseUrl: string, injectedFetch?: FetchLike): MirrorFetcher {
  const base = validateMirrorBaseUrl(baseUrl)
  const defaultFetch: FetchLike = injectedFetch ?? fetch
  return {
    resolve(target: string): string {
      return resolveMirrorTarget(base, target)
    },
    async fetchJson(target: string, options?: MirrorRequestOptions): Promise<unknown> {
      const requestFetch = options?.fetch ?? defaultFetch
      const { response, url } = await requestUnderMirror(base, target, requestFetch, options?.signal)
      if (!response.ok) throw new Error(`mirror request failed (${response.status}) for ${url}`)
      return response.json()
    },
    async fetchBytes(
      target: string,
      expectedSha256: string,
      options?: MirrorRequestOptions,
    ): Promise<Uint8Array> {
      const requestFetch = options?.fetch ?? defaultFetch
      const expected = normalizeSha256(expectedSha256)
      const { response, url } = await requestUnderMirror(base, target, requestFetch, options?.signal)
      if (!response.ok) throw new Error(`mirror request failed (${response.status}) for ${url}`)
      const hash = createHash('sha256')
      const chunks: Uint8Array[] = []
      if (response.body) {
        for await (const chunk of response.body) {
          hash.update(chunk)
          chunks.push(chunk)
        }
      }
      const actual = hash.digest('hex')
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`)
      }
      const total = chunks.reduce((length, chunk) => length + chunk.byteLength, 0)
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    },
  }
}

/**
 * Compare two dot-separated numeric versions. Returns a negative number when
 * `a` is lower than `b`, zero when equal, and a positive number when higher.
 */
export function compareShellVersions(a: string, b: string): number {
  const parse = (version: string): number[] => {
    const parts = version.trim().split('.')
    if (parts.some((part) => !/^\d+$/.test(part))) {
      throw new Error(`invalid shell version: ${JSON.stringify(version)}`)
    }
    return parts.map((part) => Number(part))
  }
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const leftPart = left[index] ?? 0
    const rightPart = right[index] ?? 0
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** Whether the running shell version satisfies a minimum version gate. */
export function meetsMinimumShellVersion(current: string, minimum: string): boolean {
  return compareShellVersions(current, minimum) >= 0
}
