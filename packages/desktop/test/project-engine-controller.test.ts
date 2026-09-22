import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineCli, type EngineGeneration } from '../src/engine-cli.js'
import type { EngineFeedInspection } from '../src/engine-feed.js'
import { ProjectEngineController } from '../src/project-engine-controller.js'
import { defaultProjectDataRoot, readGenerationSwapJournal } from '../src/project-engine-state.js'
import { getProjectBinding, readProjectRegistry, upsertProjectBinding, writeProjectRegistry } from '../src/project-registry.js'
import type { GenerationSupervisor } from '../src/generation-swap.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-project-engine-controller-'))
  roots.push(root)
  return root
}

const engine = {
  baseId: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  commit: 'c'.repeat(40),
  cell: 'linux-cpu',
  objects: ['b'.repeat(64)],
} as const

function generation(number: number, current: boolean, root: string): EngineGeneration {
  return {
    generation: number,
    current,
    root,
    engine,
    controlPython: join(root, 'control', 'bin', 'python'),
    executionPython: join(root, 'execution', 'bin', 'python'),
  }
}

function inspection(channel: 'stable' | 'github-live' = 'stable'): EngineFeedInspection {
  return {
    channel: {
      format: 'dinkster.engine-channel/1',
      channel,
      commit: engine.commit,
      minimumLauncherVersion: '0.2.0',
      cells: {},
    },
    manifest: {
      format: 'dinkster.engine/1',
      commit: engine.commit,
      cell: engine.cell,
      base: { id: engine.baseId, archive: { path: 'base.tgz', sha256: 'd'.repeat(64), size: 1 }, python: 'bin/python', packages: {} },
      wheels: [],
    },
    display: {
      channel,
      engineCommit: engine.commit,
      minimumLauncherVersion: '0.2.0',
      cell: engine.cell,
      baseId: engine.baseId,
      manifestPath: `engine/${engine.commit}/${engine.cell}.json`,
    },
  }
}

interface TestSupervisor extends GenerationSupervisor {
  readonly generation: number
}

function supervisor(number: number): TestSupervisor {
  return { generation: number, stop: vi.fn(async () => undefined) }
}

function cli(): EngineCli {
  return new EngineCli({
    executable: 'dinkster',
    run: async () => ({ exitCode: 1, stdout: '', stderr: 'unexpected real call' }),
  })
}

describe('project engine controller', () => {
  it('stages and starts a first generation before persisting the project binding', async () => {
    const dataDirectory = await temporaryRoot()
    const engineCli = cli()
    const installRoot = join(dataDirectory, 'engine-projects', 'studio')
    vi.spyOn(engineCli, 'install').mockResolvedValue(generation(1, false, installRoot))
    const activate = vi.spyOn(engineCli, 'activate').mockResolvedValue(generation(1, true, installRoot))
    const started: TestSupervisor[] = []
    const controller = new ProjectEngineController({
      dataDirectory,
      projectId: 'studio',
      port: 4101,
      mirrorUrl: 'https://mirror.example/engine',
      cli: engineCli,
      inspectFeed: async () => inspection(),
      startSupervisor: async (installed, request) => {
        expect(request).toMatchObject({ port: 4101, dataRoot: defaultProjectDataRoot(dataDirectory, 'studio') })
        const running = supervisor(installed.generation)
        started.push(running)
        return running
      },
      waitForReady: async () => undefined,
    })

    await controller.install('stable', 'linux-cpu')

    expect(activate).toHaveBeenCalledWith({ root: installRoot, generation: 1 })
    expect(started).toHaveLength(1)
    expect(getProjectBinding(await readProjectRegistry(dataDirectory), 'studio')).toEqual({
      projectId: 'studio', installRoot, channel: 'stable',
    })
    expect(await readGenerationSwapJournal(dataDirectory, 'studio')).toBeUndefined()
  })

  it('retains the staged generation number when a first install fails readiness', async () => {
    const dataDirectory = await temporaryRoot()
    const engineCli = cli()
    const installRoot = join(dataDirectory, 'engine-projects', 'studio')
    vi.spyOn(engineCli, 'install').mockResolvedValue(generation(7, false, installRoot))
    vi.spyOn(engineCli, 'activate').mockResolvedValue(generation(7, true, installRoot))
    const candidate = supervisor(7)
    const controller = new ProjectEngineController({
      dataDirectory,
      projectId: 'studio',
      port: 4101,
      mirrorUrl: 'https://mirror.example/engine',
      cli: engineCli,
      inspectFeed: async () => inspection(),
      startSupervisor: async () => candidate,
      waitForReady: async () => { throw new Error('new supervisor never became ready') },
    })

    await expect(controller.install('stable', 'linux-cpu')).rejects.toThrow('never became ready')

    expect(candidate.stop).toHaveBeenCalledOnce()
    expect(await readGenerationSwapJournal(dataDirectory, 'studio')).toMatchObject({
      stage: 'failed', previousGeneration: 'none', targetGeneration: '7',
    })
    expect(getProjectBinding(await readProjectRegistry(dataDirectory), 'studio')).toBeUndefined()
    await expect(controller.info()).resolves.toMatchObject({
      configured: false,
      journal: { stage: 'failed', previousGeneration: 'none', targetGeneration: '7' },
    })
  })

  it('restores the serving generation and retains the failed target after readiness failure', async () => {
    const dataDirectory = await temporaryRoot()
    const installRoot = join(dataDirectory, 'engine-projects', 'studio')
    await writeProjectRegistry(dataDirectory, upsertProjectBinding(
      await readProjectRegistry(dataDirectory),
      { projectId: 'studio', installRoot, channel: 'stable' },
    ))
    const engineCli = cli()
    vi.spyOn(engineCli, 'generations').mockResolvedValue([generation(1, true, installRoot)])
    vi.spyOn(engineCli, 'install').mockResolvedValue(generation(2, false, installRoot))
    const activate = vi.spyOn(engineCli, 'activate').mockImplementation(async ({ generation: number }) =>
      generation(number, true, installRoot))
    const previous = supervisor(1)
    let start = 0
    const controller = new ProjectEngineController({
      dataDirectory,
      projectId: 'studio',
      port: 4101,
      mirrorUrl: 'https://mirror.example/engine',
      cli: engineCli,
      currentSupervisor: previous,
      inspectFeed: async () => inspection('github-live'),
      startSupervisor: async (installed) => { start++; return supervisor(installed.generation) },
      waitForReady: async (running) => {
        if (running.generation === 2) throw new Error('new supervisor never became ready')
      },
    })

    await expect(controller.install('github-live', 'linux-cpu')).rejects.toThrow('never became ready')

    expect(previous.stop).toHaveBeenCalledOnce()
    expect(start).toBe(2)
    expect(activate.mock.calls.map(([request]) => request.generation)).toEqual([2, 1])
    expect(await readGenerationSwapJournal(dataDirectory, 'studio')).toMatchObject({
      stage: 'failed', previousGeneration: '1', targetGeneration: '2', error: 'new supervisor never became ready',
    })
    expect(getProjectBinding(await readProjectRegistry(dataDirectory), 'studio')?.channel).toBe('stable')
  })

  it('preserves project data by default and requires its exact path to delete it', async () => {
    const dataDirectory = await temporaryRoot()
    const installRoot = join(dataDirectory, 'engine-projects', 'studio')
    await writeProjectRegistry(dataDirectory, upsertProjectBinding(
      await readProjectRegistry(dataDirectory),
      { projectId: 'studio', installRoot, channel: 'stable' },
    ))
    const dataRoot = defaultProjectDataRoot(dataDirectory, 'studio')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(dataRoot, 'model.bin'), 'user data')
    const preserve = new ProjectEngineController({
      dataDirectory, projectId: 'studio', port: 4101, cli: cli(),
      inspectFeed: async () => inspection(), startSupervisor: async () => supervisor(1), waitForReady: async () => undefined,
    })
    await preserve.remove(false)
    expect(await readFile(join(dataRoot, 'model.bin'), 'utf8')).toBe('user data')

    await expect(preserve.remove(true, join(dataDirectory, 'wrong'))).rejects.toThrow('exact path confirmation')
    expect(await readFile(join(dataRoot, 'model.bin'), 'utf8')).toBe('user data')
    await preserve.remove(true, dataRoot)
    await expect(stat(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
