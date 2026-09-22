import { describe, expect, it } from 'vitest'
import {
  EngineCli,
  type EngineCliOptions,
  type EngineCliRunner,
  type EngineCliResult,
  type EngineServeChild,
} from '../src/engine-cli.js'

const root = '/srv/dinkster/roots/project-a'
const interpreter = '/srv/dinkster/bootstrap/control/bin/python'
const cliPrefix = [interpreter, '-I', '-m', 'dinkster.cli']
const okEngine = {
  baseId: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  commit: 'c'.repeat(40),
  cell: 'linux-cu128',
  objects: ['b'.repeat(64), 'd'.repeat(64)],
}
const okControl = '/srv/dinkster/roots/project-a/generations/1/control/bin/python'
const okExecution = '/srv/dinkster/roots/project-a/generations/1/execution/bin/python'
const ERROR_LIMIT_PLUS_HEADER = 2200

function stagedGeneration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    generation: 1,
    current: false,
    root,
    engine: okEngine,
    controlPython: okControl,
    executionPython: okExecution,
    ...overrides,
  })
}

function generationsJson(...generations: string[]): string {
  return `[${generations.join(',')}]`
}

function runner(stdout: string, overrides: Partial<EngineCliResult> = {}): {
  run: EngineCliRunner
  invocations: string[][]
} {
  const invocations: string[][] = []
  return {
    invocations,
    run: async (invocation) => {
      invocations.push([...invocation.argv])
      return { exitCode: 0, stdout, stderr: '', ...overrides }
    },
  }
}

function fakeChild(): EngineServeChild {
  return { pid: 4242, exitCode: null, stdout: null, stderr: null, once: () => {}, kill: () => true }
}

describe('engine CLI adapter', () => {
  it('fails closed without a configured bootstrap command', () => {
    expect(() => new EngineCli({} as EngineCliOptions)).toThrow('bootstrap interpreter is not configured')
    expect(() => new EngineCli({ interpreter: '  ' })).toThrow('bootstrap interpreter is not configured')
  })

  it('installs stage-only with the exact contract argv and never activates', async () => {
    const { run, invocations } = runner(stagedGeneration())
    const cli = new EngineCli({ interpreter, run })
    const generation = await cli.install({ root, mirror: 'https://mirror.example/r2', channel: 'stable', cell: 'linux-cu128' })
    expect(invocations).toEqual([[
      ...cliPrefix, 'install', '--root', root, '--mirror', 'https://mirror.example/r2',
      '--channel', 'stable', '--cell', 'linux-cu128', '--stage-only', '--json',
    ]])
    expect(generation.generation).toBe(1)
    expect(generation.current).toBe(false)
    expect(generation.engine).toEqual(okEngine)
    expect(generation.controlPython).toBe(okControl)
    expect(generation.executionPython).toBe(okExecution)
  })

  it('adds --allow-local-http only when explicitly requested and forwards the channel', async () => {
    const { run, invocations } = runner(stagedGeneration())
    const cli = new EngineCli({ interpreter, run })
    await cli.install({
      root, mirror: 'http://127.0.0.1:9000', channel: 'github-live',
      cell: 'linux-cu128', allowLocalHttp: true,
    })
    expect(invocations[0]).toEqual([
      ...cliPrefix, 'install', '--root', root, '--mirror', 'http://127.0.0.1:9000',
      '--channel', 'github-live', '--cell', 'linux-cu128', '--stage-only', '--json',
      '--allow-local-http',
    ])
  })

  it('activates a generation by number with the exact argv', async () => {
    const { run, invocations } = runner(stagedGeneration({ current: true }))
    const cli = new EngineCli({ interpreter, run })
    const generation = await cli.activate({ root, generation: 2 })
    expect(invocations).toEqual([[...cliPrefix, 'activate', '--root', root, '--generation', '2', '--json']])
    expect(generation.current).toBe(true)
  })

  it('moves post-install operations to an installed generation control interpreter', async () => {
    const { run, invocations } = runner(stagedGeneration({ current: true }))
    const cli = new EngineCli({ interpreter, run })
    const installedControl = '/srv/dinkster/roots/project-a/engine-envs/manifest/control/bin/python'

    await cli.usingInterpreter(installedControl).activate({ root, generation: 2 })

    expect(invocations).toEqual([[
      installedControl, '-I', '-m', 'dinkster.cli',
      'activate', '--root', root, '--generation', '2', '--json',
    ]])
  })

  it('lists generations as an array with the exact argv', async () => {
    const { run, invocations } = runner(
      generationsJson(stagedGeneration(), stagedGeneration({ generation: 2, engine: null, controlPython: undefined, executionPython: undefined })),
    )
    const cli = new EngineCli({ interpreter, run })
    const generations = await cli.generations(root)
    expect(invocations).toEqual([[...cliPrefix, 'generations', '--root', root, '--json']])
    expect(generations).toHaveLength(2)
    expect(generations[1]).toEqual({ generation: 2, current: false, root, engine: null })
  })

  it('rolls back with the exact argv', async () => {
    const { run, invocations } = runner(stagedGeneration({ generation: 3, current: true }))
    const cli = new EngineCli({ interpreter, run })
    const generation = await cli.rollback(root)
    expect(invocations).toEqual([[...cliPrefix, 'rollback', '--root', root, '--json']])
    expect(generation.generation).toBe(3)
  })

  it('serves the exact long-lived child argv with a loopback host and instance id', () => {
    const spawns: string[][] = []
    const cli = new EngineCli({
      interpreter,
      spawn: (invocation) => {
        spawns.push([...invocation.argv])
        return fakeChild()
      },
    })
    const child = cli.serve({ root, dataRoot: '/srv/dinkster/data/project-a', port: 3639, instance: 'instance-7' })
    expect(spawns).toEqual([[
      ...cliPrefix, 'serve', '--root', root, '--data-root', '/srv/dinkster/data/project-a',
      '--host', '127.0.0.1', '--port', '3639', '--instance', 'instance-7',
    ]])
    expect(child.pid).toBe(4242)
  })

  it('rejects serve requests with ports outside 1..65535', () => {
    const cli = new EngineCli({ interpreter, spawn: (invocation) => fakeChild() })
    expect(() => cli.serve({ root, dataRoot: '/srv/dinkster/data', port: 0, instance: 'i' })).toThrow('1..65535')
    expect(() => cli.serve({ root, dataRoot: '/srv/dinkster/data', port: 65536, instance: 'i' })).toThrow('1..65535')
  })

  it('rejects a generation whose returned root does not match the requested root', async () => {
    const { run } = runner(generationsJson(stagedGeneration({ root: '/srv/dinkster/roots/other' })))
    const cli = new EngineCli({ interpreter, run })
    await expect(cli.generations(root)).rejects.toThrow('does not match the requested root')
  })

  it('rejects malformed CLI JSON', async () => {
    const { run } = runner('dinkster: traceback spilling into stdout')
    const cli = new EngineCli({ interpreter, run })
    await expect(cli.rollback(root)).rejects.toThrow('malformed JSON')
  })

  it('rejects generation records that are not valid shapes', async () => {
    const cases = [
      stagedGeneration({ generation: 0 }),
      stagedGeneration({ generation: 1.5 }),
      stagedGeneration({ current: 'yes' }),
      stagedGeneration({ engine: { ...okEngine, commit: 'tooshort' } }),
      stagedGeneration({ engine: { ...okEngine, baseId: 'A'.repeat(64) } }),
      stagedGeneration({ engine: { ...okEngine, cell: 'linux' } }),
      stagedGeneration({ engine: { ...okEngine, objects: ['zz'] } }),
      stagedGeneration({ engine: { ...okEngine, objects: [okEngine.manifestSha256, okEngine.manifestSha256] } }),
      stagedGeneration({ engine: { ...okEngine, unexpected: true } }),
      stagedGeneration({ engine: null, controlPython: okControl }),
      stagedGeneration({ controlPython: 'relative/python' }),
      stagedGeneration({ executionPython: 'relative/python' }),
      stagedGeneration({ unexpected: true }),
      'not-an-object',
    ]
    for (const stdout of cases) {
      const { run } = runner(stdout)
      const cli = new EngineCli({ interpreter, run })
      await expect(cli.generations(root)).rejects.toThrow()
    }
  })

  it('rejects ambiguous generation lists', async () => {
    for (const stdout of [
      generationsJson(stagedGeneration(), stagedGeneration()),
      generationsJson(stagedGeneration({ current: true }), stagedGeneration({ generation: 2, current: true })),
    ]) {
      const { run } = runner(stdout)
      await expect(new EngineCli({ interpreter, run }).generations(root)).rejects.toThrow()
    }
  })

  it('reports unexpected failures with a bounded stderr excerpt', async () => {
    const stderr = `dinkster: install failed\n${'x'.repeat(100_000)}\n\x1b[31mboom\x1b[0m`
    const { run } = runner('', { exitCode: 1, stderr })
    const cli = new EngineCli({ interpreter, run })
    const failure = await cli.install({ root, mirror: 'https://mirror.example/r2', channel: 'stable', cell: 'linux-cu128' }).catch((error: Error) => error)
    expect(failure.message).toContain('install failed with exit code 1')
    expect(failure.message).toContain('boom')
    expect(failure.message.length).toBeLessThan(ERROR_LIMIT_PLUS_HEADER)
  })
})
