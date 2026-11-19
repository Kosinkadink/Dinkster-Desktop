import type { EnvironmentClient, LibraryListKind } from './environment.js'
import { readProjects } from './projects.js'

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
          if (!/^sha256:[a-f0-9]{64}$/.test(id) || !Array.isArray(row['observations']) || !row['observations'].length
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
