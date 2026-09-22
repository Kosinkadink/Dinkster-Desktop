import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearGenerationSwapJournal,
  decodeGenerationSwapJournal,
  defaultProjectDataRoot,
  defaultProjectInstallRoot,
  deleteConfirmedProjectData,
  readGenerationSwapJournal,
  writeGenerationSwapJournal,
} from '../src/project-engine-state.js'
import type { GenerationSwapJournal } from '../src/generation-swap.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-project-engine-state-'))
  roots.push(root)
  return root
}

const journal: GenerationSwapJournal = {
  format: 1,
  operationId: 'operation-1',
  projectId: 'studio',
  previousGeneration: '1',
  targetGeneration: '2',
  stage: 'failed',
  startedAt: '2026-09-22T00:00:00.000Z',
  failedAt: '2026-09-22T00:01:00.000Z',
  error: 'target readiness failed',
}

describe('project engine state', () => {
  it('derives separate install and data roots for each valid project', async () => {
    const root = await temporaryRoot()
    expect(defaultProjectInstallRoot(root, 'studio')).toBe(resolve(root, 'engine-projects', 'studio'))
    expect(defaultProjectDataRoot(root, 'studio')).toBe(resolve(root, 'project-data', 'studio'))
    expect(defaultProjectInstallRoot(root, 'studio')).not.toBe(defaultProjectDataRoot(root, 'studio'))
    expect(() => defaultProjectDataRoot(root, '../escape')).toThrow('invalid project id')
  })

  it('round-trips and clears a strict per-project swap journal', async () => {
    const root = await temporaryRoot()
    expect(await readGenerationSwapJournal(root, 'studio')).toBeUndefined()
    await writeGenerationSwapJournal(root, journal)
    expect(await readGenerationSwapJournal(root, 'studio')).toEqual(journal)
    expect(await readGenerationSwapJournal(root, 'other')).toBeUndefined()
    await clearGenerationSwapJournal(root, 'studio')
    expect(await readGenerationSwapJournal(root, 'studio')).toBeUndefined()
  })

  it('rejects malformed or cross-project journal contents', async () => {
    const root = await temporaryRoot()
    expect(decodeGenerationSwapJournal({ ...journal, stage: 'done' })).toBeUndefined()
    expect(decodeGenerationSwapJournal({ ...journal, projectId: 'not valid' })).toBeUndefined()
    await mkdir(join(root, 'engine-operations'), { recursive: true })
    await writeFile(join(root, 'engine-operations', 'studio.json'), JSON.stringify({ ...journal, projectId: 'other' }))
    expect(await readGenerationSwapJournal(root, 'studio')).toBeUndefined()
  })

  it('deletes data only after exact path confirmation', async () => {
    const root = await temporaryRoot()
    const data = join(root, 'project-data', 'studio')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'model.bin'), 'keep')

    await expect(deleteConfirmedProjectData(data, join(root, 'project-data'))).rejects.toThrow('exact path confirmation')
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(join(data, 'model.bin'), 'utf8'))).toBe('keep')
    await deleteConfirmedProjectData(data, resolve(data))
    await expect(import('node:fs/promises').then(({ stat }) => stat(data))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
