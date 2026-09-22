import { execFile, spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)

export type EngineChannel = 'stable' | 'github-live'

export interface EngineEnvironmentRecord {
  readonly baseId: string
  readonly manifestSha256: string
  readonly commit: string
  readonly cell: string
  readonly objects: readonly string[]
}

export interface EngineGeneration {
  readonly generation: number
  readonly current: boolean
  readonly root: string
  readonly engine: EngineEnvironmentRecord | null
  readonly controlPython?: string
  readonly executionPython?: string
}

export interface EngineCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface EngineCliInvocation {
  readonly argv: readonly string[]
}

export type EngineCliRunner = (invocation: EngineCliInvocation) => Promise<EngineCliResult>

export interface EngineServeChild {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  once(event: string, listener: (...args: never[]) => void): unknown
  kill(): boolean | undefined
}

export type EngineCliSpawner = (invocation: EngineCliInvocation) => EngineServeChild

export interface EngineCliOptions {
  readonly executable: string
  readonly run?: EngineCliRunner
  readonly spawn?: EngineCliSpawner
}

export interface EngineInstallRequest {
  readonly root: string
  readonly mirror: string
  readonly channel: EngineChannel
  readonly cell: string
  readonly allowLocalHttp?: boolean
}

export interface EngineActivateRequest {
  readonly root: string
  readonly generation: number
}

export interface EngineServeRequest {
  readonly root: string
  readonly dataRoot: string
  readonly port: number
  readonly instance: string
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const CELL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/
const ERROR_EXCERPT_LIMIT = 2000

const defaultRunner: EngineCliRunner = async ({ argv }) => {
  const executable = argv[0] ?? ''
  const args = argv.slice(1)
  try {
    const { stdout, stderr } = await executeFile(executable, args, {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: Buffer | string
      stderr?: Buffer | string
    }
    if (typeof failure.code === 'string') {
      throw new Error(`could not start ${executable}: ${failure.code}`)
    }
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : -1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    }
  }
}

const defaultSpawner: EngineCliSpawner = ({ argv }) =>
  spawn(argv[0] ?? '', argv.slice(1), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

function errorExcerpt(stderr: string): string {
  const readable = stderr
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
  if (readable.length <= ERROR_EXCERPT_LIMIT) return readable
  return `${readable.slice(-ERROR_EXCERPT_LIMIT)}...`
}

function sameRoot(returned: string, requested: string): boolean {
  if (!isAbsolute(returned)) return false
  const left = resolve(returned)
  const right = resolve(requested)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function parseCliJson(stdout: string, command: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`${command} produced malformed JSON`)
  }
  return parsed
}

function expectString(value: unknown, description: string): string {
  if (typeof value !== 'string') throw new Error(`${description} must be a string`)
  return value
}

function expectDigest(value: unknown, description: string): string {
  const digest = expectString(value, description)
  if (SHA256_PATTERN.test(digest) === false) {
    throw new Error(`${description} must be a lowercase SHA-256 digest`)
  }
  return digest
}

function parseEngineEnvironment(value: unknown): EngineEnvironmentRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('generation engine must be an object')
  }
  const record = value as Record<string, unknown>
  const baseId = expectDigest(record['baseId'], 'generation engine baseId')
  const manifestSha256 = expectDigest(record['manifestSha256'], 'generation engine manifestSha256')
  const commit = expectString(record['commit'], 'generation engine commit')
  if (COMMIT_PATTERN.test(commit) === false) {
    throw new Error('generation engine commit must be a lowercase Git commit identifier')
  }
  const cell = expectString(record['cell'], 'generation engine cell')
  if (CELL_PATTERN.test(cell) === false) {
    throw new Error('generation engine cell must be a platform-accelerator identifier')
  }
  const objects = record['objects']
  if (typeof objects !== 'object' || objects === null || Array.isArray(objects) === false) {
    throw new Error('generation engine objects must be a list of content identifiers')
  }
  const digests = (objects as readonly unknown[]).map((item, index) =>
    expectDigest(item, `generation engine objects[${String(index)}]`),
  )
  if (new Set(digests).size !== digests.length) {
    throw new Error('generation engine objects must be unique content identifiers')
  }
  return { baseId, manifestSha256, commit, cell, objects: digests }
}

function parseInterpreter(value: unknown, description: string): string {
  const path = expectString(value, description)
  if (isAbsolute(path) === false) throw new Error(`${description} must be an absolute path`)
  return path
}

function parseGeneration(value: unknown, requestedRoot: string): EngineGeneration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dinkster generation must be an object')
  }
  const record = value as Record<string, unknown>
  const generation = record['generation']
  if (typeof generation !== 'number' || Number.isInteger(generation) === false || generation < 1) {
    throw new Error('generation must be a positive integer')
  }
  const current = record['current']
  if (typeof current !== 'boolean') throw new Error('generation current must be a boolean')
  const root = expectString(record['root'], 'generation root')
  if (sameRoot(root, requestedRoot) === false) {
    throw new Error(`generation root ${root} does not match the requested root ${requestedRoot}`)
  }
  const engineValue = record['engine']
  if (engineValue !== null && typeof engineValue !== 'object') {
    throw new Error('generation engine must be an object or null')
  }
  const engine = engineValue === null ? null : parseEngineEnvironment(engineValue)
  if (engine === null) {
    if ('controlPython' in record || 'executionPython' in record) {
      throw new Error('generation interpreters require an engine environment')
    }
    return { generation, current, root, engine }
  }
  return {
    generation,
    current,
    root,
    engine,
    controlPython: parseInterpreter(record['controlPython'], 'generation controlPython'),
    executionPython: parseInterpreter(record['executionPython'], 'generation executionPython'),
  }
}

function parseGenerations(value: unknown, requestedRoot: string): EngineGeneration[] {
  if (Array.isArray(value) === false) throw new Error('dinkster generations must be an array')
  return (value as readonly unknown[]).map((item) => parseGeneration(item, requestedRoot))
}

export class EngineCli {
  private readonly executable: string
  private readonly run: EngineCliRunner
  private readonly spawnChild: EngineCliSpawner

  constructor(options: EngineCliOptions) {
    if (typeof options.executable !== 'string' || options.executable.trim() === '') {
      throw new Error('engine bootstrap command is not configured')
    }
    this.executable = options.executable
    this.run = options.run ?? defaultRunner
    this.spawnChild = options.spawn ?? defaultSpawner
  }

  async install(request: EngineInstallRequest): Promise<EngineGeneration> {
    const argv = [
      this.executable,
      'install',
      '--root',
      request.root,
      '--mirror',
      request.mirror,
      '--channel',
      request.channel,
      '--cell',
      request.cell,
      '--stage-only',
      '--json',
    ]
    if (request.allowLocalHttp === true) argv.push('--allow-local-http')
    return this.generationCommand(argv, request.root)
  }

  async activate(request: EngineActivateRequest): Promise<EngineGeneration> {
    const argv = [
      this.executable,
      'activate',
      '--root',
      request.root,
      '--generation',
      String(request.generation),
      '--json',
    ]
    return this.generationCommand(argv, request.root)
  }

  async generations(root: string): Promise<EngineGeneration[]> {
    const result = await this.runCli([
      this.executable,
      'generations',
      '--root',
      root,
      '--json',
    ])
    return parseGenerations(parseCliJson(result.stdout, 'dinkster generations'), root)
  }

  async rollback(root: string): Promise<EngineGeneration> {
    const argv = [this.executable, 'rollback', '--root', root, '--json']
    return this.generationCommand(argv, root)
  }

  serve(request: EngineServeRequest): EngineServeChild {
    if (Number.isInteger(request.port) === false || request.port < 1 || request.port > 65535) {
      throw new Error('serve port must be in 1..65535')
    }
    if (request.instance.trim() === '') throw new Error('serve instance must not be empty')
    return this.spawnChild({
      argv: [
        this.executable,
        'serve',
        '--root',
        request.root,
        '--data-root',
        request.dataRoot,
        '--host',
        '127.0.0.1',
        '--port',
        String(request.port),
        '--instance',
        request.instance,
      ],
    })
  }

  private async generationCommand(argv: readonly string[], root: string): Promise<EngineGeneration> {
    const result = await this.runCli(argv)
    return parseGeneration(parseCliJson(result.stdout, `dinkster ${String(argv[1])}`), root)
  }

  private async runCli(argv: readonly string[]): Promise<EngineCliResult> {
    const result = await this.run({ argv })
    if (result.exitCode !== 0) {
      const excerpt = errorExcerpt(result.stderr || result.stdout)
      throw new Error(
        `${String(argv[1])} failed with exit code ${String(result.exitCode)}${excerpt ? `: ${excerpt}` : ''}`,
      )
    }
    return result
  }
}
