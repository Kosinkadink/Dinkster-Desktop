import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { VariantHardware } from './hardware.js'

const execute = promisify(execFile)

export type EnvironmentOperation = 'setup' | 'update' | 'rollback' | 'move' | 'doctor' | 'gc' | 'start' | 'stop' | 'status' | 'catalog'
export type EnvironmentChannel = 'stable' | 'main'

export interface EnvironmentRequest {
  readonly root: string
  readonly operation: EnvironmentOperation
  readonly channel?: EnvironmentChannel
  readonly variant?: string
  readonly mirrors?: readonly string[]
  readonly data?: string
  readonly port?: number
  readonly destination?: string
  readonly repair?: boolean
  readonly engine?: string
  readonly gpus?: readonly string[]
}

export interface EnvironmentEngine {
  readonly name: string
  readonly generation: number
  readonly state: 'starting' | 'ready' | 'failed' | 'stopped'
  readonly url?: string
}

/** The command owner's dinkster.environment-result/1 response, unchanged. */
export interface EnvironmentResult {
  readonly format: 'dinkster.environment-result/1'
  readonly operation: EnvironmentOperation
  readonly status: 'planned' | 'applied' | 'clean' | 'drift' | 'error'
  readonly root: string
  readonly current: number | null
  readonly plan: readonly string[]
  readonly url?: string
  readonly changes?: readonly string[]
  readonly error?: string
  readonly engines?: readonly EnvironmentEngine[]
  readonly channel?: EnvironmentChannel | null
  readonly variant?: string | null
  readonly variants?: readonly {
    readonly variant: string
    readonly base: string
    readonly manifest: VariantHardware & { readonly format: 'dinkster.base/1'; readonly id: string }
    readonly downloadBytes: number
  }[]
}

function argumentsFor(request: EnvironmentRequest, confirmed: boolean): string[] {
  if (!isAbsolute(request.root)) throw new Error('the project root must be absolute')
  if (!['setup', 'update', 'rollback', 'move', 'doctor', 'gc', 'start', 'stop', 'status', 'catalog'].includes(request.operation)) throw new Error('unsupported environment operation')
  if (request.channel !== undefined && request.channel !== 'stable' && request.channel !== 'main') throw new Error('unsupported channel')
  const args = ['--root', request.root, request.operation]
  if (request.operation === 'move') {
    if (!request.destination || !isAbsolute(request.destination)) throw new Error('move needs an absolute destination root')
    args.push(request.destination)
  }
  if (request.channel !== undefined) args.push('--channel', request.channel)
  if (request.variant !== undefined) {
    if (!/^[a-z][a-z0-9-]*$/.test(request.variant)) throw new Error('invalid environment variant')
    args.push('--variant', request.variant)
  }
  for (const mirror of request.mirrors ?? []) {
    if (!mirror || mirror.startsWith('-')) throw new Error('invalid mirror')
    args.push('--mirror', mirror)
  }
  if (request.data !== undefined) {
    if (!isAbsolute(request.data)) throw new Error('the wheel store path must be absolute')
    args.push('--data', request.data)
  }
  if (request.port !== undefined) {
    if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) throw new Error('invalid supervisor port')
    args.push('--port', String(request.port))
  }
  if (request.repair) args.push('--repair')
  if (request.engine !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.engine)) throw new Error('invalid engine name')
    args.push('--engine', request.engine)
  }
  for (const gpu of request.gpus ?? []) {
    if (!/^(?:\d+|GPU-[a-fA-F0-9-]+)$/.test(gpu)) throw new Error('invalid GPU device')
    args.push('--gpu', gpu)
  }
  args.push('--json')
  if (!['status', 'catalog'].includes(request.operation) && (request.operation !== 'doctor' || request.repair)) args.push(confirmed ? '--yes' : '--plan')
  return args
}

function resultFrom(text: string, operation: EnvironmentOperation): EnvironmentResult {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('invalid dinkster-env response')
  const row = value as Record<string, unknown>
  if (row['format'] !== 'dinkster.environment-result/1' || row['operation'] !== operation
    || !['planned', 'applied', 'clean', 'drift', 'error'].includes(String(row['status']))
    || typeof row['root'] !== 'string' || !isAbsolute(row['root'])
    || !(row['current'] === null || (Number.isInteger(row['current']) && Number(row['current']) > 0))
    || !Array.isArray(row['plan']) || !row['plan'].every((line) => typeof line === 'string')
    || (row['url'] !== undefined && typeof row['url'] !== 'string')
    || (row['channel'] !== undefined && row['channel'] !== null && row['channel'] !== 'stable' && row['channel'] !== 'main')
    || (row['variant'] !== undefined && row['variant'] !== null && typeof row['variant'] !== 'string')
    || (row['changes'] !== undefined && (!Array.isArray(row['changes']) || !row['changes'].every((line) => typeof line === 'string')))
    || (row['engines'] !== undefined && (!Array.isArray(row['engines']) || !row['engines'].every((engine: unknown) => {
      if (!engine || typeof engine !== 'object') return false
      const entry = engine as Record<string, unknown>
      return typeof entry['name'] === 'string' && Number.isInteger(entry['generation']) && Number(entry['generation']) > 0
        && ['starting', 'ready', 'failed', 'stopped'].includes(String(entry['state']))
        && (entry['url'] === undefined || typeof entry['url'] === 'string')
    })))
    || (row['error'] !== undefined && typeof row['error'] !== 'string')) {
    throw new Error('unsupported dinkster-env response')
  }
  if (operation === 'catalog' && row['status'] !== 'error') {
    if (row['status'] !== 'clean' || !Array.isArray(row['variants']) || !row['variants'].every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false
      const candidate = entry as Record<string, unknown>
      const manifest = candidate['manifest'] as Record<string, unknown> | undefined
      if (!manifest || manifest['format'] !== 'dinkster.base/1'
        || typeof candidate['variant'] !== 'string' || manifest['variant'] !== candidate['variant']
        || typeof candidate['base'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(candidate['base'])
        || manifest['id'] !== candidate['base']
        || !Number.isSafeInteger(candidate['downloadBytes']) || Number(candidate['downloadBytes']) < 0) return false
      const platform = manifest['platform'] as Record<string, unknown> | undefined
      if (!platform || !['windows', 'linux'].includes(String(platform['os'])) || platform['arch'] !== 'x86_64') return false
      const nvidia = manifest['nvidia'] as Record<string, unknown> | null | undefined
      return nvidia === null || (!!nvidia && ['minimumDriver', 'minimumComputeCapability', 'maximumExclusiveComputeCapability'].every((key) =>
        (key === 'maximumExclusiveComputeCapability' && nvidia[key] === null)
        || (typeof nvidia[key] === 'string' && /^\d+(\.\d+)*$/.test(nvidia[key]))))
    })) throw new Error('unsupported dinkster-env catalog response')
  }
  return value as EnvironmentResult
}

/** Desktop owns no generation, current, store or journal writes. */
export class EnvironmentClient {
  constructor(
    private readonly executable = process.env['DINKSTER_TOOLS_PYTHON'] ?? process.env['DINKSTER_ENV'] ?? 'dinkster-env',
    private readonly prefix: readonly string[] = process.env['DINKSTER_TOOLS_PYTHON'] ? ['-m', 'dinkster_supervisor.environment'] : [],
  ) {}

  async run(request: EnvironmentRequest, confirmed = false): Promise<EnvironmentResult> {
    const args = [...this.prefix, ...argumentsFor(request, confirmed)]
    let stdout: string
    try {
      const result = await execute(this.executable, args, {
        windowsHide: true,
        timeout: 30 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      stdout = result.stdout
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string }
      if (failure.stdout) {
        const result = resultFrom(failure.stdout, request.operation)
        throw new Error(result.error ?? ([...result.plan, ...(result.changes ?? [])].join('\n') || `dinkster-env ${request.operation} failed`))
      }
      if (failure.code === 'ENOENT') throw new Error('dinkster-env is not installed. Install the Dinkster environment tools or select their executable.')
      throw new Error(`dinkster-env ${request.operation} did not complete; inspect the project journal.`)
    }
    const result = resultFrom(stdout, request.operation)
    if (result.status === 'error') throw new Error(result.error ?? result.plan.join('\n'))
    return result
  }
}
