import { randomUUID } from 'node:crypto'
import type { EngineOperation, EngineSelection, InstallSnapshot } from './desktop-manager.js'

export interface TransactionRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface EngineTransactionOptions<Runtime extends TransactionRuntime> {
  readonly previous: EngineSelection
  readonly target: EngineSelection
  readonly kind: EngineOperation['kind']
  readonly expectedDependencies?: readonly { readonly name: string; readonly version: string }[]
  readonly currentRuntime: Runtime
  createRuntime(selection: EngineSelection): Runtime
  activateRuntime(runtime: Runtime): void
  writeOperation(operation: EngineOperation): Promise<void>
  snapshot(selection: EngineSelection, reason: InstallSnapshot['reason']): Promise<InstallSnapshot>
  persist(selection: EngineSelection): Promise<void>
  clearOperation(): Promise<void>
  committed(): Promise<void>
}

export async function changeEngineTransaction<Runtime extends TransactionRuntime>(
  options: EngineTransactionOptions<Runtime>,
): Promise<void> {
  await options.writeOperation({
    id: randomUUID(),
    kind: options.kind,
    previous: options.previous,
    target: options.target,
    startedAt: new Date().toISOString(),
  })
  await options.snapshot(options.previous, 'pre-update')
  await options.currentRuntime.stop()
  let candidate: Runtime | undefined
  try {
    candidate = options.createRuntime(options.target)
    options.activateRuntime(candidate)
    await candidate.start()
    const postSnapshot = await options.snapshot(options.target, 'post-update')
    if (options.expectedDependencies &&
      JSON.stringify(postSnapshot.dependencies) !== JSON.stringify(options.expectedDependencies)) {
      throw new Error('restored environment does not match the snapshot dependency set')
    }
    await options.persist(options.target)
    await options.clearOperation()
    await options.committed()
  } catch (error) {
    await candidate?.stop()
    const restored = options.createRuntime(options.previous)
    options.activateRuntime(restored)
    await restored.start()
    await options.persist(options.previous)
    await options.clearOperation()
    await options.committed()
    throw error
  }
}
