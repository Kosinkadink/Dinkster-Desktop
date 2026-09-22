import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeProjectRegistry, emptyProjectRegistry, getProjectBinding, listProjectBindings,
  readProjectRegistry, upsertProjectBinding, writeProjectRegistry,
} from '../src/project-registry.js'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dinkster-project-registry-'))
  temporaryDirectories.push(path)
  return path
}

const alpha = { projectId: 'p-alpha', installRoot: '/opt/dinkster/installs/main', channel: 'stable' } as const
const beta = { projectId: 'p-beta', installRoot: '/opt/dinkster/installs/second', channel: 'github-live' } as const

describe('project registry', () => {
  it('round-trips bindings through the persisted file', async () => {
    const directory = await temporaryDirectory()
    await writeProjectRegistry(directory, upsertProjectBinding(emptyProjectRegistry(), alpha))
    await writeProjectRegistry(directory, upsertProjectBinding(await readProjectRegistry(directory), beta))

    const registry = await readProjectRegistry(directory)
    expect(listProjectBindings(registry)).toEqual([
      { ...alpha, installRoot: '/opt/dinkster/installs/main' },
      { ...beta, installRoot: '/opt/dinkster/installs/second' },
    ])
    expect(getProjectBinding(registry, 'p-beta')).toEqual({ ...beta, installRoot: '/opt/dinkster/installs/second' })
    expect(getProjectBinding(registry, 'missing')).toBeUndefined()
    const raw = JSON.parse(await readFile(join(directory, 'project-bindings.json'), 'utf8'))
    expect(raw.version).toBe(1)
  })

  it('keeps two projects on distinct roots and channels', () => {
    const registry = upsertProjectBinding(upsertProjectBinding(emptyProjectRegistry(), alpha), beta)
    expect(getProjectBinding(registry, 'p-alpha')).toMatchObject({ installRoot: alpha.installRoot, channel: 'stable' })
    expect(getProjectBinding(registry, 'p-beta')).toMatchObject({ installRoot: beta.installRoot, channel: 'github-live' })
  })

  it('treats the default project id as a valid binding key', () => {
    const registry = upsertProjectBinding(
      emptyProjectRegistry(),
      { projectId: 'default', installRoot: '/opt/dinkster/installs/main', channel: 'stable' },
    )
    expect(getProjectBinding(registry, 'default')?.channel).toBe('stable')
  })

  it('updates an existing id in place without duplicating it', () => {
    const registry = upsertProjectBinding(upsertProjectBinding(emptyProjectRegistry(), alpha),
      { ...alpha, channel: 'github-live' })
    expect(listProjectBindings(registry)).toHaveLength(1)
    expect(getProjectBinding(registry, 'p-alpha')?.channel).toBe('github-live')
  })

  it('rejects a root already bound to a different project', () => {
    const registry = upsertProjectBinding(emptyProjectRegistry(), alpha)
    expect(() => upsertProjectBinding(registry, { ...beta, installRoot: alpha.installRoot }))
      .toThrow('already bound to project p-alpha')
  })

  it('accepts equivalent root spellings for the same project but not across projects', () => {
    const registry = upsertProjectBinding(emptyProjectRegistry(), alpha)
    expect(() => upsertProjectBinding(registry, { ...beta, installRoot: '/opt/dinkster/installs/./main' }))
      .toThrow('already bound')
    const rebound = upsertProjectBinding(registry, { ...alpha, installRoot: '/opt/dinkster/installs/./main' })
    expect(getProjectBinding(rebound, 'p-alpha')?.installRoot).toBe('/opt/dinkster/installs/main')
  })

  it('rejects invalid project ids', () => {
    for (const projectId of ['', 'UPPER', 'has space', 'x'.repeat(65), 'p_alpha', 7, null]) {
      expect(() => upsertProjectBinding(emptyProjectRegistry(), {
        projectId: projectId as string, installRoot: alpha.installRoot, channel: 'stable',
      })).toThrow('invalid project id')
    }
  })

  it('rejects channels outside stable and github-live', () => {
    for (const channel of ['beta', 'latest', 'stable ', '', 7, null]) {
      expect(() => upsertProjectBinding(emptyProjectRegistry(), {
        projectId: 'p-alpha', installRoot: alpha.installRoot, channel: channel as 'stable',
      })).toThrow('invalid project channel')
    }
  })

  it('rejects relative install roots', () => {
    expect(() => upsertProjectBinding(emptyProjectRegistry(),
      { projectId: 'p-alpha', installRoot: 'installs/main', channel: 'stable' })).toThrow('absolute install root')
    expect(() => upsertProjectBinding(emptyProjectRegistry(),
      { projectId: 'p-alpha', installRoot: '', channel: 'stable' })).toThrow('absolute install root')
  })

  it('falls back to an empty registry for missing, corrupt, or malformed data', async () => {
    const directory = await temporaryDirectory()
    expect(await readProjectRegistry(directory)).toEqual(emptyProjectRegistry())
    await writeFile(join(directory, 'project-bindings.json'), '{broken')
    expect(await readProjectRegistry(directory)).toEqual(emptyProjectRegistry())

    const badDocuments = [
      { version: 2, projects: [] },
      { version: 1, projects: 'nope' },
      { version: 1, projects: [{ projectId: 'p-alpha' }] },
      { version: 1, projects: [{ ...alpha, installRoot: 'relative/root' }] },
      { version: 1, projects: [{ ...alpha, channel: 'beta' }] },
      { version: 1, projects: [alpha, alpha] },
      { version: 1, projects: [alpha, { ...beta, installRoot: alpha.installRoot }] },
      [alpha],
    ]
    for (const document of badDocuments) {
      await writeFile(join(directory, 'project-bindings.json'), JSON.stringify(document))
      expect(await readProjectRegistry(directory)).toEqual(emptyProjectRegistry())
    }
  })

  it('decodes valid persisted data and rejects whole documents with any invalid entry', () => {
    expect(decodeProjectRegistry({ version: 1, projects: [alpha, beta] })).toEqual({
      version: 1, projects: [alpha, beta],
    })
    expect(decodeProjectRegistry({ version: 1, projects: [alpha, { ...beta, projectId: 'UPPER' }] })).toBeUndefined()
    expect(decodeProjectRegistry(undefined)).toBeUndefined()
  })

  it('refuses to persist a registry that does not decode', async () => {
    await expect(writeProjectRegistry('/unused', {
      version: 1, projects: [{ ...alpha, installRoot: 'relative/root' }],
    })).rejects.toThrow('cannot persist an invalid project registry')
    await expect(writeProjectRegistry('/unused', { version: 3, projects: [] }))
      .rejects.toThrow('cannot persist an invalid project registry')
  })
})
