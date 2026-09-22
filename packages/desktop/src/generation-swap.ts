import { randomUUID } from 'node:crypto'

export type GenerationSwapStage = 'building' | 'switching' | 'failed'

export interface GenerationSwapJournal {
  readonly format: 1
  readonly operationId: string
  readonly projectId: string
  readonly previousGeneration: string
  readonly targetGeneration: string
  readonly stage: GenerationSwapStage
  readonly startedAt: string
  readonly failedAt?: string
  readonly error?: string
}

export interface GenerationSupervisor {
  stop(): Promise<void>
}

export interface GenerationSupervisorStart {
  readonly port: number
  readonly instanceId: string
}

export interface GenerationSwapOptions<Generation, Supervisor extends GenerationSupervisor> {
  readonly projectId: string
  readonly port: number
  readonly previous: Generation
  readonly target: Generation
  readonly currentSupervisor: Supervisor
  describeGeneration(generation: Generation): string
  build(generation: Generation): Promise<void>
  snapshot(generation: Generation): Promise<void>
  activate(generation: Generation): Promise<void>
  startSupervisor(generation: Generation, start: GenerationSupervisorStart): Promise<Supervisor>
  waitForReady(supervisor: Supervisor, expectedInstanceId: string): Promise<void>
  persistSelection(generation: Generation): Promise<void>
  writeJournal(journal: GenerationSwapJournal): Promise<void>
  clearJournal(): Promise<void>
  operationId?(): string
  supervisorInstanceId?(): string
  now?(): string
}

export interface GenerationSwapResult<Supervisor> {
  readonly supervisor: Supervisor
  readonly instanceId: string
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorMessage).join('; ')}`
  }
  return error instanceof Error ? error.message : String(error)
}

export async function swapProjectGeneration<Generation, Supervisor extends GenerationSupervisor>(
  options: GenerationSwapOptions<Generation, Supervisor>,
): Promise<GenerationSwapResult<Supervisor>> {
  const now = options.now ?? (() => new Date().toISOString())
  const operationId = (options.operationId ?? randomUUID)()
  const previousGeneration = options.describeGeneration(options.previous)
  const targetGeneration = options.describeGeneration(options.target)
  const startedAt = now()
  const journal = (stage: GenerationSwapStage, failure?: unknown): GenerationSwapJournal => ({
    format: 1,
    operationId,
    projectId: options.projectId,
    previousGeneration,
    targetGeneration,
    stage,
    startedAt,
    ...(failure === undefined ? {} : { failedAt: now(), error: errorMessage(failure) }),
  })

  await options.writeJournal(journal('building'))
  let previousStopped = false
  let candidate: Supervisor | undefined
  try {
    await options.build(options.target)
    await options.snapshot(options.previous)
    await options.writeJournal(journal('switching'))
    await options.currentSupervisor.stop()
    previousStopped = true
    await options.activate(options.target)
    const instanceId = (options.supervisorInstanceId ?? randomUUID)()
    candidate = await options.startSupervisor(options.target, { port: options.port, instanceId })
    await options.waitForReady(candidate, instanceId)
    await options.persistSelection(options.target)
    await options.clearJournal()
    return { supervisor: candidate, instanceId }
  } catch (error) {
    let recoveryError: unknown
    if (previousStopped) {
      try {
        await candidate?.stop()
        await options.activate(options.previous)
        const instanceId = (options.supervisorInstanceId ?? randomUUID)()
        const restored = await options.startSupervisor(options.previous, { port: options.port, instanceId })
        await options.waitForReady(restored, instanceId)
        await options.persistSelection(options.previous)
      } catch (caught) {
        recoveryError = caught
      }
    }
    const recordedError = recoveryError === undefined
      ? error
      : new AggregateError([error, recoveryError], 'generation swap and recovery both failed')
    await options.writeJournal(journal('failed', recordedError))
    throw recordedError
  }
}
