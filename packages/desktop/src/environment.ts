import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export type EnvironmentOperation = 'setup' | 'update' | 'rollback' | 'move' | 'doctor' | 'gc'
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
  readonly changes?: unknown
  readonly error?: string
}

function argumentsFor(request: EnvironmentRequest, confirmed: boolean): string[] {
  if (!isAbsolute(request.root)) throw new Error('the project root must be absolute')
  if (!['setup', 'update', 'rollback', 'move', 'doctor', 'gc'].includes(request.operation)) throw new Error('unsupported environment operation')
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
  args.push('--json')
  if (request.operation !== 'doctor' || request.repair) args.push(confirmed ? '--yes' : '--plan')
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
    || (row['error'] !== undefined && typeof row['error'] !== 'string')) {
    throw new Error('unsupported dinkster-env response')
  }
  return value as EnvironmentResult
}

/** Desktop owns no generation, current, store or journal writes. */
export class EnvironmentClient {
  constructor(
    private readonly executable = process.env['DINKSTER_ENV'] ?? 'dinkster-env',
    private readonly prefix: readonly string[] = [],
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
        if (result.status === 'error') throw new Error(result.error ?? result.plan.join('\n'))
      }
      if (failure.code === 'ENOENT') throw new Error('dinkster-env is not installed. Install the Dinkster environment tools or select their executable.')
      throw new Error(`dinkster-env ${request.operation} did not complete; inspect the project journal.`)
    }
    const result = resultFrom(stdout, request.operation)
    if (result.status === 'error') throw new Error(result.error ?? result.plan.join('\n'))
    return result
  }
}
