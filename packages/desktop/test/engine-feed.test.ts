import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMirrorFetcher } from '../src/r2-mirror.js'
import {
  ENGINE_CHANNEL_FORMAT,
  ENGINE_MANIFEST_FORMAT,
  EngineFeedError,
  EngineFeedShellVersionError,
  inspectEngineFeed,
  parseEngineChannel,
  parseEngineManifest,
} from '../src/engine-feed.js'

const BASE = 'https://mirror.example.test/dinkster'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const OTHER_COMMIT = '89abcdef0123456789abcdef0123456789abcdef'
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const OTHER_DIGEST = '6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b'
const CELL = 'linux-cu128'
const MANIFEST_PATH = `engine/${COMMIT}/${CELL}.json`
const CHANNEL_URL = `${BASE}/channels/stable.json`
const MANIFEST_URL = `${BASE}/${MANIFEST_PATH}`
const MINIMUM = '1.2.3'

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: MANIFEST_PATH, sha256: DIGEST, size: 10, ...overrides }
}

function channelDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: ENGINE_CHANNEL_FORMAT,
    channel: 'stable',
    commit: COMMIT,
    minimumLauncherVersion: MINIMUM,
    cells: { [CELL]: artifact() },
    ...overrides,
  }
}

function manifestBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  const document = {
    format: ENGINE_MANIFEST_FORMAT,
    commit: COMMIT,
    cell: CELL,
    base: {
      id: OTHER_DIGEST,
      archive: { path: 'base/linux/py312-torch2.13-abc.tar.zst', sha256: DIGEST, size: 4096 },
      python: 'tools/python/bin/python3',
      packages: { torch: '2.13.0', torchvision: '0.28.0' },
    },
    wheels: [
      {
        path: `store/${DIGEST.slice(0, 8)}/dinkster-0.2.0-py3-none-any.whl`,
        sha256: OTHER_DIGEST,
        size: 1024,
        filename: 'dinkster-0.2.0-py3-none-any.whl',
        name: 'dinkster',
        version: '0.2.0',
        environments: ['control', 'execution'],
      },
    ],
    ...overrides,
  }
  return new TextEncoder().encode(JSON.stringify(document))
}

interface RecordedRequest {
  readonly url: string
}

function mirror(routes: ReadonlyMap<string, () => Response>) {
  const log: RecordedRequest[] = []
  const fetchFn = async (url: string | URL | Request): Promise<Response> => {
    const requested = String(url instanceof Request ? url.url : url)
    log.push({ url: requested })
    const route = routes.get(requested)
    if (!route) throw new Error(`unexpected mirror request to ${requested}`)
    return route()
  }
  return { log, fetcher: createMirrorFetcher(BASE, fetchFn) }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

let cachedDefaultManifest: Uint8Array | undefined

function defaultManifestBytes(): Uint8Array {
  cachedDefaultManifest ??= manifestBytes()
  return cachedDefaultManifest
}

function stableMirror(overrides: {
  channel?: Record<string, unknown>
  manifest?: Uint8Array
  /** Advertise a digest that does not match the served manifest bytes. */
  corruptManifestDigest?: boolean
} = {}) {
  const body = overrides.manifest ?? defaultManifestBytes()
  const digest = overrides.corruptManifestDigest ? OTHER_DIGEST : sha256Hex(body)
  const channel = overrides.channel ?? channelDocument({ cells: { [CELL]: artifact({ sha256: digest }) } })
  return mirror(
    new Map([
      [CHANNEL_URL, () => Response.json(channel)],
      [MANIFEST_URL, () => new Response(body, { headers: { 'content-type': 'application/json' } })],
    ]),
  )
}

async function inspect(recorded: ReturnType<typeof stableMirror>, shellVersion = '1.2.3') {
  return inspectEngineFeed(recorded.fetcher, { channel: 'stable', cell: CELL, shellVersion })
}

describe('engine channel parsing', () => {
  it('accepts a strict channel document', () => {
    const channel = parseEngineChannel(channelDocument())
    expect(channel.format).toBe(ENGINE_CHANNEL_FORMAT)
    expect(channel.channel).toBe('stable')
    expect(channel.commit).toBe(COMMIT)
    expect(channel.minimumLauncherVersion).toBe(MINIMUM)
    expect(channel.cells[CELL]).toEqual(artifact())
    expect(parseEngineChannel(channelDocument({ channel: 'github-live' })).channel).toBe('github-live')
  })

  it('rejects unknown, missing, and mistyped top-level fields', () => {
    expect(() => parseEngineChannel(channelDocument({ extra: 1 }))).toThrow(EngineFeedError)
    expect(() => parseEngineChannel({ format: ENGINE_CHANNEL_FORMAT, channel: 'stable', commit: COMMIT })).toThrow(
      /missing field/,
    )
    expect(() => parseEngineChannel(channelDocument({ format: 'dinkster.engine/2' }))).toThrow(/format/)
    expect(() => parseEngineChannel(channelDocument({ channel: 'beta' }))).toThrow(/'stable' or 'github-live'/)
    expect(() => parseEngineChannel(channelDocument({ commit: COMMIT.toUpperCase() }))).toThrow(/commit/)
    expect(() => parseEngineChannel(channelDocument({ commit: COMMIT.slice(1) }))).toThrow(/commit/)
    expect(() => parseEngineChannel(channelDocument({ minimumLauncherVersion: '1.2' }))).toThrow(/major.minor.patch/)
    expect(() => parseEngineChannel(channelDocument({ minimumLauncherVersion: '1.2.3-beta' }))).toThrow(
      /major.minor.patch/,
    )
    expect(() => parseEngineChannel(channelDocument({ cells: {} }))).toThrow(/nonempty/)
    expect(() => parseEngineChannel(channelDocument({ cells: [] }))).toThrow(/nonempty/)
    expect(() => parseEngineChannel(null)).toThrow(EngineFeedError)
  })

  it('rejects malformed cell artifacts', () => {
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ path: `engine/${OTHER_COMMIT}/${CELL}.json` }) } }))).toThrow(
      /must point at/,
    )
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ path: `engine/${COMMIT}/other.json` }) } }))).toThrow(
      /must point at/,
    )
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ path: `../${MANIFEST_PATH}` }) } }))).toThrow(
      /traversal/,
    )
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ sha256: DIGEST.toUpperCase() }) } }))).toThrow(
      /sha256/,
    )
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ sha256: DIGEST.slice(1) }) } }))).toThrow(
      /sha256/,
    )
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ size: -1 }) } }))).toThrow(/size/)
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ size: 1.5 }) } }))).toThrow(/size/)
    expect(() => parseEngineChannel(channelDocument({ cells: { [CELL]: artifact({ extra: 1 }) } }))).toThrow(
      /unknown field/,
    )
  })
})

describe('engine manifest parsing', () => {
  it('accepts strict manifest bytes and reports the display fields', () => {
    const manifest = parseEngineManifest(manifestBytes())
    expect(manifest.format).toBe(ENGINE_MANIFEST_FORMAT)
    expect(manifest.commit).toBe(COMMIT)
    expect(manifest.cell).toBe(CELL)
    expect(manifest.base.id).toBe(OTHER_DIGEST)
    expect(manifest.wheels).toHaveLength(1)
  })

  it('rejects non-JSON, non-object, unknown, and missing fields', () => {
    expect(() => parseEngineManifest(new TextEncoder().encode('not json'))).toThrow(/not valid UTF-8 JSON/)
    expect(() => parseEngineManifest(new TextEncoder().encode('"str"'))).toThrow(EngineFeedError)
    expect(() => parseEngineManifest(manifestBytes({ extra: 1 }))).toThrow(/unknown field/)
    expect(() => parseEngineManifest(manifestBytes({ format: 'dinkster.engine-channel/1' }))).toThrow(/format/)
    expect(() => parseEngineManifest(manifestBytes({ commit: COMMIT.toUpperCase() }))).toThrow(EngineFeedError)
    // An empty wheels list is a valid manifest; the cell mismatch is checked against the channel.
    expect(parseEngineManifest(manifestBytes({ wheels: [] })).wheels).toEqual([])
  })

  it('rejects malformed base and wheel records', () => {
    expect(() => parseEngineManifest(manifestBytes({ base: { unknown: true } }))).toThrow(EngineFeedError)
    expect(() =>
      parseEngineManifest(
        manifestBytes({
          base: {
            id: OTHER_DIGEST,
            archive: artifact({ path: `../base.tar.zst` }),
            python: 'tools/python/bin/python3',
            packages: {},
          },
        }),
      ),
    ).toThrow(/traversal/)
    expect(() =>
      parseEngineManifest(
        manifestBytes({
          base: {
            id: OTHER_DIGEST,
            archive: artifact(),
            python: 'tools/python/bin/python3',
            packages: { 'Dinkster': '0.2.0' },
          },
        }),
      ),
    ).toThrow(/normalized distribution name/)
    expect(() =>
      parseEngineManifest(
        manifestBytes({
          wheels: [
            {
              path: `store/x.whl`,
              sha256: OTHER_DIGEST,
              size: 1024,
              filename: 'x.whl',
              name: 'dinkster',
              version: '0.2.0',
              environments: ['runtime'],
            },
          ],
        }),
      ),
    ).toThrow(/unknown wheel environment/)
    expect(() =>
      parseEngineManifest(
        manifestBytes({
          wheels: [
            {
              path: 'store/x.whl',
              sha256: OTHER_DIGEST,
              size: 1024,
              filename: 'nested/x.whl',
              name: 'dinkster',
              version: '0.2.0',
              environments: ['control'],
            },
          ],
        }),
      ),
    ).toThrow(/bare filename/)
    expect(() =>
      parseEngineManifest(
        manifestBytes({
          wheels: [
            {
              path: 'store/x.whl',
              sha256: OTHER_DIGEST,
              size: 1024,
              filename: 'x.whl',
              name: 'dinkster',
              version: '0.2.0',
              environments: [],
            },
          ],
        }),
      ),
    ).toThrow(/nonempty/)
  })
})

describe('engine feed inspection', () => {
  it('fetches exactly the channel and selected manifest and returns the display shape', async () => {
    const recorded = stableMirror()
    const inspection = await inspect(recorded)
    expect(recorded.log.map((request) => request.url)).toEqual([CHANNEL_URL, MANIFEST_URL])
    expect(inspection.display).toEqual({
      channel: 'stable',
      engineCommit: COMMIT,
      minimumLauncherVersion: MINIMUM,
      cell: CELL,
      baseId: OTHER_DIGEST,
      manifestPath: MANIFEST_PATH,
    })
  })

  it('makes zero manifest requests when the shell is older than the channel minimum', async () => {
    const recorded = stableMirror()
    await expect(inspect(recorded, '1.2.2')).rejects.toBeInstanceOf(EngineFeedShellVersionError)
    expect(recorded.log.map((request) => request.url)).toEqual([CHANNEL_URL])
  })

  it('accepts a shell exactly at the minimum version', async () => {
    const recorded = stableMirror()
    await expect(inspect(recorded, MINIMUM)).resolves.toBeDefined()
    expect(recorded.log).toHaveLength(2)
  })

  it('rejects a channel document that names a different channel than requested', async () => {
    const recorded = mirror(
      new Map([[`${BASE}/channels/github-live.json`, () => Response.json(channelDocument({ channel: 'stable' }))]]),
    )
    await expect(
      inspectEngineFeed(recorded.fetcher, { channel: 'github-live', cell: CELL, shellVersion: '1.2.3' }),
    ).rejects.toThrow(/names "stable"/)
    expect(recorded.log.map((request) => request.url)).toEqual([`${BASE}/channels/github-live.json`])
  })

  it('rejects a manifest whose commit does not match the channel commit', async () => {
    const recorded = stableMirror({ manifest: manifestBytes({ commit: OTHER_COMMIT }) })
    await expect(inspect(recorded)).rejects.toThrow(/does not match channel commit/)
    expect(recorded.log.map((request) => request.url)).toEqual([CHANNEL_URL, MANIFEST_URL])
  })

  it('rejects a manifest served for a different cell than requested', async () => {
    const recorded = stableMirror({ manifest: manifestBytes({ cell: 'win-cu128' }) })
    await expect(inspect(recorded)).rejects.toThrow(/does not match requested cell/)
    expect(recorded.log.map((request) => request.url)).toEqual([CHANNEL_URL, MANIFEST_URL])
  })

  it('rejects a channel that does not publish the requested cell without a manifest request', async () => {
    const recorded = stableMirror({
      channel: channelDocument({ cells: { 'win-cu128': artifact({ path: `engine/${COMMIT}/win-cu128.json` }) } }),
    })
    await expect(inspect(recorded)).rejects.toThrow(/does not publish cell/)
    expect(recorded.log.map((request) => request.url)).toEqual([CHANNEL_URL])
  })

  it('rejects manifest bytes that fail their channel sha256 verification', async () => {
    const recorded = stableMirror({ corruptManifestDigest: true })
    await expect(inspect(recorded)).rejects.toThrow(/checksum mismatch/)
    expect(recorded.log.map((request) => request.url)).toEqual([CHANNEL_URL, MANIFEST_URL])
  })

  it('rejects manifest bytes that are not valid JSON after verification', async () => {
    const recorded = stableMirror({ manifest: new TextEncoder().encode('[') })
    await expect(inspect(recorded)).rejects.toThrow(/not valid UTF-8 JSON/)
  })

  it('propagates a missing channel document without a manifest request', async () => {
    const recorded = mirror(new Map<string, () => Response>())
    await expect(inspect(recorded)).rejects.toThrow(/unexpected mirror request/)
    expect(recorded.log.map((request) => request.url)).toEqual([CHANNEL_URL])
  })
})
