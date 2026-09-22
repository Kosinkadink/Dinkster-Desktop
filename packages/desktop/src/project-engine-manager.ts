import type { DesktopProjectEngineInfo } from './types.js'
import type { ProjectChannel } from './project-registry.js'
import { validProjectId } from './window-layout.js'

export interface ManagedProjectEngine {
  startCurrent(): Promise<void>
  stop(): Promise<void>
  info(): Promise<DesktopProjectEngineInfo>
  install(channel: ProjectChannel, cell: string): Promise<void>
  activate(generation: number): Promise<void>
  remove(deleteDataRoot: boolean, confirmedDataRoot?: string): Promise<void>
}

export interface ProjectEngineManagerOptions<Engine extends ManagedProjectEngine> {
  allocatePort(): Promise<number>
  create(projectId: string, port: number): Engine
}

interface ProjectEntry<Engine> {
  readonly port: number
  readonly engine: Engine
}

const MAX_PORT_ALLOCATION_ATTEMPTS = 100

export class ProjectEngineManager<Engine extends ManagedProjectEngine> {
  private readonly entries = new Map<string, Promise<ProjectEntry<Engine>>>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly ports = new Set<number>()

  constructor(private readonly options: ProjectEngineManagerOptions<Engine>) {}

  info(projectId: string): Promise<DesktopProjectEngineInfo> {
    return this.run(projectId, async (engine) => {
      await engine.startCurrent()
      return engine.info()
    })
  }

  install(projectId: string, channel: ProjectChannel, cell: string): Promise<void> {
    return this.run(projectId, async (engine) => {
      await engine.startCurrent()
      await engine.install(channel, cell)
    })
  }

  activate(projectId: string, generation: number): Promise<void> {
    return this.run(projectId, async (engine) => {
      await engine.startCurrent()
      await engine.activate(generation)
    })
  }

  remove(projectId: string, deleteDataRoot: boolean, confirmedDataRoot?: string): Promise<void> {
    return this.run(projectId, (engine) => engine.remove(deleteDataRoot, confirmedDataRoot))
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.operations.values())
    await Promise.allSettled([...this.entries.values()].map(async (entry) => {
      await (await entry).engine.stop()
    }))
  }

  private async entry(projectId: string): Promise<ProjectEntry<Engine>> {
    if (!validProjectId(projectId)) throw new Error(`invalid project id: ${JSON.stringify(projectId)}`)
    let entry = this.entries.get(projectId)
    if (!entry) {
      entry = this.createEntry(projectId)
      this.entries.set(projectId, entry)
    }
    try {
      return await entry
    } catch (error) {
      if (this.entries.get(projectId) === entry) this.entries.delete(projectId)
      throw error
    }
  }

  private async createEntry(projectId: string): Promise<ProjectEntry<Engine>> {
    let port: number | undefined
    for (let attempt = 0; attempt < MAX_PORT_ALLOCATION_ATTEMPTS; attempt++) {
      const candidate = await this.options.allocatePort()
      if (!this.ports.has(candidate)) {
        port = candidate
        break
      }
    }
    if (port === undefined) throw new Error('could not allocate a distinct project engine port')
    this.ports.add(port)
    try {
      return { port, engine: this.options.create(projectId, port) }
    } catch (error) {
      this.ports.delete(port)
      throw error
    }
  }

  private async run<Result>(projectId: string, operation: (engine: Engine) => Promise<Result>): Promise<Result> {
    const previous = this.operations.get(projectId) ?? Promise.resolve()
    let resolveCurrent!: () => void
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve })
    const tail = previous.catch(() => {}).then(() => current)
    this.operations.set(projectId, tail)
    await previous.catch(() => {})
    try {
      return await operation((await this.entry(projectId)).engine)
    } finally {
      resolveCurrent()
      if (this.operations.get(projectId) === tail) this.operations.delete(projectId)
    }
  }
}
