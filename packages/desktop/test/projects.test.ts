import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProject, readProjects, saveProject, serverUrl, writeProjects } from '../src/projects.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-projects-'))
  roots.push(root)
  return root
}

describe('Desktop project bindings', () => {
  it('persists remote-only projects without creating a local generation or store', async () => {
    const root = await directory()
    const project = { id: 'remote-studio', name: 'Remote studio', channel: 'main', engines: [
      { id: 'server-a', name: 'Server A', kind: 'remote', url: 'https://server.example.test/' },
      { id: 'server-b', name: 'Server B', kind: 'remote', url: 'http://127.0.0.1:44000' },
    ] }
    const projects = saveProject(await readProjects(root), project)
    await writeProjects(root, projects)
    expect(await readProjects(root)).toEqual({ version: 1, projects: [{ ...project, engines: [
      { ...project.engines[0], url: 'https://server.example.test' }, project.engines[1],
    ] }] })
    expect(await readdir(root)).toEqual(['projects.json'])
    expect(() => parseProject({ ...project, root: join(root, 'forbidden') })).toThrow('no local install root')
  })

  it('binds multiple engines and channels without owning environment state', async () => {
    const root = await directory()
    const project = { id: 'studio', name: 'Studio', root: join(root, 'install'), channel: 'stable', engines: [
      { id: 'gpu-engine', name: 'GPU engine', kind: 'local', gpus: ['1'] },
      { id: 'remote-engine', name: 'Remote engine', kind: 'remote', url: 'https://server.example.test' },
    ] }
    const initial = saveProject(await readProjects(root), project)
    await writeProjects(root, initial)
    const next = saveProject(await readProjects(root), { ...project, channel: 'main' })
    expect(next.projects).toHaveLength(1)
    expect(next.projects[0]).toMatchObject({ channel: 'main', root: join(root, 'install'), engines: project.engines })
    expect(() => saveProject(next, { ...project, id: 'duplicate-root' })).toThrow('already belongs')
    const first = { id: 'first', name: 'First', kind: 'local', gpus: ['1'], port: 44001 }
    const second = { id: 'second', name: 'Second', kind: 'local', gpus: ['0'], port: 44002 }
    expect(parseProject({ ...project, engines: [first, second] }).engines).toEqual([first, second])
    expect(() => parseProject({ ...project, engines: [first, { ...second, port: undefined }] })).toThrow('explicit ports')
    expect(() => parseProject({ ...project, engines: [first, { ...second, port: first.port }] })).toThrow('distinct')
    expect(await readdir(root)).toEqual(['projects.json'])
  })

  it('refuses corrupt bindings and credential-bearing or executable server URLs', async () => {
    const root = await directory()
    await writeFile(join(root, 'projects.json'), '{broken')
    await expect(readProjects(root)).rejects.toThrow()
    for (const url of ['file:///tmp/server', 'javascript:alert(1)', 'https://user:secret@example.test', 'https://example.test?token=secret']) {
      expect(() => serverUrl(url)).toThrow('server address')
    }
    const local = { id: 'local', name: 'Local', channel: 'main', root: 'relative', engines: [{ id: 'engine', name: 'Engine', kind: 'local', gpus: [] }] }
    expect(() => parseProject(local)).toThrow('absolute install root')
    expect(() => parseProject({ ...local, root, engines: [...local.engines, ...local.engines] })).toThrow('duplicate engine')
    expect(() => parseProject({ ...local, root, channel: 'nightly' })).toThrow('invalid Desktop project')
  })
})
