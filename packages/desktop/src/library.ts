import type { EnvironmentClient, EnvironmentResult, LibraryListKind, LibraryProject } from './environment.js'
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

export interface DesktopLibraryBridge {
  installations(): Promise<readonly LibraryEntry[]>
  projects(installation: string, cursor: string | null): Promise<LibraryDisplayPage>
  workflows(installation: string, project: string, cursor: string | null): Promise<LibraryDisplayPage>
  assets(installation: string, project: string, cursor: string | null): Promise<LibraryDisplayPage>
}

const unavailable = 'By the way, these projects and files cannot be shown with the installed tools.'

/** Resolve only saved installations; renderer inputs never choose filesystem paths. */
export class DesktopLibrary implements DesktopLibraryBridge {
  constructor(private readonly directory: string, private readonly tools: Pick<EnvironmentClient, 'run'>) {}

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
