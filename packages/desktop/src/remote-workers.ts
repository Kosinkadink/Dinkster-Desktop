import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parse, parseDocument as parseTomlDocument, patch } from '@decimalturn/toml-patch'
import { recoverInterruptedAtomicWrite, writeFileAtomic } from './atomic-file.js'
import type {
  DesktopRemoteWorker,
  DesktopRemoteWorkerFileChoice,
  DesktopRemoteWorkerMemory,
} from './types.js'

type TomlRecord = Record<string, unknown>
type RemoteWorkerFileKind = 'token' | 'tls-ca'

interface RemoteWorkerFileGrant {
  readonly windowId: string
  readonly kind: RemoteWorkerFileKind
  readonly path: string
}

interface CstLocation {
  readonly start: { readonly line: number }
  readonly end: { readonly line: number }
}

interface CstBlock {
  readonly type: string
  readonly loc: CstLocation
  readonly key?: {
    readonly value?: readonly string[]
    readonly item?: { readonly value?: readonly string[] }
  }
  readonly items?: readonly CstBlock[]
}

const WORKER_KEYS = new Set([
  'endpoint',
  'token_file',
  'tls_ca_file',
  'nodes',
  'trust_reserved',
  'memory',
])

// Python str.isspace() is Unicode White_Space plus four information separators.
const BACKEND_WHITESPACE = /[\u001c-\u001f]|\p{White_Space}/u

function isRecord(value: unknown): value is TomlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: TomlRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasBackendWhitespace(value: string): boolean {
  return BACKEND_WHITESPACE.test(value)
}

function assertWorkerName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || hasBackendWhitespace(name) || name.includes('@')) {
    throw new Error("worker names must be non-empty and contain no whitespace or '@'")
  }
  if (name.toLowerCase() === 'local') throw new Error("worker name 'local' is reserved")
}

function assertEndpoint(endpoint: unknown): asserts endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('worker address must be a HOST:PORT value')
  }
  const separator = endpoint.lastIndexOf(':')
  const host = endpoint.slice(0, separator)
  const portText = endpoint.slice(separator + 1)
  const port = Number(portText)
  if (!host || !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('worker address must end with a port from 1 to 65535')
  }
}

function assertPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty path`)
}

function assertNodes(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((node) => typeof node === 'string' && node.length > 0)) {
    throw new Error('node allowlist must contain only non-empty node type names')
  }
}

function validMemorySize(value: unknown): value is string | number | bigint {
  if (typeof value === 'bigint') return value >= 0n
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  return typeof value === 'string' && /^\d+[kKmMgGtT]?$/.test(value.trim())
}

function memoryEntries(value: unknown): DesktopRemoteWorkerMemory[] {
  if (!isRecord(value)) throw new Error('worker memory must be a table of device names and sizes')
  const result: DesktopRemoteWorkerMemory[] = []
  for (const [device, size] of Object.entries(value)) {
    if (!device || hasBackendWhitespace(device) || device.includes('@')) {
      throw new Error("memory device names must be non-empty and contain no whitespace or '@'")
    }
    if (!validMemorySize(size)) {
      throw new Error(`memory size for '${device}' must be integer bytes or use a K, M, G, or T suffix`)
    }
    result.push({ device, size: String(size) })
  }
  return result
}

function decodeWorkers(document: unknown): DesktopRemoteWorker[] {
  if (!isRecord(document)) throw new Error('remotes.toml must contain a TOML table')
  const unknownTop = Object.keys(document).filter((key) => key !== 'worker')
  if (unknownTop.length > 0) throw new Error(`remotes.toml has unknown top-level keys: ${unknownTop.join(', ')}`)
  const workersValue = document['worker'] ?? Object.create(null)
  if (!isRecord(workersValue)) throw new Error('remotes.toml worker entry must be a table')

  return Object.entries(workersValue).map(([name, value]) => {
    assertWorkerName(name)
    if (!isRecord(value)) throw new Error(`worker '${name}' must be a table`)
    const unknown = Object.keys(value).filter((key) => !WORKER_KEYS.has(key))
    if (unknown.length > 0) throw new Error(`worker '${name}' has unknown keys: ${unknown.join(', ')}`)
    assertEndpoint(value['endpoint'])
    assertPath(value['token_file'], `token file for '${name}'`)
    const tlsCaFile = value['tls_ca_file']
    if (tlsCaFile !== undefined) assertPath(tlsCaFile, `TLS CA file for '${name}'`)
    const nodes = value['nodes']
    if (nodes !== undefined) assertNodes(nodes)
    const trustReserved = value['trust_reserved'] ?? false
    if (typeof trustReserved !== 'boolean') throw new Error(`reserved-namespace trust for '${name}' must be true or false`)
    return {
      name,
      endpoint: value['endpoint'],
      tokenFile: value['token_file'],
      ...(tlsCaFile === undefined ? {} : { tlsCaFile }),
      ...(nodes === undefined ? {} : { nodes }),
      memory: memoryEntries(value['memory'] ?? Object.create(null)),
    }
  })
}

function parseDocument(source: string): TomlRecord {
  try {
    const document: unknown = parse(source)
    decodeWorkers(document)
    return document as TomlRecord
  } catch (error) {
    throw new Error(`Cannot manage remotes.toml: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function workersFromSource(source: string): readonly DesktopRemoteWorker[] {
  return source ? decodeWorkers(parseDocument(source)) : []
}

async function readSource(dataDirectory: string): Promise<string> {
  const path = join(dataDirectory, 'library', 'remotes.toml')
  await recoverInterruptedAtomicWrite(path)
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await recoverInterruptedAtomicWrite(path)
    try {
      return await readFile(path, 'utf8')
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw retryError
    }
  }
}

function parseInput(value: unknown): DesktopRemoteWorker {
  if (!isRecord(value)) throw new Error('remote worker details are malformed')
  const name = value['name']
  const endpoint = value['endpoint']
  const tokenFile = value['tokenFile']
  const tlsCaFile = value['tlsCaFile']
  const nodes = value['nodes']
  const memory = value['memory']
  assertWorkerName(name)
  assertEndpoint(endpoint)
  assertPath(tokenFile, 'token file')
  if (tlsCaFile !== undefined) assertPath(tlsCaFile, 'TLS CA file')
  if (nodes !== undefined) assertNodes(nodes)
  if (!Array.isArray(memory)) throw new Error('memory budgets must be a list')
  const seenDevices = new Set<string>()
  const parsedMemory = memory.map((entry): DesktopRemoteWorkerMemory => {
    if (!isRecord(entry) || typeof entry['device'] !== 'string' || typeof entry['size'] !== 'string') {
      throw new Error('each memory budget needs a device and size')
    }
    const device = entry['device']
    const size = entry['size'].trim()
    if (!device || hasBackendWhitespace(device) || device.includes('@')) {
      throw new Error("memory device names must be non-empty and contain no whitespace or '@'")
    }
    if (!/^\d+[kKmMgGtT]?$/.test(size)) {
      throw new Error(`memory size for '${device}' must be integer bytes or use a K, M, G, or T suffix`)
    }
    if (seenDevices.has(device)) throw new Error(`memory device '${device}' is listed more than once`)
    seenDevices.add(device)
    return { device, size }
  })
  return {
    name,
    endpoint,
    tokenFile,
    ...(tlsCaFile === undefined ? {} : { tlsCaFile }),
    ...(nodes === undefined ? {} : { nodes }),
    memory: parsedMemory,
  }
}

export class RemoteWorkerFileGrants {
  private readonly grants = new Map<string, RemoteWorkerFileGrant>()

  issue(windowId: string, kind: RemoteWorkerFileKind, path: string): DesktopRemoteWorkerFileChoice {
    for (const [id, grant] of this.grants) {
      if (grant.windowId === windowId && grant.kind === kind) this.grants.delete(id)
    }
    const grant = randomUUID()
    this.grants.set(grant, { windowId, kind, path })
    return { path, grant }
  }

  authorize(
    windowId: string,
    value: unknown,
    currentWorkers: readonly DesktopRemoteWorker[],
  ): { readonly worker: DesktopRemoteWorker; readonly grants: readonly string[] } {
    const worker = parseInput(value)
    const metadata = value as TomlRecord
    const current = currentWorkers.find((candidate) => candidate.name === worker.name)
    const transportChanged = current !== undefined
      && (worker.endpoint !== current.endpoint || worker.tlsCaFile !== current.tlsCaFile)
    const grants: string[] = []
    const authorizePath = (
      kind: RemoteWorkerFileKind,
      path: string,
      grantValue: unknown,
      currentPath: string | undefined,
    ): void => {
      if (path === currentPath) return
      if (typeof grantValue !== 'string') {
        throw new Error(`Choose the ${kind === 'token' ? 'token' : 'TLS certificate or CA'} file again before saving`)
      }
      const grant = this.grants.get(grantValue)
      if (!grant || grant.windowId !== windowId || grant.kind !== kind || grant.path !== path) {
        throw new Error(`The selected ${kind === 'token' ? 'token' : 'TLS certificate or CA'} file is no longer authorized`)
      }
      grants.push(grantValue)
    }
    authorizePath('token', worker.tokenFile, metadata['tokenFileGrant'], transportChanged ? undefined : current?.tokenFile)
    if (worker.tlsCaFile !== undefined) {
      authorizePath('tls-ca', worker.tlsCaFile, metadata['tlsCaFileGrant'], transportChanged ? undefined : current?.tlsCaFile)
    }
    return { worker, grants }
  }

  consume(grants: readonly string[]): void {
    for (const grant of grants) this.grants.delete(grant)
  }

  revokeWindow(windowId: string): void {
    for (const [id, grant] of this.grants) {
      if (grant.windowId === windowId) this.grants.delete(id)
    }
  }
}

export class RemoteWorkerLifecycle {
  constructor(
    private readonly dataDirectory: string,
    private readonly grants: RemoteWorkerFileGrants,
    private readonly serialize: <T>(action: () => Promise<T>) => Promise<T>,
    private readonly assertCompatible: () => void,
    private readonly restart: () => Promise<void>,
  ) {}

  list(): Promise<readonly DesktopRemoteWorker[]> {
    return this.serialize(() => listRemoteWorkers(this.dataDirectory))
  }

  save(windowId: string, value: unknown): Promise<void> {
    return this.serialize(async () => {
      this.assertCompatible()
      const source = await readSource(this.dataDirectory)
      const current = workersFromSource(source)
      const authorized = this.grants.authorize(windowId, value, current)
      await saveRemoteWorkerFromSource(this.dataDirectory, authorized.worker, source)
      this.grants.consume(authorized.grants)
      await this.restart()
    })
  }

  remove(name: unknown): Promise<void> {
    return this.serialize(async () => {
      this.assertCompatible()
      await removeRemoteWorker(this.dataDirectory, name)
      await this.restart()
    })
  }
}

async function assertExistingFile(path: string, label: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  try {
    await access(path, constants.R_OK)
    if (!(await stat(path)).isFile()) throw new Error(`${label} is not a file`)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} is not a file`) throw error
    throw new Error(`${label} cannot be read`)
  }
}

function memoryRecord(entries: readonly DesktopRemoteWorkerMemory[]): TomlRecord {
  const memory = Object.create(null) as TomlRecord
  for (const { device, size } of entries) {
    memory[device] = /^\d+$/.test(size) ? BigInt(size) : size.toUpperCase()
  }
  return memory
}

function sameMemory(current: unknown, entries: readonly DesktopRemoteWorkerMemory[]): boolean {
  if (!isRecord(current) || Object.keys(current).length !== entries.length) return false
  return entries.every(({ device, size }) => hasOwn(current, device) && String(current[device]).toLowerCase() === size.toLowerCase())
}

function sameWorker(actual: DesktopRemoteWorker, expected: DesktopRemoteWorker): boolean {
  const actualNodes = actual.nodes ?? []
  const expectedNodes = expected.nodes ?? []
  const actualMemory = new Map(actual.memory.map(({ device, size }) => [device, size.toLowerCase()]))
  return actual.name === expected.name
    && actual.endpoint === expected.endpoint
    && actual.tokenFile === expected.tokenFile
    && actual.tlsCaFile === expected.tlsCaFile
    && (actual.nodes === undefined) === (expected.nodes === undefined)
    && actualNodes.length === expectedNodes.length
    && actualNodes.every((node, index) => node === expectedNodes[index])
    && actualMemory.size === expected.memory.length
    && expected.memory.every(({ device, size }) => actualMemory.get(device) === size.toLowerCase())
}

function removeWorkerSource(source: string, name: string): string {
  const lines = [0]
  for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) {
    lines.push(index + 1)
  }
  const blocks = parseTomlDocument(source).cst as unknown as readonly CstBlock[]
  const ranges: { start: number; end: number }[] = []
  const addRange = (block: CstBlock): void => {
    let startLine = block.loc.start.line - 1
    while (startLine > 0) {
      const previousStart = lines[startLine - 1]!
      const previousEnd = lines[startLine]! - 1
      if (!/^\s*#/.test(source.slice(previousStart, previousEnd))) break
      startLine -= 1
    }
    const contentEndLine = block.type === 'Table'
      ? block.items?.filter((item) => item.type !== 'Comment').at(-1)?.loc.end.line ?? block.loc.start.line
      : block.loc.end.line
    ranges.push({
      start: lines[startLine]!,
      end: lines[contentEndLine] ?? source.length,
    })
  }
  const keyPath = (block: CstBlock): readonly string[] | undefined => block.key?.item?.value ?? block.key?.value
  const target = (path: readonly string[] | undefined, prefix: readonly string[]): boolean =>
    path !== undefined && prefix.every((part, index) => path[index] === part)
  for (const block of blocks) {
    const tablePath = keyPath(block)
    if (block.type === 'Table' && target(tablePath, ['worker', name])) {
      addRange(block)
      continue
    }
    if (block.type === 'Table' && tablePath?.length === 1 && tablePath[0] === 'worker') {
      for (const item of block.items ?? []) {
        if (item.type === 'KeyValue' && target(keyPath(item), [name])) addRange(item)
      }
      continue
    }
    if (block.type === 'KeyValue' && target(keyPath(block), ['worker', name])) addRange(block)
  }
  if (ranges.length === 0) throw new Error(`Cannot remove worker '${name}' from its TOML layout`)
  ranges.sort((left, right) => right.start - left.start)
  let updated = source
  for (const range of ranges) updated = `${updated.slice(0, range.start)}${updated.slice(range.end)}`
  return updated
}

export async function listRemoteWorkers(dataDirectory: string): Promise<readonly DesktopRemoteWorker[]> {
  const source = await readSource(dataDirectory)
  return workersFromSource(source)
}

export async function saveRemoteWorker(dataDirectory: string, value: unknown): Promise<void> {
  const input = parseInput(value)
  const source = await readSource(dataDirectory)
  await saveRemoteWorkerFromSource(dataDirectory, input, source)
}

async function saveRemoteWorkerFromSource(
  dataDirectory: string,
  input: DesktopRemoteWorker,
  source: string,
): Promise<void> {
  await assertExistingFile(input.tokenFile, 'token file')
  if (input.tlsCaFile !== undefined) await assertExistingFile(input.tlsCaFile, 'TLS CA file')

  const document = source ? parseDocument(source) : Object.create(null) as TomlRecord
  const workers = isRecord(document['worker']) ? document['worker'] : Object.create(null) as TomlRecord
  const currentValue = workers[input.name]
  const current: TomlRecord | undefined = isRecord(currentValue) ? currentValue : undefined
  const next: TomlRecord = current ?? Object.create(null) as TomlRecord
  next['endpoint'] = input.endpoint
  next['token_file'] = input.tokenFile
  if (input.tlsCaFile === undefined) delete next['tls_ca_file']
  else next['tls_ca_file'] = input.tlsCaFile
  if (input.nodes === undefined) delete next['nodes']
  else next['nodes'] = [...input.nodes]
  if (!sameMemory(next['memory'], input.memory)) next['memory'] = memoryRecord(input.memory)
  if (input.memory.length === 0) delete next['memory']
  Object.defineProperty(workers, input.name, { value: next, enumerable: true, configurable: true, writable: true })
  document['worker'] = workers

  const updated = patch(source, document, { inlineTableStart: 3 })
  const saved = decodeWorkers(parseDocument(updated)).find((worker) => worker.name === input.name)
  if (!saved || !sameWorker(saved, input)) throw new Error('remotes.toml update could not be verified')
  await writeFileAtomic(join(dataDirectory, 'library', 'remotes.toml'), updated, source)
}

export async function removeRemoteWorker(dataDirectory: string, name: unknown): Promise<void> {
  assertWorkerName(name)
  const source = await readSource(dataDirectory)
  if (!source) return
  const document = parseDocument(source)
  const workers = document['worker'] as TomlRecord
  if (!hasOwn(workers, name)) return
  const expected = decodeWorkers(document).filter((worker) => worker.name !== name)
  const updated = removeWorkerSource(source, name)
  const remaining = decodeWorkers(parseDocument(updated))
  if (remaining.some((worker) => worker.name === name)
    || remaining.length !== expected.length
    || !remaining.every((worker, index) => sameWorker(worker, expected[index]!))) {
    throw new Error('remotes.toml removal could not be verified')
  }
  await writeFileAtomic(join(dataDirectory, 'library', 'remotes.toml'), updated, source)
}
