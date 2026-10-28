import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import { validProjectId } from './window-layout.js'
import type { EnvironmentChannel } from './environment.js'

export type ProjectEngine =
  | { readonly id: string; readonly name: string; readonly kind: 'local'; readonly gpus: readonly string[]; readonly port?: number }
  | { readonly id: string; readonly name: string; readonly kind: 'remote'; readonly url: string }

export interface DesktopProject {
  readonly id: string
  readonly name: string
  readonly channel: EnvironmentChannel
  readonly root?: string
  readonly engines: readonly ProjectEngine[]
}

export interface DesktopProjects {
  readonly version: 1
  readonly projects: readonly DesktopProject[]
}

export function serverUrl(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('a server address must be HTTP(S), without credentials, query or fragment')
  }
  return url.toString().replace(/\/$/, '')
}

export function parseProject(value: unknown): DesktopProject {
  if (!value || typeof value !== 'object') throw new Error('invalid Desktop project')
  const row = value as Record<string, unknown>
  if (!validProjectId(row['id']) || typeof row['name'] !== 'string' || !row['name'].trim()
    || row['name'].length > 128 || (row['channel'] !== 'stable' && row['channel'] !== 'main')
    || !Array.isArray(row['engines']) || row['engines'].length === 0) throw new Error('invalid Desktop project')
  const engines: ProjectEngine[] = row['engines'].map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid engine binding')
    const engine = entry as Record<string, unknown>
    if (!validProjectId(engine['id']) || typeof engine['name'] !== 'string' || !engine['name'].trim()
      || engine['name'].length > 128) throw new Error('invalid engine binding')
    const common = { id: engine['id'], name: engine['name'].trim() }
    if (engine['kind'] === 'remote' && typeof engine['url'] === 'string') {
      return { ...common, kind: 'remote', url: serverUrl(engine['url']) }
    }
    if (engine['kind'] === 'local' && Array.isArray(engine['gpus'])
      && engine['gpus'].every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length < 512)
      && new Set(engine['gpus']).size === engine['gpus'].length) {
      const port = engine['port']
      if (port !== undefined && (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('invalid engine port')
      return { ...common, kind: 'local', gpus: [...engine['gpus']] as string[], ...(port === undefined ? {} : { port: port as number }) }
    }
    throw new Error('invalid engine binding')
  })
  if (new Set(engines.map((engine) => engine.id)).size !== engines.length) throw new Error('duplicate engine id')
  const localEngines = engines.filter((engine) => engine.kind === 'local')
  if (localEngines.slice(1).some((engine) => engine.port === undefined)) throw new Error('additional local engines need explicit ports')
  const ports = localEngines.flatMap((engine) => engine.port === undefined ? [] : [engine.port])
  if (new Set(ports).size !== ports.length) throw new Error('local engine ports must be distinct')
  const hasLocal = engines.some((engine) => engine.kind === 'local')
  if (hasLocal && (typeof row['root'] !== 'string' || !isAbsolute(row['root']))) throw new Error('a local project needs an absolute install root')
  if (!hasLocal && row['root'] !== undefined) throw new Error('a remote-only project has no local install root')
  return {
    id: row['id'], name: row['name'].trim(), channel: row['channel'], engines,
    ...(hasLocal ? { root: resolve(row['root'] as string) } : {}),
  }
}

function parseProjects(value: unknown): DesktopProjects {
  if (!value || typeof value !== 'object') throw new Error('invalid Desktop project list')
  const row = value as Record<string, unknown>
  if (row['version'] !== 1 || !Array.isArray(row['projects'])) throw new Error('unsupported Desktop project list')
  const projects = row['projects'].map(parseProject)
  if (new Set(projects.map((project) => project.id)).size !== projects.length) throw new Error('duplicate project id')
  const roots = projects.flatMap((project) => project.root === undefined ? [] : [
    process.platform === 'win32' ? project.root.toLowerCase() : project.root,
  ])
  if (new Set(roots).size !== roots.length) throw new Error('an install root already belongs to another project')
  return { version: 1, projects }
}

export async function readProjects(directory: string): Promise<DesktopProjects> {
  let text: string
  try { text = await readFile(join(directory, 'projects.json'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: [] }
    throw error
  }
  return parseProjects(JSON.parse(text))
}

export async function writeProjects(directory: string, value: DesktopProjects): Promise<void> {
  await writeFileAtomic(join(directory, 'projects.json'), `${JSON.stringify(parseProjects(value), null, 2)}\n`)
}

export function saveProject(projects: DesktopProjects, value: unknown): DesktopProjects {
  const project = parseProject(value)
  return parseProjects({ version: 1, projects: [...projects.projects.filter((entry) => entry.id !== project.id), project] })
}
