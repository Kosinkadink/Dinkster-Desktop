import { execFile } from 'node:child_process'
import { realpath, rm } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, toNamespacedPath } from 'node:path'
import { isIP } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { VariantHardware } from './hardware.js'
import { acquireEnvironmentTools, type EnvironmentToolsInput } from './environment-tools.js'
import { channelTools } from './environment-channel.js'
import { parseDesktopServices } from './services.js'
import { wslLinuxPath, wslLocation, wslWindowsPath, type WslHost } from './wsl.js'

const execute = promisify(execFile)

export type EnvironmentOperation = 'develop' | 'setup' | 'update' | 'rollback' | 'move' | 'doctor' | 'gc' | 'cleanup' | 'start' | 'stop' | 'status' | 'catalog' | 'space' | 'packs-plan' | 'packs-apply' | 'source' | 'restore' | 'library-list' | 'project-get' | 'project-check' | 'project-select'
export type EnvironmentChannel = 'stable' | 'nightly'

export interface DevelopmentSources {
  readonly engine: string
  readonly inference?: string
  readonly helper?: string
  readonly packs: readonly string[]
  readonly frontendRoot?: string
  readonly frontendSource?: string
  readonly frontendDev?: string
  readonly allowFrontendDevRemote?: boolean
}

export type LibraryListKind = 'projects' | 'workflows' | 'assets'

export interface LibraryPage {
  readonly kind: LibraryListKind
  readonly cursor: string | null
  readonly items?: readonly Readonly<Record<string, unknown>>[]
  readonly records?: readonly Readonly<Record<string, unknown>>[]
  readonly assets?: readonly Readonly<Record<string, unknown>>[]
}

export interface LibraryProject {
  readonly id: string
  readonly uid: string
  readonly name: string
  readonly revision: number
  readonly deleted: false
  readonly environment: {
    readonly id: string
    readonly lastSnapshot: string | null
    readonly lastRunAt: string | null
  } | null
}

export interface EnvironmentRequest {
  readonly projectRevision?: number
  readonly libraryKind?: LibraryListKind
  readonly libraryProject?: string
  readonly libraryCursor?: string
  readonly libraryLimit?: number
  readonly development?: DevelopmentSources
  readonly root: string
  readonly operation: EnvironmentOperation
  readonly channel?: EnvironmentChannel
  readonly variant?: string
  readonly mirrors?: readonly string[]
  readonly data?: string
  readonly port?: number
  readonly destination?: string
  readonly repair?: boolean
  readonly sandbox?: boolean
  readonly sandboxPacks?: boolean
  readonly engine?: string
  readonly gpus?: readonly string[]
  readonly packs?: readonly { readonly pack: string; readonly version: string }[]
  readonly inputs?: string
  readonly approval?: string
  readonly packScope?: 'every-project'
  readonly progress?: string
  readonly automaticCleanup?: boolean
  readonly keepPreviousGenerations?: number
  readonly sourceAction?: 'add' | 'update' | 'refs' | 'release'
  readonly sourceTarget?: 'engine' | 'pack' | 'inference' | 'helper' | 'frontend'
  readonly sourceUrl?: string
  readonly sourceName?: string
  readonly sourceRef?: string
  readonly gitMirror?: string
  readonly packageIndex?: string
  readonly sourceApproval?: string
  readonly frontendVersion?: string
  readonly frontendApproval?: string
  readonly historyEntry?: number
}

export interface EnvironmentEngine {
  readonly gpus?: readonly string[]
  readonly sandboxPacks?: boolean
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

export interface EnvironmentSpace {
  readonly format: 'dinkster.space/1'
  readonly observedAt: number
  readonly project: string
  readonly store: string | null
  readonly scope: string
  readonly sharing: string
  readonly complete: boolean
  readonly allocatedBytes: number | null
  readonly observedAllocatedBytes: number
  readonly sharedAllocatedBytes: number | null
  readonly eligibleGenerationReclaimableBytes: number | null
  readonly automaticReclaimableBytes: number | null
  readonly additionalExplicitReclaimableBytes: number | null
  readonly policy: NonNullable<EnvironmentCleanup['policy']>
  readonly settingsCommand: string
  readonly settingsHelp: string
  readonly generations: readonly (EnvironmentCleanup['generations'][number] & { readonly allocationGroup: string })[]
  readonly stores: readonly { readonly allocationGroup: string; readonly label: string; readonly automaticCleanup: false; readonly reasons: readonly string[] }[]
  readonly groups: Readonly<Record<string, { readonly exclusiveAllocatedBytes: number | null; readonly sharedAllocatedBytes: number | null }>>
  readonly warnings: readonly string[]
  readonly cleanupWarnings: readonly string[]
  readonly eligibilityWarnings: readonly string[]
  readonly reclaimabilityWarnings: readonly string[]
}

export interface SandboxReadiness {
  readonly format: 'dinkster.sandbox-readiness/1'
  readonly available: boolean
  readonly detail: string
}

/** Validated command response; WSL filesystem paths use the native host spelling. */
export interface EnvironmentResult {
  readonly project?: LibraryProject
  readonly environment?: { readonly id: string; readonly snapshot: string } | null
  readonly library?: LibraryPage
  readonly sandbox?: SandboxReadiness
  readonly format: 'dinkster.environment-result/1'
  readonly operation: EnvironmentOperation
  readonly sourceDescription?: string
  readonly development?: {
    readonly sources: readonly { readonly kind: string; readonly git?: {
      readonly url: string; readonly requestedRef: string | null; readonly commit: string; readonly subdirectory: string
    } }[]
  }
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
  readonly sourceApproval?: string
  readonly frontendApproval?: string
  readonly restoredFrom?: number
  readonly source?: string
  readonly published?: boolean
  readonly reproducible?: boolean
  readonly sources?: Readonly<Record<string, unknown>>
  readonly frontend?: Readonly<Record<string, unknown>>
  readonly engines?: readonly EnvironmentEngine[]
  readonly cleanup?: EnvironmentCleanup
  readonly cleanupAttempt?: CleanupAttempt
  readonly space?: EnvironmentSpace
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

export function parseDevelopmentSources(value: unknown): DevelopmentSources {
  if (!value || typeof value !== 'object') throw new Error('invalid development sources')
  const row = value as Record<string, unknown>
  const folder = (path: unknown): string => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('development sources need absolute local folders')
    return path
  }
  const source = (value: unknown): string => {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('development sources need absolute local folders or public HTTPS Git URLs')
    if (isAbsolute(value)) return folder(value)
    if (!URL.canParse(value)) throw new Error('development sources need absolute local folders or public HTTPS Git URLs')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || /[\\\s]/.test(value)) throw new Error('Git sources need public HTTPS URLs without credentials or query')
    return value
  }
  if (!Array.isArray(row['packs']) || row['packs'].length > 64) throw new Error('invalid development pack sources')
  const packs = row['packs'].map(source)
  const engine = source(row['engine'])
  const inference = row['inference'] === undefined ? undefined : source(row['inference'])
  const helper = row['helper'] === undefined ? undefined : source(row['helper'])
  const frontendRoot = row['frontendRoot'] === undefined ? undefined : folder(row['frontendRoot'])
  const frontendSource = row['frontendSource'] === undefined ? undefined : source(row['frontendSource'])
  if (frontendSource !== undefined && isAbsolute(frontendSource)) throw new Error('frontend Git source requires a public HTTPS URL')
  let frontendDev: string | undefined
  const allowFrontendDevRemote = row['allowFrontendDevRemote']
  if (allowFrontendDevRemote !== undefined && typeof allowFrontendDevRemote !== 'boolean') throw new Error('invalid remote frontend permission')
  if (row['frontendDev'] !== undefined) {
    if (typeof row['frontendDev'] !== 'string' || /[\\\\\s\x00-\x1f\x7f?#]/.test(row['frontendDev'])) throw new Error('frontend dev server needs an HTTP(S) origin')
    const url = new URL(row['frontendDev'])
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.port === '0') throw new Error('frontend dev server needs a credential-free HTTP(S) origin')
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))
    if (!loopback && allowFrontendDevRemote !== true) throw new Error('non-loopback frontend dev server requires explicit permission')
    frontendDev = url.origin
  } else if (allowFrontendDevRemote === true) throw new Error('remote frontend permission requires a dev server')
  if ([frontendRoot, frontendSource, frontendDev].filter((value) => value !== undefined).length > 1) throw new Error('choose one frontend folder, Git source or dev server')
  return { engine, packs, ...(inference === undefined ? {} : { inference }),
    ...(helper === undefined ? {} : { helper }), ...(frontendRoot === undefined ? {} : { frontendRoot }),
    ...(frontendSource === undefined ? {} : { frontendSource }),
    ...(frontendDev === undefined ? {} : { frontendDev, allowFrontendDevRemote: allowFrontendDevRemote === true }) }
}

function argumentsFor(request: EnvironmentRequest, confirmed: boolean): string[] {
  if (!isAbsolute(request.root)) throw new Error('the project root must be absolute')
  if (['project-get', 'project-check', 'project-select'].includes(request.operation)) {
    const selecting = request.operation === 'project-select'
    if (Object.keys(request).some((key) => !['root', 'operation', 'channel', 'libraryProject', ...(selecting ? ['projectRevision'] : [])].includes(key))
      || (confirmed && !selecting)) throw new Error('project queries accept only an authoritative project selection')
    if (request.channel !== undefined && request.channel !== 'stable' && request.channel !== 'nightly') throw new Error('unsupported channel')
    if (typeof request.libraryProject !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.libraryProject)) throw new Error('invalid library project')
    if (selecting && (!Number.isSafeInteger(request.projectRevision) || request.projectRevision! < 1)) throw new Error('project selection requires its observed revision')
    return ['--root', request.root, request.operation, request.libraryProject,
      ...(selecting ? ['--revision', String(request.projectRevision), confirmed ? '--yes' : '--plan'] : []), '--json']
  }
  if (request.projectRevision !== undefined && request.operation !== 'packs-plan') throw new Error('project revision requires project-select or packs-plan')
  if (request.packScope !== undefined && request.operation !== 'packs-apply') throw new Error('pack scope requires packs-apply')
  if (request.operation === 'library-list') {
    if (confirmed || Object.keys(request).some((key) => !['root', 'operation', 'channel', 'libraryKind', 'libraryProject', 'libraryCursor', 'libraryLimit'].includes(key))) throw new Error('library browsing is read-only')
    if (request.channel !== undefined && request.channel !== 'stable' && request.channel !== 'nightly') throw new Error('unsupported channel')
    if (!request.libraryKind || !['projects', 'workflows', 'assets'].includes(request.libraryKind)) throw new Error('invalid library list')
    if (request.libraryProject !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.libraryProject)) throw new Error('invalid library project')
    if (request.libraryCursor !== undefined && (typeof request.libraryCursor !== 'string' || !request.libraryCursor || request.libraryCursor.length > 16384 || request.libraryCursor.includes('\u0000'))) throw new Error('invalid library cursor')
    if (request.libraryLimit !== undefined && (!Number.isInteger(request.libraryLimit) || request.libraryLimit < 1 || request.libraryLimit > 200)) throw new Error('invalid library page size')
    return ['--root', request.root, 'library-list', request.libraryKind, '--project', request.libraryProject ?? 'default', '--limit', String(request.libraryLimit ?? 50), ...(request.libraryCursor === undefined ? [] : [`--cursor=${request.libraryCursor}`]), '--json']
  }
  if (['libraryKind', 'libraryCursor', 'libraryLimit', ...(request.operation === 'packs-plan' ? [] : ['libraryProject'])].some((key) => request[key as keyof EnvironmentRequest] !== undefined)) throw new Error('library filters require library-list')
  if (!['develop', 'source', 'restore', 'setup', 'update', 'rollback', 'move', 'doctor', 'gc', 'cleanup', 'start', 'stop', 'status', 'catalog', 'space', 'packs-plan', 'packs-apply'].includes(request.operation)) throw new Error('unsupported environment operation')
  if (request.channel !== undefined && request.channel !== 'stable' && request.channel !== 'nightly') throw new Error('unsupported channel')
  const args = ['--root', request.root, request.operation]
  if (request.operation === 'develop') {
    const sources = parseDevelopmentSources(request.development)
    args.push('--source', sources.engine)
    if (isAbsolute(sources.engine)) args.push('--contributor', '--live-engine')
    for (const source of sources.packs) {
      args.push('--pack-source', source)
      if (isAbsolute(source)) args.push('--live-pack', source)
    }
    for (const source of [sources.inference, sources.helper]) if (source !== undefined) {
      args.push('--library-source', source)
      if (isAbsolute(source)) args.push('--live-library', source)
    }
    if (sources.frontendRoot !== undefined) args.push('--frontend-root', sources.frontendRoot)
    if (sources.frontendSource !== undefined) args.push('--frontend-source', sources.frontendSource)
    if (sources.frontendDev !== undefined) args.push('--frontend-dev', sources.frontendDev)
    if (sources.allowFrontendDevRemote === true) args.push('--allow-frontend-dev-remote')
    if (confirmed) {
      if (!request.sourceApproval || !/^sha256:[a-f0-9]{64}$/.test(request.sourceApproval)) throw new Error('development requires the reviewed source approval digest')
      args.push('--approve', request.sourceApproval)
    } else if (request.sourceApproval !== undefined) throw new Error('source approval requires confirmation')
  } else if (request.development !== undefined) throw new Error('development sources require develop')
  const sourceFields = ['sourceAction', 'sourceTarget', 'sourceUrl', 'sourceName', 'sourceRef', 'gitMirror', 'sourceApproval'] as const
  if (request.operation === 'source') {
    if (!request.sourceAction || !['add', 'update', 'refs', 'release'].includes(request.sourceAction)) throw new Error('choose a managed source operation')
    if (['channel', 'variant', 'mirrors', 'data', 'port', 'destination', 'repair', 'engine', 'gpus', 'packs', 'inputs', 'approval', 'progress', 'automaticCleanup', 'keepPreviousGenerations', 'frontendVersion', 'frontendApproval', 'historyEntry'].some((key) => request[key as keyof EnvironmentRequest] !== undefined)) throw new Error('source operations retain current project settings')
    args.push(request.sourceAction)
    if (request.sourceAction === 'add' || request.sourceAction === 'refs') {
      const url = new URL(request.sourceUrl ?? '')
      if (url.protocol !== 'https:' || url.username || url.password || url.search) throw new Error('source URL requires credential-free public HTTPS')
      args.push(request.sourceUrl!)
    } else if (request.sourceUrl !== undefined) throw new Error('only add or refs accepts a source URL')
    if (request.sourceAction === 'release' || request.sourceAction === 'refs') {
      if (request.sourceTarget !== undefined || request.sourceName !== undefined || request.sourceRef !== undefined || request.sourceApproval !== undefined || request.packageIndex !== undefined || (request.sourceAction === 'release' && request.gitMirror !== undefined)) throw new Error('release and refs do not accept source selection inputs')
    } else {
      if (!request.sourceTarget || !['engine', 'pack', 'inference', 'helper', 'frontend'].includes(request.sourceTarget)) throw new Error('choose a managed source target')
      if (request.sourceTarget === 'pack') {
        if (request.sourceName !== undefined && !/^[a-z][a-z0-9-]*$/.test(request.sourceName)) throw new Error('invalid source pack name')
        if (request.sourceAction === 'update' && !request.sourceName) throw new Error('pack update needs its installed name')
        args.push('--pack', ...(request.sourceName ? [request.sourceName] : []))
      } else {
        if (request.sourceName !== undefined) throw new Error('only pack sources accept a pack name')
        if (request.sourceTarget === 'frontend') args.push('--frontend')
        if (request.sourceTarget === 'inference' || request.sourceTarget === 'helper') args.push('--library', request.sourceTarget === 'inference' ? 'dinkster-inference' : 'dinkster-pack-helpers')
      }
      if (request.sourceRef !== undefined) {
        if (!request.sourceRef || request.sourceRef.startsWith('-') || /[\x00-\x1f]/.test(request.sourceRef)) throw new Error('invalid source ref')
        args.push('--ref', request.sourceRef)
      }
      if (confirmed !== (request.sourceApproval !== undefined)) throw new Error('source apply requires the reviewed supervisor approval')
      if (request.sourceApproval !== undefined) {
        if (!/^sha256:[a-f0-9]{64}$/.test(request.sourceApproval)) throw new Error('invalid source approval')
        args.push('--source-approval', request.sourceApproval)
      }
    }
    for (const [flag, value] of [['--git-mirror', request.gitMirror], ['--package-index', request.packageIndex]] as const) {
      if (value !== undefined) {
        if (!value || value.startsWith('-') || /[\x00-\x1f]/.test(value)) throw new Error('invalid source mirror or package index')
        args.push(flag, value)
      }
    }
    return [...args, '--json', ...(request.sourceAction === 'refs' ? [] : [confirmed ? '--yes' : '--plan'])]
  }
  if (sourceFields.some((key) => request[key] !== undefined && !(key === 'sourceApproval' && request.operation === 'develop'))) throw new Error('source selection requires a source operation')
  if (request.historyEntry !== undefined) {
    if (request.operation !== 'restore' || !Number.isSafeInteger(request.historyEntry) || request.historyEntry < 1) throw new Error('restore requires an exact history entry')
    args.push(String(request.historyEntry))
  } else if (request.operation === 'restore') throw new Error('restore requires an exact history entry')
  if (request.frontendVersion !== undefined) {
    if (!['setup', 'update'].includes(request.operation) || !/^[0-9][a-zA-Z0-9.!+_-]*$/.test(request.frontendVersion)) throw new Error('published frontend version requires setup or update')
    if (confirmed !== (request.frontendApproval !== undefined)) throw new Error('frontend apply requires the reviewed supervisor approval')
    args.push('--frontend-version', request.frontendVersion)
    if (request.frontendApproval !== undefined) {
      if (!/^sha256:[a-f0-9]{64}$/.test(request.frontendApproval)) throw new Error('invalid frontend approval')
      args.push('--frontend-approval', request.frontendApproval)
    }
  } else if (request.frontendApproval !== undefined) throw new Error('frontend approval requires a published version')
  if (request.packageIndex !== undefined) {
    if (!['setup', 'update'].includes(request.operation) || !request.packageIndex || request.packageIndex.startsWith('-')) throw new Error('package index requires setup or update')
    args.push('--package-index', request.packageIndex)
  }
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
      if (request.libraryProject !== undefined || request.projectRevision !== undefined) {
        if (typeof request.libraryProject !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.libraryProject)
          || !Number.isSafeInteger(request.projectRevision) || request.projectRevision! < 1) throw new Error('pack planning requires an authoritative project and observed revision')
        args.push('--project', request.libraryProject, '--revision', String(request.projectRevision))
      }
      if (request.progress !== undefined) {
        if (!isAbsolute(request.progress)) throw new Error('pack progress needs an absolute host-owned path')
        args.push('--progress', request.progress)
      }
    } else {
      if (!confirmed || request.progress !== undefined || request.packs !== undefined || !request.approval || !/^sha256:[a-f0-9]{64}$/.test(request.approval)) throw new Error('pack apply needs the confirmed supervisor approval digest')
      args.push('--input', request.inputs, '--approval', request.approval)
      if (request.packScope !== undefined) {
        if (request.packScope !== 'every-project') throw new Error('unsupported pack scope')
        args.push('--scope', request.packScope)
      }
    }
    return [...args, '--json']
  }
  if (request.packs !== undefined || request.inputs !== undefined || request.approval !== undefined || request.progress !== undefined) throw new Error('pack review inputs require a pack operation')
  if (request.automaticCleanup !== undefined) {
    if (request.operation !== 'cleanup' || typeof request.automaticCleanup !== 'boolean') throw new Error('automatic cleanup preference requires cleanup and a boolean')
    args.push('--automatic', request.automaticCleanup ? 'on' : 'off')
  }
  if (request.keepPreviousGenerations !== undefined) {
    if (request.operation !== 'cleanup' || !Number.isSafeInteger(request.keepPreviousGenerations)
      || request.keepPreviousGenerations < 1 || request.keepPreviousGenerations > 100) throw new Error('retained snapshot count requires cleanup and an integer from 1 to 100')
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
  if (request.sandbox !== undefined) {
    if (request.operation !== 'doctor' || typeof request.sandbox !== 'boolean' || request.repair) throw new Error('sandbox readiness requires a read-only doctor query')
    if (request.sandbox) args.push('--sandbox')
  }
  if (request.sandboxPacks !== undefined) {
    if (request.operation !== 'start' || typeof request.sandboxPacks !== 'boolean') throw new Error('pack sandbox selection requires start and a boolean')
    if (request.sandboxPacks) args.push('--sandbox-packs')
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
  if (!['status', 'catalog', 'space'].includes(request.operation) && (request.operation !== 'doctor' || request.repair)) args.push(confirmed ? '--yes' : '--plan')
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

function validSpace(value: unknown, root: string): boolean {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const groups = row['groups'] as Record<string, unknown> | null
  const bytes = (size: unknown): boolean => size === null || (Number.isSafeInteger(size) && Number(size) >= 0)
  const strings = (lines: unknown): boolean => Array.isArray(lines) && lines.every((line) => typeof line === 'string')
  if (row['format'] !== 'dinkster.space/1' || row['project'] !== root
    || !(row['store'] === null || (typeof row['store'] === 'string' && isAbsolute(row['store'])))
    || typeof row['complete'] !== 'boolean' || typeof row['observedAt'] !== 'number' || !Number.isFinite(row['observedAt']) || row['observedAt'] <= 0
    || !['scope', 'sharing', 'settingsCommand', 'settingsHelp'].every((key) => typeof row[key] === 'string')
    || !['allocatedBytes', 'sharedAllocatedBytes', 'eligibleGenerationReclaimableBytes', 'automaticReclaimableBytes', 'additionalExplicitReclaimableBytes'].every((key) => bytes(row[key]))
    || !Number.isSafeInteger(row['observedAllocatedBytes']) || Number(row['observedAllocatedBytes']) < 0
    || !['warnings', 'cleanupWarnings', 'eligibilityWarnings', 'reclaimabilityWarnings'].every((key) => strings(row[key]))
    || !validCleanup({ policy: row['policy'], generations: row['generations'], quarantine: [], warnings: [] }) || !row['policy']
    || !groups || typeof groups !== 'object' || Array.isArray(groups)) return false
  if (!Object.values(groups).every((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const group = entry as Record<string, unknown>
    return bytes(group['exclusiveAllocatedBytes']) && bytes(group['sharedAllocatedBytes'])
  })) return false
  const validGroup = (item: Record<string, unknown>): boolean => typeof item['allocationGroup'] === 'string' && Object.hasOwn(groups, item['allocationGroup'])
  return (row['generations'] as Record<string, unknown>[]).every(validGroup)
    && Array.isArray(row['stores']) && row['stores'].every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Record<string, unknown>
      return validGroup(item) && typeof item['label'] === 'string' && item['automaticCleanup'] === false && strings(item['reasons'])
    })
}

function resultFrom(text: string, request: EnvironmentRequest, confirmed: boolean, distribution?: string): EnvironmentResult {
  const { operation } = request
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('invalid dinkster-env response')
  const row = value as Record<string, unknown>
  if (distribution) {
    const hostPath = (path: unknown): unknown => typeof path === 'string' ? wslWindowsPath(distribution, path) : path
    row['root'] = hostPath(row['root'])
    const packPlan = row['packPlan']
    if (packPlan && typeof packPlan === 'object') {
      const plan = packPlan as Record<string, unknown>
      plan['root'] = hostPath(plan['root'])
    }
    const space = row['space']
    if (space && typeof space === 'object') {
      const measurement = space as Record<string, unknown>
      measurement['project'] = hostPath(measurement['project'])
      measurement['store'] = hostPath(measurement['store'])
    }
  }
  if (row['format'] !== 'dinkster.environment-result/1' || row['operation'] !== operation
    || !['planned', 'applied', 'clean', 'drift', 'error', ...(operation === 'cleanup' ? ['complete', 'deferred', 'disabled', 'coalesced'] : [])].includes(String(row['status']))
    || typeof row['root'] !== 'string' || !isAbsolute(row['root'])
    || !(row['current'] === null || (Number.isInteger(row['current']) && Number(row['current']) > 0))
    || !Array.isArray(row['plan']) || !row['plan'].every((line) => typeof line === 'string')
    || (row['development'] !== undefined && (!row['development'] || typeof row['development'] !== 'object'
      || !Array.isArray((row['development'] as Record<string, unknown>)['sources'])
      || !((row['development'] as Record<string, unknown>)['sources'] as unknown[]).every((entry) => {
        if (!entry || typeof entry !== 'object') return false
        const source = entry as Record<string, unknown>
        if (typeof source['kind'] !== 'string') return false
        if (source['git'] === undefined) return true
        if (!source['git'] || typeof source['git'] !== 'object') return false
        const git = source['git'] as Record<string, unknown>
        return typeof git['url'] === 'string' && typeof git['subdirectory'] === 'string'
          && (git['requestedRef'] === null || typeof git['requestedRef'] === 'string')
          && typeof git['commit'] === 'string' && /^[a-f0-9]{40}$/.test(git['commit'])
      })))
    || (row['url'] !== undefined && typeof row['url'] !== 'string')
    || (row['channel'] !== undefined && row['channel'] !== null && row['channel'] !== 'stable' && row['channel'] !== 'nightly')
    || (row['variant'] !== undefined && row['variant'] !== null && typeof row['variant'] !== 'string')
    || (row['changes'] !== undefined && (!Array.isArray(row['changes']) || !row['changes'].every((line) => typeof line === 'string')))
    || (row['engines'] !== undefined && (!Array.isArray(row['engines']) || !row['engines'].every((engine: unknown) => {
      if (!engine || typeof engine !== 'object') return false
      const entry = engine as Record<string, unknown>
      return typeof entry['name'] === 'string' && Number.isInteger(entry['generation']) && Number(entry['generation']) > 0
        && ['starting', 'ready', 'failed', 'stopped'].includes(String(entry['state']))
        && (entry['url'] === undefined || typeof entry['url'] === 'string')
        && (entry['sandboxPacks'] === undefined || typeof entry['sandboxPacks'] === 'boolean')
        && (entry['gpus'] === undefined || (Array.isArray(entry['gpus']) && entry['gpus'].every((gpu: unknown) => typeof gpu === 'string' && /^(?:\d+|GPU-[a-fA-F0-9-]+)$/.test(gpu))))
    })))
    || (row['error'] !== undefined && typeof row['error'] !== 'string')) {
    throw new Error('unsupported dinkster-env response')
  }
  if (['project-get', 'project-check', 'project-select'].includes(operation) && row['status'] !== 'error') {
    const project = row['project'] as Record<string, unknown> | null | undefined
    const candidate = row['environment'] as Record<string, unknown> | null | undefined
    const binding = project?.['environment'] as Record<string, unknown> | null | undefined
    const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    const expected = operation === 'project-select' ? confirmed ? 'applied' : 'planned' : 'clean'
    if (row['status'] !== expected || !project || Array.isArray(project) || project['id'] !== request.libraryProject
      || !text(project['uid']) || !text(project['name']) || !Number.isSafeInteger(project['revision']) || Number(project['revision']) < 1
      || project['deleted'] !== false || (binding !== null && (!binding || Array.isArray(binding) || !text(binding['id'])
        || !((binding['lastSnapshot'] === null && binding['lastRunAt'] === null) || (text(binding['lastSnapshot']) && text(binding['lastRunAt'])))))
      || (candidate !== null && (!candidate || Array.isArray(candidate) || typeof candidate['id'] !== 'string' || !/^[a-f0-9]{32}$/.test(candidate['id'])
        || typeof candidate['snapshot'] !== 'string' || !/^[1-9][0-9]*$/.test(candidate['snapshot']) || candidate['snapshot'] !== String(row['current'])))
      || (operation !== 'project-get' && candidate === null)
      || (operation === 'project-check' && binding !== null && binding?.['id'] !== candidate?.['id'])
      || (operation === 'project-select' && (confirmed
        ? binding?.['id'] !== candidate?.['id'] || ![request.projectRevision, request.projectRevision! + 1].includes(Number(project['revision']))
        : project['revision'] !== request.projectRevision))) throw new Error('unsupported project selection response')
  }
  if (operation === 'library-list' && row['status'] !== 'error') {
    const page = row['library'] as Record<string, unknown> | undefined
    const key = page?.['kind'] === 'projects' ? 'items' : page?.['kind'] === 'workflows' ? 'records' : page?.['kind'] === 'assets' ? 'assets' : undefined
    if (row['status'] !== 'clean' || !page || !key || !Array.isArray(page[key]) || page[key].length > 200
      || !page[key].every((item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item))
      || !(page['cursor'] === null || (typeof page['cursor'] === 'string' && page['cursor'].length > 0 && page['cursor'].length <= 16384))) throw new Error('unsupported library list response')
  }
  if ((row['sourceDescription'] !== undefined && typeof row['sourceDescription'] !== 'string')
    || (operation === 'develop' && row['status'] === 'planned' && row['sourceApproval'] === undefined)) throw new Error('unsupported development source approval response')
  for (const key of ['sourceApproval', 'frontendApproval']) {
    if (row[key] !== undefined && (typeof row[key] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row[key] as string))) throw new Error('unsupported supervisor source approval')
  }
  if (row['restoredFrom'] !== undefined && (!Number.isSafeInteger(row['restoredFrom']) || Number(row['restoredFrom']) < 1)) throw new Error('unsupported restored history entry')
  for (const key of ['sources', 'frontend']) {
    if (row[key] !== undefined && (!row[key] || typeof row[key] !== 'object' || Array.isArray(row[key]))) throw new Error('unsupported source metadata')
  }
  for (const key of ['published', 'reproducible']) {
    if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new Error('unsupported source disclosure')
  }
  if (row['source'] !== undefined && typeof row['source'] !== 'string') throw new Error('unsupported source kind')
  if ((row['cleanup'] !== undefined && !validCleanup(row['cleanup']))
    || (row['cleanupAttempt'] !== undefined && !validAttempt(row['cleanupAttempt']))) throw new Error('unsupported dinkster-env cleanup response')
  if ((row['space'] !== undefined && !validSpace(row['space'], String(row['root'])))
    || (operation === 'space' && row['status'] !== 'error' && (row['status'] !== 'clean' || row['space'] === undefined))) throw new Error('unsupported dinkster-env space response')
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
  if (row['sandbox'] !== undefined) {
    const sandbox = row['sandbox'] as Record<string, unknown> | null
    if (!sandbox || sandbox['format'] !== 'dinkster.sandbox-readiness/1'
      || typeof sandbox['available'] !== 'boolean' || typeof sandbox['detail'] !== 'string' || !sandbox['detail'].trim()) throw new Error('invalid pack sandbox readiness response')
  }
  return value as EnvironmentResult
}

/** Desktop owns no generation, current, store or journal writes. */
export class EnvironmentClient {
  private readonly tools = new Map<string, ReturnType<typeof acquireEnvironmentTools>>()
  private readonly active = new Set<Promise<EnvironmentResult>>()
  private closed = false
  private readonly services = parseDesktopServices(['--services', process.env['DINKSTER_SERVICES'] ?? 'production'])

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
    private readonly wsl: WslHost | undefined = undefined,
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
    const location = wslLocation(request.root)
    if (location) {
      if (!this.wsl || process.platform !== 'win32' || location.distribution.toLowerCase() !== this.wsl.distribution.toLowerCase()) {
        throw new Error('This WSL project belongs to another Desktop installation')
      }
      const args = commandArgs.map((arg) => isAbsolute(arg) ? wslLinuxPath(this.wsl!.distribution, arg) : arg)
      let stdout: string
      try { stdout = await this.wsl.run(args, selectedTools, this.services) }
      catch (error) {
        const output = (error as { stdout?: string }).stdout
        if (output) {
          const result = resultFrom(output, request, confirmed, this.wsl.distribution)
          throw new Error(result.error ?? result.plan.join('\n'))
        }
        throw error
      }
      const result = resultFrom(stdout, request, confirmed, this.wsl.distribution)
      if (wslLinuxPath(this.wsl.distribution, result.root) !== location.path) throw new Error('dinkster-env returned a different project root')
      if (result.status === 'error') throw new Error(result.error ?? result.plan.join('\n'))
      return { ...result, root: request.root,
        ...(result.packPlan ? { packPlan: { ...result.packPlan, root: request.root } } : {}),
        ...(result.space ? { space: { ...result.space, project: request.root } } : {}) }
    }
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
    const environment: NodeJS.ProcessEnv = { ...process.env, DINKSTER_SERVICES: this.services }
    if (prefix[0] === '-I') {
      if (!isAbsolute(executable)) throw new Error('the tools interpreter must be absolute')
      // Keep system tools such as bubblewrap discoverable, but prefer bundled Python.
      const hostPath = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1]
      for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path' || /^PYTHON/i.test(key)) delete environment[key]
      const toolsPath = [dirname(executable), ...(process.platform === 'win32' ? [join(dirname(executable), 'Scripts')] : [])].join(delimiter)
      environment['PATH'] = hostPath ? `${toolsPath}${delimiter}${hostPath}` : toolsPath
      // Python retains this prefix when loading native extensions from deep caches.
      executable = toNamespacedPath(executable)
    }
    let stdout: string
    const writerDeadline = Date.now() + 30_000
    for (;;) {
      try {
        const result = await execute(executable, args, {
          env: environment,
          windowsHide: true,
          timeout: 30 * 60_000,
          maxBuffer: 4 * 1024 * 1024,
        })
        stdout = result.stdout
        break
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string }
        if (failure.stdout) {
          const result = resultFrom(failure.stdout, request, confirmed)
          // Start rechecks its assignment; sandbox readiness is read-only and
          // can meet a concurrent runtime inspection. Never replay a mutation.
          const retryRoot = confirmed && request.operation === 'start' ? request.root
            : request.operation === 'doctor' && request.sandbox === true ? join(request.root, 'runtime') : undefined
          if (retryRoot !== undefined && result.status === 'error'
            && (result.error === `another environment writer holds ${retryRoot}`
              || result.error?.startsWith(`another environment writer holds ${retryRoot} (operation=`))
            && Date.now() < writerDeadline) {
            await setTimeout(250)
            continue
          }
          throw new Error(result.error ?? ([...result.plan, ...(result.changes ?? [])].join('\n') || `dinkster-env ${request.operation} failed`))
        }
        if (failure.code === 'ENOENT') throw new Error('dinkster-env is not installed. Install the Dinkster environment tools or select their executable.')
        throw new Error(`dinkster-env ${request.operation} did not complete; inspect the project journal.`)
      }
    }
    const result = resultFrom(stdout, request, confirmed)
    if (['library-list', 'project-get', 'project-check', 'project-select'].includes(request.operation) && result.root !== request.root) throw new Error('dinkster-env returned a different project root')
    if (['packs-plan', 'packs-apply', 'source', 'restore'].includes(request.operation)
      && await realpath(result.root) !== await realpath(request.root)) throw new Error('dinkster-env returned a different project root')
    if (result.status === 'error') throw new Error(result.error ?? result.plan.join('\n'))
    return result
  }
}
