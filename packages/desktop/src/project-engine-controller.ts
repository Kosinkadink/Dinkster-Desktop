import { join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import type { EngineCli, EngineGeneration } from './engine-cli.js'
import type { EngineFeedDisplay, EngineFeedInspection } from './engine-feed.js'
import {
  clearGenerationSwapJournal,
  defaultProjectDataRoot,
  defaultProjectInstallRoot,
  deleteConfirmedProjectData,
  readGenerationSwapJournal,
  writeGenerationSwapJournal,
} from './project-engine-state.js'
import {
  getProjectBinding,
  readProjectRegistry,
  removeProjectBinding,
  upsertProjectBinding,
  writeProjectRegistry,
  type ProjectChannel,
} from './project-registry.js'
import {
  swapProjectGeneration,
  type GenerationSupervisor,
  type GenerationSupervisorStart,
  type GenerationSwapJournal,
} from './generation-swap.js'
import type { DesktopProjectEngineInfo, DesktopProjectGeneration } from './types.js'

export interface ProjectEngineControllerOptions<Supervisor extends GenerationSupervisor> {
  readonly dataDirectory: string
  readonly projectId: string
  readonly port: number
  readonly mirrorUrl?: string
  readonly allowLocalHttp?: boolean
  readonly cli: EngineCli
  inspectFeed(channel: ProjectChannel, cell: string): Promise<EngineFeedInspection>
  startSupervisor(
    generation: EngineGeneration,
    request: GenerationSupervisorStart & { readonly dataRoot: string },
  ): Promise<Supervisor>
  waitForReady(supervisor: Supervisor, expectedInstanceId: string): Promise<void>
  currentSupervisor?: Supervisor
}

function generationNumber(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function requireEngine(generation: EngineGeneration): NonNullable<EngineGeneration['engine']> {
  if (!generation.engine) throw new Error(`generation ${generation.generation} has no engine environment`)
  return generation.engine
}

function generationCli(cli: EngineCli, generation: EngineGeneration): EngineCli {
  requireEngine(generation)
  if (!generation.controlPython) {
    throw new Error(`generation ${generation.generation} has no control interpreter`)
  }
  return cli.usingInterpreter(generation.controlPython)
}

export class ProjectEngineController<Supervisor extends GenerationSupervisor> {
  private supervisor: Supervisor | undefined

  constructor(private readonly options: ProjectEngineControllerOptions<Supervisor>) {
    this.supervisor = options.currentSupervisor
  }

  async info(): Promise<DesktopProjectEngineInfo> {
    const [registry, journal] = await Promise.all([
      readProjectRegistry(this.options.dataDirectory),
      readGenerationSwapJournal(this.options.dataDirectory, this.options.projectId),
    ])
    const binding = getProjectBinding(registry, this.options.projectId)
    const dataRoot = defaultProjectDataRoot(this.options.dataDirectory, this.options.projectId)
    if (!binding) {
      return {
        projectId: this.options.projectId,
        configured: false,
        mirrorConfigured: this.options.mirrorUrl !== undefined,
        dataRoot,
        generations: [],
        ...(journal ? { journal: {
          stage: journal.stage,
          previousGeneration: journal.previousGeneration,
          targetGeneration: journal.targetGeneration,
          ...(journal.error ? { error: journal.error } : {}),
        } } : {}),
      }
    }
    const generations = await this.options.cli.generations(binding.installRoot)
    const failed = journal?.stage === 'failed' ? generationNumber(journal.targetGeneration) : undefined
    const presented = generations.flatMap((generation): DesktopProjectGeneration[] => {
      if (!generation.engine) return []
      return [{
        generation: generation.generation,
        current: generation.current,
        baseId: generation.engine.baseId,
        engineCommit: generation.engine.commit,
        cell: generation.engine.cell,
        status: generation.current ? 'active' : generation.generation === failed ? 'failed' : 'installed',
      }]
    })
    const current = generations.find((generation) => generation.current)
    let availableEngineCommit: string | undefined
    if (this.options.mirrorUrl && current?.engine) {
      try {
        availableEngineCommit = (await this.options.inspectFeed(binding.channel, current.engine.cell)).display.engineCommit
      } catch {
        // Installed generations remain manageable while the mirror is unavailable.
      }
    }
    return {
      projectId: this.options.projectId,
      configured: true,
      mirrorConfigured: this.options.mirrorUrl !== undefined,
      dataRoot,
      generations: presented,
      channel: binding.channel,
      installRoot: binding.installRoot,
      port: this.options.port,
      ...(current?.engine ? { cell: current.engine.cell } : {}),
      ...(availableEngineCommit ? { availableEngineCommit } : {}),
      ...(journal
        ? { journal: {
            stage: journal.stage,
            previousGeneration: journal.previousGeneration,
            targetGeneration: journal.targetGeneration,
            ...(journal.error ? { error: journal.error } : {}),
          } }
        : {}),
    }
  }

  async install(channel: ProjectChannel, cell: string): Promise<void> {
    if (!this.options.mirrorUrl) throw new Error('the engine mirror is not configured')
    const inspection = await this.options.inspectFeed(channel, cell)
    const registry = await readProjectRegistry(this.options.dataDirectory)
    const existing = getProjectBinding(registry, this.options.projectId)
    const installRoot = existing?.installRoot
      ?? defaultProjectInstallRoot(this.options.dataDirectory, this.options.projectId)
    const generations = existing ? await this.options.cli.generations(installRoot) : []
    const previous = generations.find((generation) => generation.current)
    if (!previous) {
      await this.firstInstall(installRoot, channel, cell, inspection.display)
      return
    }
    if (!this.supervisor) throw new Error(`project ${this.options.projectId} supervisor is not running`)
    const result = await swapProjectGeneration({
      projectId: this.options.projectId,
      port: this.options.port,
      previous,
      target: inspection.display,
      currentSupervisor: this.supervisor,
      describeGeneration: (generation) => String(generation.generation),
      describeTarget: (target) => target.engineCommit,
      build: () => this.options.cli.install({
        root: installRoot,
        mirror: this.options.mirrorUrl!,
        channel,
        cell,
        ...(this.options.allowLocalHttp ? { allowLocalHttp: true } : {}),
      }),
      snapshot: (generation) => this.snapshot(generation),
      activate: async (generation) => {
        await generationCli(this.options.cli, generation).activate({ root: installRoot, generation: generation.generation })
      },
      startSupervisor: (generation, start) => this.start(generation, start),
      waitForReady: this.options.waitForReady,
      persistSelection: (generation) => this.persistBinding(
        installRoot,
        generation.generation === previous.generation ? existing!.channel : channel,
      ),
      writeJournal: (journal) => writeGenerationSwapJournal(this.options.dataDirectory, journal),
      clearJournal: () => clearGenerationSwapJournal(this.options.dataDirectory, this.options.projectId),
    })
    this.supervisor = result.supervisor
  }

  async activate(generationNumber: number): Promise<void> {
    const registry = await readProjectRegistry(this.options.dataDirectory)
    const binding = getProjectBinding(registry, this.options.projectId)
    if (!binding) throw new Error(`project ${this.options.projectId} is not configured`)
    const generations = await this.options.cli.generations(binding.installRoot)
    const previous = generations.find((generation) => generation.current)
    const target = generations.find((generation) => generation.generation === generationNumber)
    if (!previous || !target) throw new Error('the requested generation is not installed')
    if (target.current) return
    if (!this.supervisor) throw new Error(`project ${this.options.projectId} supervisor is not running`)
    const result = await swapProjectGeneration({
      projectId: this.options.projectId,
      port: this.options.port,
      previous,
      target,
      currentSupervisor: this.supervisor,
      describeGeneration: (generation) => String(generation.generation),
      describeTarget: (generation) => String(generation.generation),
      build: async (generation) => generation,
      snapshot: (generation) => this.snapshot(generation),
      activate: async (generation) => {
        await generationCli(this.options.cli, generation).activate({
          root: binding.installRoot,
          generation: generation.generation,
        })
      },
      startSupervisor: (generation, start) => this.start(generation, start),
      waitForReady: this.options.waitForReady,
      persistSelection: async () => {},
      writeJournal: (journal) => writeGenerationSwapJournal(this.options.dataDirectory, journal),
      clearJournal: () => clearGenerationSwapJournal(this.options.dataDirectory, this.options.projectId),
    })
    this.supervisor = result.supervisor
  }

  async remove(deleteDataRoot: boolean, confirmedDataRoot?: string): Promise<void> {
    const dataRoot = defaultProjectDataRoot(this.options.dataDirectory, this.options.projectId)
    if (deleteDataRoot && confirmedDataRoot !== resolve(dataRoot)) {
      throw new Error(`data deletion requires exact path confirmation: ${resolve(dataRoot)}`)
    }
    await this.supervisor?.stop()
    this.supervisor = undefined
    if (deleteDataRoot) await deleteConfirmedProjectData(dataRoot, confirmedDataRoot!)
    const registry = await readProjectRegistry(this.options.dataDirectory)
    await writeProjectRegistry(
      this.options.dataDirectory,
      removeProjectBinding(registry, this.options.projectId),
    )
    await clearGenerationSwapJournal(this.options.dataDirectory, this.options.projectId)
  }

  private async firstInstall(
    installRoot: string,
    channel: ProjectChannel,
    cell: string,
    target: EngineFeedDisplay,
  ): Promise<void> {
    const startedAt = new Date().toISOString()
    const baseJournal: Omit<GenerationSwapJournal, 'stage'> = {
      format: 1,
      operationId: crypto.randomUUID(),
      projectId: this.options.projectId,
      previousGeneration: 'none',
      targetGeneration: target.engineCommit,
      startedAt,
    }
    let targetGeneration = baseJournal.targetGeneration
    await writeGenerationSwapJournal(this.options.dataDirectory, { ...baseJournal, stage: 'building' })
    let supervisor: Supervisor | undefined
    try {
      const generation = await this.options.cli.install({
        root: installRoot,
        mirror: this.options.mirrorUrl!,
        channel,
        cell,
        ...(this.options.allowLocalHttp ? { allowLocalHttp: true } : {}),
      })
      targetGeneration = String(generation.generation)
      await writeGenerationSwapJournal(this.options.dataDirectory, {
        ...baseJournal,
        targetGeneration,
        stage: 'switching',
      })
      await generationCli(this.options.cli, generation).activate({ root: installRoot, generation: generation.generation })
      const instanceId = crypto.randomUUID()
      supervisor = await this.start(generation, { port: this.options.port, instanceId })
      await this.options.waitForReady(supervisor, instanceId)
      await this.persistBinding(installRoot, channel)
      await clearGenerationSwapJournal(this.options.dataDirectory, this.options.projectId)
      this.supervisor = supervisor
    } catch (error) {
      await supervisor?.stop()
      await writeGenerationSwapJournal(this.options.dataDirectory, {
        ...baseJournal,
        targetGeneration,
        stage: 'failed',
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private start(generation: EngineGeneration, start: GenerationSupervisorStart): Promise<Supervisor> {
    requireEngine(generation)
    return this.options.startSupervisor(generation, {
      ...start,
      dataRoot: defaultProjectDataRoot(this.options.dataDirectory, this.options.projectId),
    })
  }

  private async snapshot(generation: EngineGeneration): Promise<void> {
    requireEngine(generation)
    const path = join(
      this.options.dataDirectory,
      'engine-snapshots',
      this.options.projectId,
      `${Date.now()}-${generation.generation}.json`,
    )
    await writeFileAtomic(path, `${JSON.stringify(generation, null, 2)}\n`)
  }

  private async persistBinding(installRoot: string, channel: ProjectChannel): Promise<void> {
    const registry = await readProjectRegistry(this.options.dataDirectory)
    await writeProjectRegistry(
      this.options.dataDirectory,
      upsertProjectBinding(registry, { projectId: this.options.projectId, installRoot, channel }),
    )
  }
}
