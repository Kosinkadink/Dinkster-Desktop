import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { EnvironmentClient, EnvironmentHistoryEntry, EnvironmentRequest, EnvironmentResult, LibraryListKind, LibraryProject } from './environment.js'
import { readProjects, type DesktopProject } from './projects.js'

export interface LibraryEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface LibraryDisplayPage {
  readonly items: readonly LibraryEntry[]
  readonly cursor: string | null
}

export interface LibraryHistory {
  readonly installation: LibraryEntry
  readonly project: LibraryProject
  readonly environment: NonNullable<EnvironmentResult['environment']>
  readonly entries: readonly EnvironmentHistoryEntry[]
  readonly notices: readonly string[]
}

export interface LibrarySelection {
  readonly installation: DesktopProject
  readonly project: LibraryProject
  readonly environment: NonNullable<EnvironmentResult['environment']>
}

export interface LibraryFork {
  readonly installation: DesktopProject
  readonly destination: string
  readonly retain: () => Promise<void>
}

export interface LibraryRestoreReview {
  readonly token: string
  readonly scope: 'every-project' | 'only-project'
  readonly installation: LibraryEntry
  readonly project: LibraryProject
  readonly entry: number
  readonly projects: readonly LibraryProject[]
  readonly alternatives: readonly {
    readonly snapshot: EnvironmentHistoryEntry['snapshot']
    readonly changes: readonly {
      readonly field: string
      readonly before: readonly string[]
      readonly after: readonly string[]
    }[]
  }[]
  readonly notices: readonly string[]
  readonly expiresInSeconds: number
}

export interface DesktopLibraryBridge {
  reviewRestore(installation: string, project: string, entry: number, scope: 'every-project' | 'only-project'): Promise<LibraryRestoreReview>
  applyRestore(token: string, alternative: number): Promise<void>
  history(installation: string, project: string): Promise<LibraryHistory>
  open(installation: string, project: string): Promise<void>
  installations(): Promise<readonly LibraryEntry[]>
  projects(installation: string, cursor: string | null): Promise<LibraryDisplayPage>
  workflows(installation: string, project: string, cursor: string | null): Promise<LibraryDisplayPage>
  assets(installation: string, project: string, cursor: string | null): Promise<LibraryDisplayPage>
}

const unavailable = 'By the way, these projects and files cannot be shown with the installed tools.'

function restoreDescription(field: string, value: unknown): readonly string[] {
  const invalid = () => new Error('unsupported restore software description')
  const record = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid()
    return item as Record<string, unknown>
  }
  const text = (item: unknown): string => {
    if (typeof item !== 'string' || !/^[A-Za-z0-9_.:+!~,*<>= -]+$/.test(item)) throw invalid()
    return item
  }
  const rows = (item: unknown): unknown[] => {
    if (!Array.isArray(item)) throw invalid()
    return item
  }
  if (!['engine', 'base', 'constraints', 'source', 'inProcessPacks', 'isolatedInferencePacks'].includes(field)
    && !/^metadata\.(dinkster\.lock|packs\/[a-z0-9][a-z0-9_.~-]*\/(pack-lock|installed-wheels)\.json)$/.test(field)) throw invalid()
  if (value === null) return ['Not recorded']
  if (field === 'engine') {
    const engine = record(value)
    return [`Version: ${text(engine['version'])}`, `Release: ${text(engine['release'])}`]
  }
  if (field === 'base') {
    const base = record(value)
    return [`Base: ${text(base['id'])}`, `Variant: ${text(base['variant'])}`]
  }
  if (field === 'constraints') {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw invalid()
    return [value]
  }
  if (field === 'source') {
    if (!['published', 'source', 'local'].includes(String(value))) throw invalid()
    return [String(value)]
  }
  if (field === 'inProcessPacks' || field === 'isolatedInferencePacks') return rows(value).map(text)
  if (typeof value !== 'string') throw invalid()
  // Only software identities leave the host, never acquisition URLs or private source paths.
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw invalid() }
  const document = record(parsed)
  const description = [`Software record SHA-256: ${createHash('sha256').update(value).digest('hex')}`]
  if (field === 'metadata.dinkster.lock' && document['format'] === 'dinkster.lock/1') {
    return [...description, ...rows(document['packs']).map((item) => {
      const pack = record(item)
      return `${text(pack['pack'])} ${text(pack['version'])} (${text(pack['artifactDigest'])})`
    })]
  }
  if (field.endsWith('/pack-lock.json') && ['dinkster.pack-lock/1', 'dinkster.pack-lock/2', 'dinkster.pack-lock/3'].includes(String(document['format']))) {
    return [...description, `Pack: ${text(document['pack'])}`, `Variant: ${text(document['variant'])}`,
      ...(document['part'] === undefined ? [] : [`Part: ${text(document['part'])}`]),
      ...(document['engine'] === undefined ? [] : [`Engine: ${text(document['engine'])}`]),
      ...rows(document['packages']).flatMap((item) => {
        const dependency = record(item)
        return [`${text(dependency['name'])} ${text(dependency['version'])}`, ...rows(dependency['wheels']).map((item) => {
          const wheel = record(item)
          return `${text(wheel['filename'])} (${text(wheel['sha256'])})`
        })]
      })]
  }
  if (field.endsWith('/installed-wheels.json') && document['format'] === 'dinkster.installed-wheels/1') {
    return [...description, ...rows(document['wheels']).map((item) => {
      const wheel = record(item)
      return `${text(wheel['filename'])} (${text(wheel['sha256'])})`
    }), ...rows(document['inherited']).map((name) => `Provided by environment: ${text(name)}`)]
  }
  throw invalid()
}

/** Resolve only saved installations; renderer inputs never choose filesystem paths. */
export class DesktopLibrary {
  private pendingRestore: {
    token: string
    expires: number
    selected: LibrarySelection
    request: EnvironmentRequest
    approvals: readonly string[]
    fork?: LibraryFork
    trusted: () => void
  } | undefined

  constructor(private readonly directory: string, private readonly tools: Pick<EnvironmentClient, 'run'>,
    private readonly restore?: {
      readonly fork: (selected: LibrarySelection) => Promise<LibraryFork>
      readonly activate: (installation: DesktopProject, project: string, result: EnvironmentResult, trusted: () => void, validate: () => Promise<void>) => Promise<void>
    }) {}

  discardRestore(): void {
    this.pendingRestore = undefined
  }

  async reviewRestore(installation: string, identifier: string, entry: number,
    scope: 'every-project' | 'only-project', trusted: () => void): Promise<LibraryRestoreReview> {
    this.discardRestore()
    trusted()
    if (!this.restore || !Number.isSafeInteger(entry) || entry < 1
      || !['every-project', 'only-project'].includes(scope)) throw new Error('invalid software restore review')
    const selected = await this.prepareOpen(installation, identifier)
    const fork = scope === 'only-project' ? await this.restore.fork(selected) : undefined
    const request: EnvironmentRequest = {
      root: selected.installation.root!, channel: selected.installation.channel,
      operation: fork ? 'fork' : 'restore', historyEntry: entry,
      libraryProject: selected.project.id, projectRevision: selected.project.revision, restoreScope: scope,
      ...(fork ? { destination: fork.destination } : {}),
    }
    const result = await this.tools.run(request)
    const plan = result.restorePlan
    const review = plan?.['projectReview'] as { project: LibraryProject; projects: { project: LibraryProject }[] } | undefined
    const alternatives = plan?.['alternatives'] as { approval: string; snapshot: EnvironmentHistoryEntry['snapshot']; substitutions: { field: string; before: unknown; after: unknown }[] }[] | undefined
    if (result.status !== 'approval-required' || !review || !isDeepStrictEqual(review.project, selected.project)
      || !alternatives || !isDeepStrictEqual(await this.prepareOpen(installation, identifier), selected)) {
      throw new Error('project or environment changed; review the restore again')
    }
    const display = alternatives.map((alternative) => {
      const { engine, base } = alternative.snapshot
      if (!engine || !base || ![engine.version, engine.release, base.id, base.variant].every((value) => typeof value === 'string' && value)
        || !alternative.substitutions.every((change) => typeof change.field === 'string' && change.field)) throw new Error('unsupported restore software description')
      return { snapshot: { engine: { version: engine.version, release: engine.release }, base: { id: base.id, variant: base.variant } },
        changes: alternative.substitutions.map((change) => ({ field: change.field,
          before: restoreDescription(change.field, change.before), after: restoreDescription(change.field, change.after) })) }
    })
    trusted()
    const token = randomUUID()
    this.pendingRestore = { token, expires: Date.now() + 900_000, selected, request,
      approvals: alternatives.map((alternative) => alternative.approval), trusted, ...(fork ? { fork } : {}) }
    return { token, scope, installation: { id: selected.installation.id, name: selected.installation.name },
      project: selected.project, entry, projects: scope === 'only-project' ? [selected.project] : review.projects.map((row) => row.project),
      alternatives: display, notices: result.plan.filter((line) => /^(This library requires snapshots with library-helper\/1\.|Snapshot [1-9][0-9]* cannot open this migrated library; choose a snapshot with library helper support\.)$/.test(line)), expiresInSeconds: 900 }
  }

  async applyRestore(token: string, alternative: number, trusted: () => void): Promise<void> {
    const pending = this.pendingRestore
    this.discardRestore()
    trusted()
    if (!this.restore || !pending || pending.token !== token || Date.now() >= pending.expires
      || !Number.isSafeInteger(alternative) || alternative < 0 || alternative >= pending.approvals.length) {
      throw new Error('the restore review expired; review it again')
    }
    pending.trusted()
    const selected = pending.selected
    if (!isDeepStrictEqual(await this.prepareOpen(selected.installation.id, selected.project.id), selected)) {
      throw new Error('project or environment changed; review the restore again')
    }
    trusted()
    pending.trusted()
    await pending.fork?.retain()
    const checked = await this.tools.run({ root: selected.installation.root!, channel: selected.installation.channel,
      operation: 'project-check', libraryProject: selected.project.id })
    if (checked.status !== 'clean' || !isDeepStrictEqual(checked.project, selected.project)
      || !isDeepStrictEqual(checked.environment, selected.environment)) throw new Error('project or environment changed; review the restore again')
    const saved = await readProjects(this.directory)
    if (!isDeepStrictEqual(saved.projects.find((item) => item.id === selected.installation.id), selected.installation)
      || (pending.fork && !isDeepStrictEqual(saved.projects.find((item) => item.id === pending.fork!.installation.id), pending.fork.installation))) {
      throw new Error('saved environments changed; review the restore again')
    }
    trusted()
    pending.trusted()
    if (Date.now() >= pending.expires) throw new Error('the restore review expired; review it again')
    const result = await this.tools.run({ ...pending.request, approval: pending.approvals[alternative]! }, true)
    trusted()
    pending.trusted()
    if (result.status !== 'applied') throw new Error('software restore did not apply; inspect environment status')
    const target = pending.fork?.installation ?? selected.installation
    const opened = await this.prepareOpen(target.id, selected.project.id)
    if (!isDeepStrictEqual(opened.installation, target) || opened.project.uid !== selected.project.uid
      || opened.environment.id !== (pending.fork ? result.environment?.id : selected.environment.id)
      || opened.environment.snapshot !== String(result.current)) throw new Error('restored environment requires readback before opening')
    trusted()
    pending.trusted()
    await this.restore.activate(target, selected.project.id, result, () => { trusted(); pending.trusted() }, async () => {
      trusted()
      pending.trusted()
      if (!isDeepStrictEqual(await this.prepareOpen(target.id, selected.project.id), opened)) {
        throw new Error('restored project or environment changed before activation; inspect environment status')
      }
      trusted()
      pending.trusted()
    })
  }

  async installations(): Promise<readonly LibraryEntry[]> {
    return (await readProjects(this.directory)).projects.filter((project) => project.root !== undefined)
      .map((project) => ({ id: project.id, name: project.name }))
  }

  /** Read-only preparation; callers must repeat it immediately before stopping an owner. */
  async prepareOpen(installation: string, identifier: string): Promise<{
    readonly installation: DesktopProject
    readonly project: LibraryProject
    readonly environment: NonNullable<EnvironmentResult['environment']>
  }> {
    if (typeof installation !== 'string' || typeof identifier !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(identifier)) {
      throw new Error('invalid library selection')
    }
    const saved = await readProjects(this.directory)
    const selected = saved.projects.find((entry) => entry.id === installation)
    if (!selected?.root) throw new Error('no saved local environment')
    const read = (entry: DesktopProject) => this.tools.run({
      root: entry.root!, channel: entry.channel, operation: 'project-get', libraryProject: identifier,
    })
    const initial = await read(selected)
    if (initial.status !== 'clean' || !initial.project) throw new Error('project is unavailable')
    const project = initial.project
    let target = selected
    let candidate = initial.environment
    if (project.environment !== null) {
      const matches: { installation: DesktopProject; result: EnvironmentResult }[] = []
      for (const entry of saved.projects) {
        if (!entry.root) continue
        // An unrelated library may have no such project. Only authoritative readbacks are candidates.
        let result: EnvironmentResult
        try { result = entry.id === selected.id ? initial : await read(entry) }
        catch (error) {
          if (error instanceof Error && ['project is unavailable', 'project library is unavailable'].includes(error.message)) continue
          throw error
        }
        if (result.status !== 'clean' || result.environment?.id !== project.environment.id) continue
        matches.push({ installation: entry, result })
      }
      if (matches.length !== 1) throw new Error('project environment is missing or ambiguous among saved environments')
      const match = matches[0]!
      if (match.result.project?.uid !== project.uid || match.result.project.revision !== project.revision
        || match.result.project.environment?.id !== project.environment.id) throw new Error('project library binding changed')
      target = match.installation
      candidate = match.result.environment
    }
    if (!candidate) throw new Error('environment has no managed identity or active snapshot')
    const checked = await this.tools.run({
      root: target.root!, channel: target.channel, operation: 'project-check', libraryProject: identifier,
    })
    if (checked.status !== 'clean' || checked.project?.uid !== project.uid || checked.project.revision !== project.revision
      || checked.project.environment?.id !== project.environment?.id
      || checked.environment?.id !== candidate.id || checked.environment.snapshot !== candidate.snapshot) {
      throw new Error('project or environment changed; open it again')
    }
    const reread = await read(selected)
    if (reread.project?.uid !== project.uid || reread.project.revision !== project.revision
      || reread.project.environment?.id !== project.environment?.id) throw new Error('project library binding changed')
    if (JSON.stringify(await readProjects(this.directory)) !== JSON.stringify(saved)) throw new Error('saved environments changed; open the project again')
    return { installation: target, project: checked.project, environment: checked.environment }
  }

  async history(installation: string, identifier: string): Promise<LibraryHistory> {
    const selected = await this.prepareOpen(installation, identifier)
    const result = await this.tools.run({
      root: selected.installation.root!, channel: selected.installation.channel, operation: 'history',
    })
    if (result.status !== 'clean' || !result.history || String(result.current) !== selected.environment.snapshot) {
      throw new Error('environment history is unavailable or changed; select the project again')
    }
    if (JSON.stringify(await this.prepareOpen(installation, identifier)) !== JSON.stringify(selected)) {
      throw new Error('project or environment changed; select the project again')
    }
    return {
      installation: { id: selected.installation.id, name: selected.installation.name },
      project: selected.project, environment: selected.environment, notices: result.plan,
      // Snapshots contain private recovery metadata; the renderer receives only display facts.
      entries: result.history.map((entry) => ({
        format: entry.format, id: entry.id, timestamp: entry.timestamp, reason: entry.reason,
        generation: entry.generation, exact: entry.exact,
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        snapshot: {
          engine: { version: entry.snapshot.engine.version, release: entry.snapshot.engine.release },
          base: { id: entry.snapshot.base.id, variant: entry.snapshot.base.variant },
        },
      })),
    }
  }

  projects(installation: string, cursor: string | null): Promise<LibraryDisplayPage> {
    return this.page(installation, 'projects', undefined, cursor)
  }

  workflows(installation: string, project: string, cursor: string | null): Promise<LibraryDisplayPage> {
    return this.page(installation, 'workflows', project, cursor)
  }

  assets(installation: string, project: string, cursor: string | null): Promise<LibraryDisplayPage> {
    return this.page(installation, 'assets', project, cursor)
  }

  private async page(installation: string, kind: LibraryListKind, project: string | undefined, cursor: string | null): Promise<LibraryDisplayPage> {
    try {
      if (typeof installation !== 'string' || (cursor !== null && typeof cursor !== 'string')
        || (kind !== 'projects' && (typeof project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(project)))) throw new Error('invalid library selection')
      const saved = (await readProjects(this.directory)).projects.find((entry) => entry.id === installation)
      if (!saved?.root) throw new Error('no local installation')
      const result = await this.tools.run({ root: saved.root, channel: saved.channel, operation: 'library-list', libraryKind: kind,
        ...(project === undefined ? {} : { libraryProject: project }), ...(cursor === null ? {} : { libraryCursor: cursor }) })
      const page = result.library
      if (result.status !== 'clean' || page?.kind !== kind) throw new Error('unexpected library page')
      const rows = kind === 'projects' ? page.items : kind === 'workflows' ? page.records : page.assets
      if (!rows) throw new Error('missing library page')
      const items = rows.map((row): LibraryEntry => {
        const asset = kind === 'assets' ? row['asset'] as Record<string, unknown> | undefined : undefined
        const id = kind === 'assets' ? asset?.['digest'] : row['id']
        const name = kind === 'assets' ? asset?.['name'] : row['name']
        if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) throw new Error('invalid library entry')
        if (kind === 'projects' && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('invalid project entry')
        if (kind === 'workflows' && (row['scope'] !== 'local' || row['project'] !== project || row['mediaType'] !== 'application/x-dinkster-workflow+json')) throw new Error('wrong workflow scope')
        if (kind === 'assets') {
          if (!/^blake3:[a-f0-9]{64}$/.test(id) || !Array.isArray(row['observations']) || !row['observations'].length
            || !row['observations'].every((value: unknown) => !!value && typeof value === 'object' && (value as Record<string, unknown>)['project'] === project)) throw new Error('wrong asset project')
        }
        return { id, name }
      })
      return { items, cursor: page.cursor }
    } catch {
      throw new Error(unavailable)
    }
  }
}
