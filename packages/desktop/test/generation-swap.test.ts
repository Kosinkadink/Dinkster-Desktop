import { describe, expect, it, vi } from 'vitest'
import {
  swapProjectGeneration,
  type GenerationSupervisor,
  type GenerationSwapJournal,
  type GenerationSwapOptions,
} from '../src/generation-swap.js'

interface TestSupervisor extends GenerationSupervisor {
  readonly name: string
}

function supervisor(name: string, events: string[]): TestSupervisor {
  return {
    name,
    stop: vi.fn(async () => { events.push(`stop:${name}`) }),
  }
}

function swapOptions(events: string[], overrides: Partial<GenerationSwapOptions<string, string, TestSupervisor>> = {}) {
  const journals: GenerationSwapJournal[] = []
  const old = supervisor('old', events)
  let instance = 0
  const options: GenerationSwapOptions<string, string, TestSupervisor> = {
    projectId: 'default',
    port: 4100,
    previous: 'generation-old',
    target: 'generation-new',
    currentSupervisor: old,
    describeGeneration: (generation) => generation,
    describeTarget: (generation) => generation,
    build: async (generation) => { events.push(`build:${generation}`); return generation },
    snapshot: async (generation) => { events.push(`snapshot:${generation}`) },
    activate: async (generation) => { events.push(`activate:${generation}`) },
    startSupervisor: async (generation, start) => {
      events.push(`start:${generation}:${start.port}:${start.instanceId}`)
      return supervisor(generation, events)
    },
    waitForReady: async (_running, expectedInstanceId) => { events.push(`ready:${expectedInstanceId}`) },
    persistSelection: async (generation) => { events.push(`persist:${generation}`) },
    onSupervisorRestored: (running) => { events.push(`restored:${running.name}`) },
    writeJournal: async (journal) => { journals.push(journal); events.push(`journal:${journal.stage}`) },
    clearJournal: async () => { events.push('journal:clear') },
    operationId: () => 'operation-1',
    supervisorInstanceId: () => `instance-${++instance}`,
    now: () => '2026-09-22T00:00:00.000Z',
    ...overrides,
  }
  return { options, journals, old }
}

describe('project generation swap', () => {
  it('builds before stopping and commits only after the new supervisor identity is ready', async () => {
    const events: string[] = []
    const { options, journals } = swapOptions(events)
    const result = await swapProjectGeneration(options)

    expect(result.instanceId).toBe('instance-1')
    expect(events).toEqual([
      'journal:building',
      'build:generation-new',
      'snapshot:generation-old',
      'journal:switching',
      'stop:old',
      'activate:generation-new',
      'start:generation-new:4100:instance-1',
      'ready:instance-1',
      'persist:generation-new',
      'journal:clear',
    ])
    expect(journals.map((entry) => entry.stage)).toEqual(['building', 'switching'])
  })

  it('restores the previous generation under a new identity when readiness fails', async () => {
    const events: string[] = []
    const { options, journals } = swapOptions(events, {
      waitForReady: async (_running, expectedInstanceId) => {
        events.push(`ready:${expectedInstanceId}`)
        if (expectedInstanceId === 'instance-1') throw new Error('supervisor never became ready')
      },
    })

    await expect(swapProjectGeneration(options)).rejects.toThrow('supervisor never became ready')
    expect(events).toEqual([
      'journal:building',
      'build:generation-new',
      'snapshot:generation-old',
      'journal:switching',
      'stop:old',
      'activate:generation-new',
      'start:generation-new:4100:instance-1',
      'ready:instance-1',
      'stop:generation-new',
      'activate:generation-old',
      'start:generation-old:4100:instance-2',
      'ready:instance-2',
      'restored:generation-old',
      'persist:generation-old',
      'journal:failed',
    ])
    expect(journals.at(-1)).toMatchObject({
      stage: 'failed',
      previousGeneration: 'generation-old',
      targetGeneration: 'generation-new',
      error: 'supervisor never became ready',
    })
  })

  it('leaves the current supervisor running when the target build fails', async () => {
    const events: string[] = []
    const { options, journals, old } = swapOptions(events, {
      build: async () => { events.push('build:failed'); throw new Error('code layer checksum mismatch') },
    })

    await expect(swapProjectGeneration(options)).rejects.toThrow('code layer checksum mismatch')
    expect(old.stop).not.toHaveBeenCalled()
    expect(events).toEqual(['journal:building', 'build:failed', 'journal:failed'])
    expect(journals.at(-1)?.error).toBe('code layer checksum mismatch')
  })

  it('retains both the swap and recovery failures in the support journal', async () => {
    const events: string[] = []
    let start = 0
    const { options, journals } = swapOptions(events, {
      startSupervisor: async (generation, request) => {
        events.push(`start:${generation}:${request.instanceId}`)
        start++
        if (start === 2) throw new Error('previous supervisor restart failed')
        return supervisor(generation, events)
      },
      waitForReady: async () => { throw new Error('target readiness failed') },
    })

    await expect(swapProjectGeneration(options)).rejects.toThrow('generation swap and recovery both failed')
    expect(journals.at(-1)?.error).toBe(
      'generation swap and recovery both failed: target readiness failed; previous supervisor restart failed',
    )
  })

  it('stops a restored supervisor that fails its own readiness check', async () => {
    const events: string[] = []
    const { options, journals } = swapOptions(events, {
      waitForReady: async (_running, expectedInstanceId) => {
        events.push(`ready:${expectedInstanceId}`)
        throw new Error(expectedInstanceId === 'instance-1' ? 'target readiness failed' : 'recovery readiness failed')
      },
    })

    await expect(swapProjectGeneration(options)).rejects.toThrow('generation swap and recovery both failed')
    expect(events).toContain('stop:generation-new')
    expect(events).toContain('stop:generation-old')
    expect(events).not.toContain('restored:generation-old')
    expect(journals.at(-1)?.error).toBe(
      'generation swap and recovery both failed: target readiness failed; recovery readiness failed',
    )
  })

  it('keeps swaps for different projects isolated by supervisor and port', async () => {
    const alphaEvents: string[] = []
    const betaEvents: string[] = []
    const alpha = swapOptions(alphaEvents, { projectId: 'alpha', port: 4201 })
    const beta = swapOptions(betaEvents, { projectId: 'beta', port: 4202 })

    await swapProjectGeneration(alpha.options)
    expect(beta.old.stop).not.toHaveBeenCalled()
    await swapProjectGeneration(beta.options)

    expect(alphaEvents).toContain('start:generation-new:4201:instance-1')
    expect(betaEvents).toContain('start:generation-new:4202:instance-1')
    expect(alpha.old.stop).toHaveBeenCalledOnce()
    expect(beta.old.stop).toHaveBeenCalledOnce()
  })
})
