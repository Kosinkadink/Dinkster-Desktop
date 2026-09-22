import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import { validProjectId } from './window-layout.js'

/**
 * Persistent registry binding Desktop project ids to Dinkster engine installs.
 *
 * Every project id accepted by the shell (including 'default') binds to
 * exactly one absolute Dinkster install root and exactly one release channel
 * ('stable' or 'github-live'). The binding is one-to-one: an install root
 * serves at most one project, so two projects can never share a root and one
 * project can never list two roots. The registry owns no user data paths,
 * discovers nothing on disk, and performs no installs; it is only the
 * durable source of truth that later integration layers consult.
 */

export const PROJECT_REGISTRY_VERSION = 1

export type ProjectChannel = 'stable' | 'github-live'

export interface DesktopProjectBinding {
  readonly projectId: string
  /** Absolute path to the Dinkster install root this project launches. */
  readonly installRoot: string
  readonly channel: ProjectChannel
}

export interface ProjectRegistry {
  readonly version: typeof PROJECT_REGISTRY_VERSION
  readonly projects: readonly DesktopProjectBinding[]
}

const registryPath = (dataDirectory: string): string => join(dataDirectory, 'project-bindings.json')

export function emptyProjectRegistry(): ProjectRegistry {
  return { version: PROJECT_REGISTRY_VERSION, projects: [] }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function decodeChannel(value: unknown): ProjectChannel | undefined {
  return value === 'stable' || value === 'github-live' ? value : undefined
}

function decodeInstallRoot(value: unknown): string | undefined {
  // Anchored in the persisted file itself: a relative entry would resolve
  // against whatever directory the shell happens to start in.
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return undefined
  return resolve(value)
}

/**
 * Normalizes install roots before comparison so equivalent spellings of one
 * path cannot be recorded as two distinct bindings. Windows paths are
 * case-insensitive, so their casing is folded too.
 */
function normalizeInstallRoot(root: string): string {
  const resolved = resolve(root)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function sameInstallRoot(left: string, right: string): boolean {
  return normalizeInstallRoot(left) === normalizeInstallRoot(right)
}

export function decodeProjectBinding(value: unknown): DesktopProjectBinding | undefined {
  const row = record(value)
  if (!row) return undefined
  const projectId = row['projectId']
  if (!validProjectId(projectId)) return undefined
  const installRoot = decodeInstallRoot(row['installRoot'])
  if (!installRoot) return undefined
  const channel = decodeChannel(row['channel'])
  if (!channel) return undefined
  return { projectId, installRoot, channel }
}

export function decodeProjectRegistry(value: unknown): ProjectRegistry | undefined {
  const root = record(value)
  if (!root || root['version'] !== PROJECT_REGISTRY_VERSION || !Array.isArray(root['projects'])) return undefined
  const seenIds = new Set<string>()
  const seenRoots: string[] = []
  const projects: DesktopProjectBinding[] = []
  for (const entry of root['projects']) {
    const binding = decodeProjectBinding(entry)
    if (!binding) return undefined
    if (seenIds.has(binding.projectId)) return undefined
    if (seenRoots.some((existing) => sameInstallRoot(existing, binding.installRoot))) return undefined
    seenIds.add(binding.projectId)
    seenRoots.push(binding.installRoot)
    projects.push(binding)
  }
  return { version: PROJECT_REGISTRY_VERSION, projects }
}

/**
 * Adds or replaces one project binding. Rejects ids or channels that are not
 * valid, relative install roots, and a root already bound to a different
 * project. Rebinding a project to its current root is allowed.
 */
export function upsertProjectBinding(
  registry: ProjectRegistry,
  binding: DesktopProjectBinding,
): ProjectRegistry {
  if (!validProjectId(binding.projectId)) throw new Error(`invalid project id: ${JSON.stringify(binding.projectId)}`)
  if (!decodeChannel(binding.channel)) throw new Error(`invalid project channel: ${JSON.stringify(binding.channel)}`)
  const installRoot = decodeInstallRoot(binding.installRoot)
  if (!installRoot) {
    throw new Error(`project ${binding.projectId} needs an absolute install root, got: ${binding.installRoot}`)
  }
  const conflict = registry.projects.find((existing) =>
    existing.projectId !== binding.projectId && sameInstallRoot(existing.installRoot, installRoot))
  if (conflict) {
    throw new Error(`install root ${installRoot} is already bound to project ${conflict.projectId}`)
  }
  const projects = registry.projects.filter((existing) => existing.projectId !== binding.projectId)
  projects.push({ projectId: binding.projectId, installRoot, channel: binding.channel })
  projects.sort((left, right) => left.projectId.localeCompare(right.projectId))
  return { version: PROJECT_REGISTRY_VERSION, projects }
}

export function getProjectBinding(
  registry: ProjectRegistry,
  projectId: string,
): DesktopProjectBinding | undefined {
  return registry.projects.find((existing) => existing.projectId === projectId)
}

export function listProjectBindings(registry: ProjectRegistry): readonly DesktopProjectBinding[] {
  return registry.projects
}

/**
 * Reads the persisted registry. Missing, corrupt, or structurally invalid
 * data - including duplicate ids or one root bound twice - falls back to an
 * empty registry rather than trusting anything the file claims.
 */
export async function readProjectRegistry(dataDirectory: string): Promise<ProjectRegistry> {
  try {
    return decodeProjectRegistry(JSON.parse(await readFile(registryPath(dataDirectory), 'utf8')))
      ?? emptyProjectRegistry()
  } catch {
    return emptyProjectRegistry()
  }
}

export async function writeProjectRegistry(dataDirectory: string, registry: ProjectRegistry): Promise<void> {
  const validated = decodeProjectRegistry(registry)
  if (!validated) throw new Error('cannot persist an invalid project registry')
  await writeFileAtomic(registryPath(dataDirectory), `${JSON.stringify(validated, null, 2)}\n`)
}
