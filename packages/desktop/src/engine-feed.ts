/**
 * Strict parsing and inspection of the engine feed documents served by the
 * R2 mirror.
 *
 * The mirror hosts two document types:
 *
 * - Engine channel (`dinkster.engine-channel/1`) at
 *   `channels/<channel>.json`, mapping each cell to its manifest artifact.
 * - Engine manifest (`dinkster.engine/1`) at `engine/<commit>/<cell>.json`,
 *   describing the base archive and code-layer wheels for one commit and
 *   cell.
 *
 * Parsing is strict: unknown fields and values outside the documented shape
 * are rejected so a buggy or compromised mirror cannot smuggle content past
 * Desktop. Desktop only validates what it displays and passes to the engine
 * CLI: it never downloads base archives or wheels and never provisions an
 * install; the mirror-side engine remains authoritative for that.
 */

import { meetsMinimumShellVersion } from './r2-mirror.js'
import type { MirrorRequestOptions, MirrorFetcher } from './r2-mirror.js'

export const ENGINE_CHANNEL_FORMAT = 'dinkster.engine-channel/1'
export const ENGINE_MANIFEST_FORMAT = 'dinkster.engine/1'

export type EngineChannelName = 'stable' | 'github-live'
export type EngineWheelEnvironment = 'control' | 'execution'

export interface EngineArtifact {
  /** Strictly relative POSIX object key resolved under the mirror base. */
  readonly path: string
  /** Lowercase 64-hex SHA-256 digest of the object contents. */
  readonly sha256: string
  /** Exact object size in bytes. */
  readonly size: number
}

export interface EngineChannelDocument {
  readonly format: typeof ENGINE_CHANNEL_FORMAT
  readonly channel: EngineChannelName
  /** 40 character lowercase hex engine commit the channel names. */
  readonly commit: string
  /** Oldest shell version that may consume this channel. */
  readonly minimumLauncherVersion: string
  readonly cells: Readonly<Record<string, EngineArtifact>>
}

export interface EngineBase {
  /** 64-hex digest identifying the pinned base set. */
  readonly id: string
  readonly archive: EngineArtifact
  /** Relative path of the interpreter inside the extracted base. */
  readonly python: string
  /** Normalized distribution name to exact version for base packages. */
  readonly packages: Readonly<Record<string, string>>
}

export interface EngineWheel {
  readonly path: string
  readonly sha256: string
  readonly size: number
  readonly filename: string
  readonly name: string
  readonly version: string
  readonly environments: readonly EngineWheelEnvironment[]
}

export interface EngineManifestDocument {
  readonly format: typeof ENGINE_MANIFEST_FORMAT
  readonly commit: string
  readonly cell: string
  readonly base: EngineBase
  readonly wheels: readonly EngineWheel[]
}

/** What Desktop shows for one feed cell and safely hands to the engine CLI. */
export interface EngineFeedDisplay {
  readonly channel: EngineChannelName
  readonly engineCommit: string
  readonly minimumLauncherVersion: string
  readonly cell: string
  readonly baseId: string
  /** Mirror-relative manifest path the engine CLI consumes. */
  readonly manifestPath: string
}

export interface EngineFeedInspection {
  readonly channel: EngineChannelDocument
  readonly manifest: EngineManifestDocument
  readonly display: EngineFeedDisplay
}

export interface InspectEngineFeedOptions {
  readonly channel: EngineChannelName
  readonly cell: string
  /** Running shell version, gated against the channel minimum before any manifest request. */
  readonly shellVersion: string
  readonly signal?: AbortSignal
}

export class EngineFeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineFeedError'
  }
}

/** The shell is older than the channel's minimumLauncherVersion. */
export class EngineFeedShellVersionError extends EngineFeedError {
  constructor(message: string) {
    super(message)
    this.name = 'EngineFeedShellVersionError'
  }
}

const HEX_40 = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-f]{64}$/
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const CELL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NORMALIZED_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectKeys(
  value: unknown,
  expected: readonly string[],
  what: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new EngineFeedError(`${what} must be a JSON object`)
  const present = new Set(Object.keys(value))
  for (const key of expected) {
    if (!present.has(key)) throw new EngineFeedError(`${what} is missing field ${JSON.stringify(key)}`)
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      throw new EngineFeedError(`${what} has unknown field ${JSON.stringify(key)}`)
    }
  }
  return value
}

function validateCommit(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX_40.test(value)) {
    throw new EngineFeedError(`${what} must be a 40 character lowercase hex commit id`)
  }
  return value
}

function validateDigest(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    throw new EngineFeedError(`${what} must be 64 lowercase hex characters`)
  }
  return value
}

function validateSize(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new EngineFeedError(`${what} must be a nonnegative integer`)
  }
  return value
}

function validateVersion(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value || CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new EngineFeedError(`${what} must be a nonempty string without whitespace or control characters`)
  }
  return value
}

/**
 * Require a strictly relative POSIX object key with nothing to exploit.
 * Percent-encoding is rejected outright, so encoded separators and traversal
 * cannot survive URL normalization on the mirror request.
 */
function validateObjectKey(value: unknown, what: string): string {
  validateVersion(value, what)
  const key = value as string
  if (key.includes('\\')) throw new EngineFeedError(`${what} must not contain backslashes`)
  for (const character of '?#@:%') {
    if (key.includes(character)) {
      throw new EngineFeedError(`${what} must not contain ${JSON.stringify(character)}`)
    }
  }
  if (key.startsWith('/') || key.endsWith('/')) {
    throw new EngineFeedError(`${what} must be relative without leading or trailing slashes`)
  }
  for (const segment of key.split('/')) {
    if (!segment || segment.startsWith('.')) {
      throw new EngineFeedError(`${what} must not contain empty or traversal path segments`)
    }
  }
  return key
}

function parseArtifact(value: unknown, what: string): EngineArtifact {
  const body = expectKeys(value, ['path', 'sha256', 'size'], what)
  return {
    path: validateObjectKey(body.path, `${what} path`),
    sha256: validateDigest(body.sha256, `${what} sha256`),
    size: validateSize(body.size, `${what} size`),
  }
}

function parseBase(value: unknown, what: string): EngineBase {
  const body = expectKeys(value, ['id', 'archive', 'python', 'packages'], what)
  const id = validateDigest(body.id, `${what} id`)
  const archive = parseArtifact(body.archive, `${what} archive`)
  const python = validateObjectKey(body.python, `${what} python path`)
  if (!isPlainObject(body.packages)) {
    throw new EngineFeedError(`${what} packages must be a JSON object`)
  }
  const packages: Record<string, string> = {}
  for (const [name, version] of Object.entries(body.packages)) {
    const normalized = name.replace(/[-_.]+/g, '-')
    if (!NORMALIZED_NAME.test(name) || normalized !== name) {
      throw new EngineFeedError(`${what} package ${JSON.stringify(name)} is not a normalized distribution name`)
    }
    packages[name] = validateVersion(version, `${what} package ${JSON.stringify(name)} version`)
  }
  return { id, archive, python, packages }
}

function parseWheel(value: unknown, what: string): EngineWheel {
  const body = expectKeys(
    value,
    ['path', 'sha256', 'size', 'filename', 'name', 'version', 'environments'],
    what,
  )
  const filename = validateVersion(body.filename, `${what} filename`)
  if (filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
    throw new EngineFeedError(`${what} filename must be a bare filename without path separators`)
  }
  const name = body.name
  const normalizedName = typeof name === 'string' ? name.replace(/[-_.]+/g, '-') : null
  if (typeof name !== 'string' || !NORMALIZED_NAME.test(name) || normalizedName !== name) {
    throw new EngineFeedError(`${what} name ${JSON.stringify(name)} is not a normalized distribution name`)
  }
  const environments = body.environments
  if (!Array.isArray(environments) || environments.length === 0) {
    throw new EngineFeedError(`${what} environments must be a nonempty list`)
  }
  const seen = new Set<string>()
  for (const environment of environments) {
    if (environment !== 'control' && environment !== 'execution') {
      throw new EngineFeedError(
        `${what} has unknown wheel environment ${JSON.stringify(environment)}`,
      )
    }
    if (seen.has(environment)) {
      throw new EngineFeedError(`${what} has duplicate wheel environment ${JSON.stringify(environment)}`)
    }
    seen.add(environment)
  }
  return {
    path: validateObjectKey(body.path, `${what} path`),
    sha256: validateDigest(body.sha256, `${what} sha256`),
    size: validateSize(body.size, `${what} size`),
    filename,
    name,
    version: validateVersion(body.version, `${what} version`),
    environments: environments as readonly EngineWheelEnvironment[],
  }
}

/** Parse an already-fetched channel document of unknown shape. */
export function parseEngineChannel(value: unknown): EngineChannelDocument {
  const body = expectKeys(
    value,
    ['format', 'channel', 'commit', 'minimumLauncherVersion', 'cells'],
    'engine channel',
  )
  if (body.format !== ENGINE_CHANNEL_FORMAT) {
    throw new EngineFeedError(`engine channel format must be ${JSON.stringify(ENGINE_CHANNEL_FORMAT)}`)
  }
  if (body.channel !== 'stable' && body.channel !== 'github-live') {
    throw new EngineFeedError("engine channel must be 'stable' or 'github-live'")
  }
  const commit = validateCommit(body.commit, 'engine channel commit')
  const minimum = body.minimumLauncherVersion
  if (typeof minimum !== 'string' || !SEMVER.test(minimum)) {
    throw new EngineFeedError('engine channel minimum launcher version must be a numeric major.minor.patch version')
  }
  if (!isPlainObject(body.cells) || Object.keys(body.cells).length === 0) {
    throw new EngineFeedError('engine channel cells must be a nonempty JSON object')
  }
  const cells: Record<string, EngineArtifact> = {}
  for (const [cell, artifact] of Object.entries(body.cells)) {
    if (!CELL_NAME.test(cell)) {
      throw new EngineFeedError(`engine channel cell ${JSON.stringify(cell)} is not a cell name`)
    }
    const parsed = parseArtifact(artifact, `engine channel cell ${JSON.stringify(cell)}`)
    const expected = `engine/${commit}/${cell}.json`
    if (parsed.path !== expected) {
      throw new EngineFeedError(`engine channel cell ${JSON.stringify(cell)} must point at ${JSON.stringify(expected)}`)
    }
    cells[cell] = parsed
  }
  return {
    format: ENGINE_CHANNEL_FORMAT,
    channel: body.channel,
    commit,
    minimumLauncherVersion: minimum,
    cells,
  }
}

/** Parse engine manifest bytes fetched and SHA-verified from the mirror. */
export function parseEngineManifest(bytes: Uint8Array): EngineManifestDocument {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new EngineFeedError(`engine manifest is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = expectKeys(value, ['format', 'commit', 'cell', 'base', 'wheels'], 'engine manifest')
  if (body.format !== ENGINE_MANIFEST_FORMAT) {
    throw new EngineFeedError(`engine manifest format must be ${JSON.stringify(ENGINE_MANIFEST_FORMAT)}`)
  }
  const commit = validateCommit(body.commit, 'engine manifest commit')
  const cell = body.cell
  if (typeof cell !== 'string' || !CELL_NAME.test(cell)) {
    throw new EngineFeedError(`engine manifest cell ${JSON.stringify(cell)} is not a cell name`)
  }
  if (!Array.isArray(body.wheels)) {
    throw new EngineFeedError('engine manifest wheels must be a JSON list')
  }
  return {
    format: ENGINE_MANIFEST_FORMAT,
    commit,
    cell,
    base: parseBase(body.base, 'engine manifest base'),
    wheels: body.wheels.map((wheel, index) => parseWheel(wheel, `engine manifest wheel ${index}`)),
  }
}

/**
 * Fetch and inspect the engine feed for one channel and cell: the channel
 * document, the shell version gate against its minimumLauncherVersion, then
 * the SHA-verified manifest for the selected cell. Exactly two mirror
 * requests are made on success - the channel document and the selected
 * manifest - and only the channel document when the version gate rejects.
 */
export async function inspectEngineFeed(
  fetcher: MirrorFetcher,
  options: InspectEngineFeedOptions,
): Promise<EngineFeedInspection> {
  const request: MirrorRequestOptions = { ...(options.signal ? { signal: options.signal } : {}) }
  const channel = parseEngineChannel(await fetcher.fetchJson(`channels/${options.channel}.json`, request))
  if (channel.channel !== options.channel) {
    throw new EngineFeedError(
      `engine channel document names ${JSON.stringify(channel.channel)}, expected ${JSON.stringify(options.channel)}`,
    )
  }
  if (typeof options.cell !== 'string' || !CELL_NAME.test(options.cell)) {
    throw new EngineFeedError(`cell ${JSON.stringify(options.cell)} is not a cell name`)
  }
  if (!meetsMinimumShellVersion(options.shellVersion, channel.minimumLauncherVersion)) {
    throw new EngineFeedShellVersionError(
      `shell version ${options.shellVersion} is older than the channel minimum ${channel.minimumLauncherVersion}`,
    )
  }
  const artifact = channel.cells[options.cell]
  if (!artifact) {
    throw new EngineFeedError(`engine channel does not publish cell ${JSON.stringify(options.cell)}`)
  }
  const manifest = parseEngineManifest(await fetcher.fetchBytes(artifact.path, artifact.sha256, request))
  if (manifest.commit !== channel.commit) {
    throw new EngineFeedError(
      `engine manifest commit ${JSON.stringify(manifest.commit)} does not match channel commit ${JSON.stringify(channel.commit)}`,
    )
  }
  if (manifest.cell !== options.cell) {
    throw new EngineFeedError(
      `engine manifest cell ${JSON.stringify(manifest.cell)} does not match requested cell ${JSON.stringify(options.cell)}`,
    )
  }
  return {
    channel,
    manifest,
    display: {
      channel: channel.channel,
      engineCommit: channel.commit,
      minimumLauncherVersion: channel.minimumLauncherVersion,
      cell: manifest.cell,
      baseId: manifest.base.id,
      manifestPath: artifact.path,
    },
  }
}
