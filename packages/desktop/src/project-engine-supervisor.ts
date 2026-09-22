import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { waitForSupervisorReady } from './engine.js'
import { type EngineCli, type EngineGeneration, type EngineServeChild } from './engine-cli.js'
import type { GenerationSupervisorStart } from './generation-swap.js'

const STOP_TIMEOUT_MS = 1_500

async function spawned(child: EngineServeChild): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

async function waitForExit(child: EngineServeChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(timeoutMs),
  ])
}

export class ProjectEngineSupervisor {
  private readonly abort = new AbortController()
  private stopPromise: Promise<void> | undefined

  constructor(
    private readonly child: EngineServeChild,
    private readonly port: number,
    private readonly instanceId: string,
  ) {}

  async waitForReady(expectedInstanceId: string): Promise<void> {
    if (expectedInstanceId !== this.instanceId) {
      throw new Error('project supervisor readiness requested for a different instance')
    }
    await waitForSupervisorReady({
      port: this.port,
      instance: expectedInstanceId,
      variant: undefined,
      signal: this.abort.signal,
      exitCode: () => this.child.exitCode,
      update: () => {},
    })
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.abort.abort()
    this.stopPromise = this.stopInner()
    return this.stopPromise
  }

  private async stopInner(): Promise<void> {
    if (this.child.exitCode !== null) return
    const pid = this.child.pid
    if (process.platform === 'win32' && pid !== undefined) {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
      await Promise.race([
        new Promise<void>((resolve) => killer.once('exit', () => resolve())),
        delay(5_000),
      ])
      if (killer.exitCode === null) killer.kill()
      return
    }
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        return
      }
      await waitForExit(this.child, STOP_TIMEOUT_MS)
      if (this.child.exitCode === null) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // The process exited between checks.
        }
      }
      return
    }
    this.child.kill()
    await waitForExit(this.child, STOP_TIMEOUT_MS)
  }
}

export async function startProjectEngineSupervisor(
  cli: EngineCli,
  generation: EngineGeneration,
  request: GenerationSupervisorStart & { readonly dataRoot: string },
  log?: (line: string) => void,
): Promise<ProjectEngineSupervisor> {
  if (!generation.engine || !generation.controlPython) {
    throw new Error(`generation ${generation.generation} has no control interpreter`)
  }
  const child = cli.usingInterpreter(generation.controlPython).serve({
    root: generation.root,
    dataRoot: request.dataRoot,
    port: request.port,
    instance: request.instanceId,
  })
  const consume = (chunk: Buffer | string): void => {
    if (!log) return
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(line.trim())
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  const supervisor = new ProjectEngineSupervisor(child, request.port, request.instanceId)
  try {
    await spawned(child)
    return supervisor
  } catch (error) {
    await supervisor.stop()
    throw error
  }
}
