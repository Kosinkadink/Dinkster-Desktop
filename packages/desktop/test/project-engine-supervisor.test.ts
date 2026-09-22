import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineCli, type EngineGeneration, type EngineServeChild } from '../src/engine-cli.js'
import { startProjectEngineSupervisor } from '../src/project-engine-supervisor.js'

class FakeChild extends EventEmitter implements EngineServeChild {
  readonly pid = undefined
  exitCode: number | null = null
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => {
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  })
}

const generation: EngineGeneration = {
  generation: 3,
  current: true,
  root: '/srv/dinkster/project',
  engine: {
    baseId: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    commit: 'c'.repeat(40),
    cell: 'linux-cpu',
    objects: ['d'.repeat(64)],
  },
  controlPython: '/srv/dinkster/project/engine-envs/manifest/control/bin/python',
  executionPython: '/srv/dinkster/project/engine-envs/manifest/execution/bin/python',
}

afterEach(() => vi.unstubAllGlobals())

describe('project engine supervisor', () => {
  it('serves through the generation control interpreter and verifies the exact instance', async () => {
    const child = new FakeChild()
    const invocations: string[][] = []
    const logs: string[] = []
    const cli = new EngineCli({
      interpreter: '/bundled/bootstrap/python',
      spawn: ({ argv }) => {
        invocations.push([...argv])
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      state: 'ready',
      instance: 'project-studio-3',
    }))))

    const supervisor = await startProjectEngineSupervisor(cli, generation, {
      port: 4101,
      instanceId: 'project-studio-3',
      dataRoot: '/srv/dinkster/project-data/studio',
    }, (line) => logs.push(line))
    child.stderr.write('supervisor started\n')
    await supervisor.waitForReady('project-studio-3')
    await supervisor.stop()

    expect(invocations).toEqual([[
      generation.controlPython, '-I', '-m', 'dinkster.cli',
      'serve', '--root', generation.root, '--data-root', '/srv/dinkster/project-data/studio',
      '--host', '127.0.0.1', '--port', '4101', '--instance', 'project-studio-3',
    ]])
    expect(logs).toEqual(['supervisor started'])
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('fails closed before spawning a generation without a control interpreter', async () => {
    const cli = new EngineCli({ interpreter: '/bundled/bootstrap/python' })
    await expect(startProjectEngineSupervisor(cli, { ...generation, controlPython: undefined }, {
      port: 4101,
      instanceId: 'project-studio-3',
      dataRoot: '/srv/dinkster/project-data/studio',
    })).rejects.toThrow('has no control interpreter')
  })
})
