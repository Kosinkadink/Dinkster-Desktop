import { execFile } from 'node:child_process'
import { realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, toNamespacedPath } from 'node:path'
import { promisify } from 'node:util'
import type { VariantHardware } from './hardware.js'
import { acquireEnvironmentTools, type EnvironmentToolsInput } from './environment-tools.js'
import { channelTools } from './environment-channel.js'

const execute = promisify(execFile)

export type EnvironmentOperation = 'setup' | 'update' | 'rollback' | 'move' | 'doctor' | 'gc' | 'cleanup' | 'start' | 'stop' | 'status' | 'catalog' | 'packs-plan' | 'packs-apply'
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
  readonly packs?: readonly { readonly pack: string; readonly version: string }[]
  readonly inputs?: string
  readonly approval?: string
  readonly automaticCleanup?: boolean
  readonly keepPreviousGenerations?: number
}

export interface EnvironmentEngine {
  readonly name: string
  readonly generation: number
  readonly state: 'starting' | 'ready' | 'failed' | 'stopped'
  readonly url?: string
}

export interface CleanupAttempt {
  readonly status: 'complete' | 'deferred' | 'disabled' | 'coalesced'
  readonly warnings?: readonly string[]
}

export interface EnvironmentCleanup {
  readonly policy?: { readonly automatic: boolean; readonly previousSuccessfulActivations: number; readonly minimumAgeSeconds: number }
  readonly generations: readonly { readonly generation: number; readonly status: 'retained' | 'candidate' | 'deferred'; readonly reasons: readonly string[] }[]
  readonly quarantine: readonly { readonly journal: string; readonly stage: string; readonly generations: readonly number[] }[]
  readonly warnings: readonly string[]
  readonly lastAttempt?: CleanupAttempt
}

/** The command owner's dinkster.environment-result/1 response, unchanged. */
export interface EnvironmentResult {
  readonly format: 'dinkster.environment-result/1'
  readonly operation: EnvironmentOperation
  readonly status: 'planned' | 'applied' | 'clean' | 'drift' | 'error' | CleanupAttempt['status']
  readonly root: string
  readonly current: number | null
  readonly plan: readonly string[]
  readonly url?: string
  readonly changes?: readonly string[]
  readonly error?: string
  readonly packPlan?: Readonly<Record<string, unknown>>
  readonly approval?: string
  readonly expiresInSeconds?: number
  readonly engines?: readonly EnvironmentEngine[]
  readonly cleanup?: EnvironmentCleanup
  readonly cleanupAttempt?: CleanupAttempt
  readonly channel?: EnvironmentChannel | null
  readonly variant?: string | null
  readonly base?: {
    readonly variant: string
    readonly origin: 'published' | 'user-defined'
    readonly torchVersion: string | null
    readonly torchIndex: string | null
    readonly label?: string | null
  }
  readonly engine?: {
    readonly release: string
    readonly version: string
    readonly label: string | null
  }
  readonly variants?: readonly {
    readonly variant: string
    readonly base: string
    readonly manifest: VariantHardware & { readonly format: 'dinkster.base/1'; readonly id: string }
    readonly downloadBytes: number
  }[]
}

function argumentsFor(request: EnvironmentRequest, confirmed: boolean): string[] {
  if (!isAbsolute(request.root)) throw new Error('the project root must be absolute')
  if (!['setup', 'update', 'rollback', 'move', 'doctor', 'gc', 'cleanup', 'start', 'stop', 'status', 'catalog', 'packs-plan', 'packs-apply'].includes(request.operation)) throw new Error('unsupported environment operation')
  if (request.channel !== undefined && request.channel !== 'stable' && request.channel !== 'main') throw new Error('unsupported channel')
  const args = ['--root', request.root, request.operation]
  if (request.operation === 'packs-plan' || request.operation === 'packs-apply') {
    if (!request.inputs || !isAbsolute(request.inputs)) throw new Error('pack installation needs an absolute host-owned review directory')
    if (['channel', 'variant', 'mirrors', 'data', 'port', 'destination', 'repair', 'engine', 'gpus', 'automaticCleanup', 'keepPreviousGenerations'].some((key) => request[key as keyof EnvironmentRequest] !== undefined)) {
      throw new Error('pack installation retains the current project software settings')
    }
    if (request.operation === 'packs-plan') {
      if (confirmed || request.approval !== undefined || !request.packs || request.packs.length < 1 || request.packs.length > 64) throw new Error('pack planning needs unconfirmed exact selections')
      const names = new Set<string>()
      for (const { pack, version } of request.packs) {
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pack) || !version || !/^[a-zA-Z0-9][a-zA-Z0-9.+!-]*$/.test(version) || names.has(pack)) throw new Error('invalid or repeated exact pack selection')
        names.add(pack)
        args.push(`${pack}@${version}`)
      }
      args.push('--output', request.inputs)
    } else {
      if (!confirmed || request.packs !== undefined || !request.approval || !/^sha256:[a-f0-9]{64}$/.test(request.approval)) throw new Error('pack apply needs the confirmed supervisor approval digest')
      args.push('--input', request.inputs, '--approval', request.approval)
    }
    return [...args, '--json']
  }
  if (request.packs !== undefined || request.inputs !== undefined || request.approval !== undefined) throw new Error('pack review inputs require a pack operation')
  if (request.automaticCleanup !== undefined) {
    if (request.operation !== 'cleanup' || typeof request.automaticCleanup !== 'boolean') throw new Error('automatic cleanup preference requires cleanup and a boolean')
    args.push('--automatic', request.automaticCleanup ? 'on' : 'off')
  }
  if (request.keepPreviousGenerations !== undefined) {
    if (request.operation !== 'cleanup' || !Number.isSafeInteger(request.keepPreviousGenerations)
      || request.keepPreviousGenerations < 1 || request.keepPreviousGenerations > 100) throw new Error('retained generation count requires cleanup and an integer from 1 to 100')
    args.push('--keep-previous', String(request.keepPreviousGenerations))
  }
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

function validAttempt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return ['complete', 'deferred', 'disabled', 'coalesced'].includes(String(row['status']))
    && (row['warnings'] === undefined || (Array.isArray(row['warnings']) && row['warnings'].every((warning) => typeof warning === 'string')))
}

function validCleanup(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const policy = row['policy'] as Record<string, unknown> | undefined
  return (policy === undefined || (!!policy && typeof policy['automatic'] === 'boolean'
    && Number(policy['previousSuccessfulActivations']) >= 1 && Number(policy['previousSuccessfulActivations']) <= 100
    && ['previousSuccessfulActivations', 'minimumAgeSeconds'].every((key) => Number.isSafeInteger(policy[key]) && Number(policy[key]) >= 0)))
    && Array.isArray(row['warnings']) && row['warnings'].every((warning) => typeof warning === 'string')
    && Array.isArray(row['generations']) && row['generations'].every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Record<string, unknown>
      return Number.isSafeInteger(item['generation']) && Number(item['generation']) > 0
        && ['retained', 'candidate', 'deferred'].includes(String(item['status']))
        && Array.isArray(item['reasons']) && item['reasons'].every((reason) => typeof reason === 'string')
    })
    && Array.isArray(row['quarantine']) && row['quarantine'].every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Record<string, unknown>
      return typeof item['journal'] === 'string' && typeof item['stage'] === 'string'
        && Array.isArray(item['generations']) && item['generations'].every((number) => Number.isSafeInteger(number) && number > 0)
    })
    && (row['lastAttempt'] === undefined || validAttempt(row['lastAttempt']))
}

function resultFrom(text: string, operation: EnvironmentOperation): EnvironmentResult {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('invalid dinkster-env response')
  const row = value as Record<string, unknown>
  if (row['format'] !== 'dinkster.environment-result/1' || row['operation'] !== operation
    || !['planned', 'applied', 'clean', 'drift', 'error', ...(operation === 'cleanup' ? ['complete', 'deferred', 'disabled', 'coalesced'] : [])].includes(String(row['status']))
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
  if ((row['cleanup'] !== undefined && !validCleanup(row['cleanup']))
    || (row['cleanupAttempt'] !== undefined && !validAttempt(row['cleanupAttempt']))) throw new Error('unsupported dinkster-env cleanup response')
  if (row['base'] !== undefined) {
    const base = row['base'] as Record<string, unknown> | null
    if (!base || typeof base !== 'object' || typeof base['variant'] !== 'string'
      || (base['origin'] !== 'published' && base['origin'] !== 'user-defined')
      || !(base['torchVersion'] === null || typeof base['torchVersion'] === 'string')
      || !(base['torchIndex'] === null || typeof base['torchIndex'] === 'string')
      || !(base['label'] === undefined || base['label'] === null || (typeof base['label'] === 'string' && base['label'].length > 0))) {
      throw new Error('unsupported dinkster-env base response')
    }
  }
  if (row['engine'] !== undefined) {
    const engine = row['engine'] as Record<string, unknown> | null
    if (!engine || typeof engine !== 'object'
      || typeof engine['release'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(engine['release'])
      || typeof engine['version'] !== 'string' || !engine['version']
      || !(engine['label'] === null || (typeof engine['label'] === 'string' && engine['label'].length > 0))) {
      throw new Error('unsupported dinkster-env engine response')
    }
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
      if (!platform || !(
        (['windows', 'linux'].includes(String(platform['os'])) && platform['arch'] === 'x86_64')
        || (platform['os'] === 'macos' && platform['arch'] === 'arm64')
      )) return false
      const nvidia = manifest['nvidia'] as Record<string, unknown> | null | undefined
      return nvidia === null || (!!nvidia && ['minimumDriver', 'minimumComputeCapability', 'maximumExclusiveComputeCapability'].every((key) =>
        (key === 'maximumExclusiveComputeCapability' && nvidia[key] === null)
        || (typeof nvidia[key] === 'string' && /^\d+(\.\d+)*$/.test(nvidia[key]))))
    })) throw new Error('unsupported dinkster-env catalog response')
  }
  if (operation === 'packs-plan' && row['status'] !== 'error') {
    const plan = row['packPlan'] as Record<string, unknown> | null
    if (row['status'] !== 'planned' || row['current'] === null || !plan || typeof plan !== 'object' || Array.isArray(plan)
      || plan['format'] !== 'dinkster.project-pack-plan/1' || plan['root'] !== row['root'] || plan['current'] !== row['current']
      || typeof row['approval'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row['approval']) || row['expiresInSeconds'] !== 900) {
      throw new Error('unsupported dinkster-env pack plan response')
    }
  }
  if (operation === 'packs-apply' && row['status'] !== 'error'
    && (row['status'] !== 'applied' || row['current'] === null || !Array.isArray(row['engines']))) {
    throw new Error('unsupported dinkster-env pack activation response')
  }
  return value as EnvironmentResult
}

/** Desktop owns no generation, current, store or journal writes. */
export class EnvironmentClient {
  private readonly tools = new Map<string, ReturnType<typeof acquireEnvironmentTools>>()
  private readonly active = new Set<Promise<EnvironmentResult>>()
  private closed = false

  constructor(
    private readonly executable = process.env['DINKSTER_TOOLS_PYTHON'] ?? process.env['DINKSTER_ENV'] ?? 'dinkster-env',
    private readonly prefix: readonly string[] = process.env['DINKSTER_TOOLS_PYTHON'] ? ['-I', '-m', 'dinkster_supervisor.environment'] : [],
    private readonly toolsInput: EnvironmentToolsInput | undefined = !process.env['DINKSTER_TOOLS_PYTHON'] && !process.env['DINKSTER_ENV'] && process.env['DINKSTER_TOOLS_MANIFEST'] ? {
      manifest: process.env['DINKSTER_TOOLS_MANIFEST'],
      sha256: process.env['DINKSTER_TOOLS_MANIFEST_SHA256'] ?? process.env['DINKSTER_TOOLS_SHA256'] ?? '',
      release: process.env['DINKSTER_TOOLS_RELEASE'] ?? '',
    } : undefined,
    private readonly bundledTools: EnvironmentToolsInput | undefined = undefined,
    private readonly desktopVersion: string | undefined = undefined,
  ) {}

  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.active])
    for (const pending of this.tools.values()) {
      const tools = await pending.catch(() => undefined)
      if (tools && !tools.persistent) await rm(tools.directory, { recursive: true, force: true })
    }
    this.tools.clear()
  }

  run(request: EnvironmentRequest, confirmed = false): Promise<EnvironmentResult> {
    if (this.closed) return Promise.reject(new Error('the environment client is closed'))
    const pending = this.executeRequest(request, confirmed)
    this.active.add(pending)
    const finished = (): void => { this.active.delete(pending) }
    void pending.then(finished, finished)
    return pending
  }

  private async executeRequest(request: EnvironmentRequest, confirmed: boolean): Promise<EnvironmentResult> {
    const commandArgs = argumentsFor(request, confirmed)
    let executable = this.executable
    let prefix = this.prefix
    const selectedTools = this.desktopVersion ? await channelTools(request, this.desktopVersion) : undefined
    const toolsInput = this.toolsInput ?? (this.executable === 'dinkster-env' && !process.env['DINKSTER_ENV'] && !process.env['DINKSTER_TOOLS_PYTHON'] ? selectedTools ?? this.bundledTools : undefined)
    if (toolsInput) {
      const key = JSON.stringify(toolsInput)
      let pending = this.tools.get(key)
      if (!pending) {
        pending = acquireEnvironmentTools(toolsInput).catch((error: unknown) => { this.tools.delete(key); throw error })
        this.tools.set(key, pending)
      }
      executable = (await pending).python
      prefix = ['-I', '-m', 'dinkster_supervisor.environment']
    }
    const args = [...prefix, ...commandArgs]
    const environment = { ...process.env }
    if (prefix[0] === '-I') {
      if (!isAbsolute(executable)) throw new Error('the tools interpreter must be absolute')
      // Engine descendants must not inherit host Python configuration either.
      for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path' || /^PYTHON/i.test(key)) delete environment[key]
      environment['PATH'] = process.platform === 'win32' ? join(dirname(executable), 'Scripts') : dirname(executable)
      // Python retains this prefix when loading native extensions from deep caches.
      executable = toNamespacedPath(executable)
    }
    let stdout: string
    try {
      const result = await execute(executable, args, {
        env: environment,
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
    if ((request.operation === 'packs-plan' || request.operation === 'packs-apply')
      && await realpath(result.root) !== await realpath(request.root)) throw new Error('dinkster-env returned a different project root')
    if (result.status === 'error') throw new Error(result.error ?? result.plan.join('\n'))
    return result
  }
}
