import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type Server } from 'node:http'
import * as childProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { availableLoopbackPort, EngineRuntime, supervisorArguments, waitForSupervisorReady, type EngineRuntimeOptions } from '../src/engine.js'
import * as release from '../src/release.js'
import { ENGINE_RELEASE } from '../src/release.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []
const servers: Server[] = []
const runtimes: EngineRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

function createRuntime(options: EngineRuntimeOptions): EngineRuntime {
  const runtime = new EngineRuntime({ port: 0, ...options })
  runtimes.push(runtime)
  return runtime
}

async function fixture(): Promise<{ data: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-engine-test-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  return { data: join(root, 'data'), source }
}

async function addSupervisor(source: string): Promise<void> {
  const bin = process.platform === 'win32' ? join(source, '.venv', 'Scripts') : join(source, '.venv', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, process.platform === 'win32' ? 'dinkster-supervisor.exe' : 'dinkster-supervisor'), 'not an executable')
}

describe('EngineRuntime checkout lifecycle', () => {
  it('refuses an unprepared checkout without downloading or creating an environment', async () => {
    const { data, source } = await fixture()
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network request'))
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, variant: 'cpu' })
    await expect(runtime.start()).rejects.toThrow('locked environment did not create')
    expect(await readdir(source)).toEqual([])
    expect(existsSync(data)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('requires an existing checkout instead of bootstrapping an engine', async () => {
    const { data } = await fixture()
    const runtime = createRuntime({ dataDirectory: data, variant: 'cpu' })
    await expect(runtime.start()).rejects.toThrow('Use the project manager and dinkster-env')
    expect(existsSync(data)).toBe(false)
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it.each(['cpu', 'cuda', 'nvidia'])('does not rewrite an existing %s environment or native profile', async (variant) => {
    const { data } = await fixture()
    const source = join(data, 'engine', 'releases', `${ENGINE_RELEASE.commit}-${variant}`)
    await addSupervisor(source)
    const marker = join(source, '.dinkster-desktop-release.json')
    const installed = JSON.stringify({ commit: ENGINE_RELEASE.commit, variant, nativeProfile: 'existing' })
    await writeFile(marker, installed)
    const runtime = createRuntime({ dataDirectory: data, variant: variant === 'nvidia' ? 'cuda' : variant as 'cpu' | 'cuda' })
    await expect(runtime.start()).rejects.toThrow()
    expect(await readFile(marker, 'utf8')).toBe(installed)
    expect(await readdir(source)).toEqual(expect.arrayContaining(['.venv', '.dinkster-desktop-release.json']))
    expect(existsSync(join(source, '.dinkster-native'))).toBe(false)
  })

  it('restores the saved worker index rather than the current release index', async () => {
    vi.spyOn(release, 'torchBackend').mockReturnValue('cu130')
    const { data } = await fixture()
    const commit = 'a'.repeat(40)
    const source = join(data, 'engine', 'releases', `${commit}-nvidia`)
    await addSupervisor(source)
    await writeFile(join(source, '.dinkster-desktop-release.json'), JSON.stringify({ commit, variant: 'nvidia' }))
    const native = join(source, '.dinkster-native')
    await mkdir(native)
    await writeFile(join(native, 'constraints.txt'), 'torch==2.8.0+cu128\n')
    await writeFile(join(native, 'torch-backend'), 'cu128')
    const runtime = createRuntime({ dataDirectory: data, releaseCommit: commit, variant: 'cuda' })
    await expect(runtime.start()).rejects.toThrow()
    const launch = vi.mocked(childProcess.spawn).mock.calls.find(([command]) => command.includes('dinkster-supervisor'))
    expect(launch?.[2]?.env?.['UV_CONSTRAINT']).toBe(join(native, 'constraints.txt'))
    expect(launch?.[2]?.env?.['UV_TORCH_BACKEND']).toBe('cu128')
    expect(launch?.[2]?.env?.['DINKSTER_ACCELERATOR']).toBe('cuda')
    expect(await readFile(join(native, 'constraints.txt'), 'utf8')).toBe('torch==2.8.0+cu128\n')
  })

  it('rejects a foreign ready endpoint before spawning a candidate', async () => {
    const { data, source } = await fixture()
    await addSupervisor(source)
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"state":"ready"}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('foreign server did not bind')
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, variant: 'cpu', port: address.port })
    await expect(runtime.start()).rejects.toThrow('owned by another process')
    expect(childProcess.spawn).not.toHaveBeenCalled()
    expect(runtime.status.phase).toBe('failed')
  })

  it('rechecks port ownership after checkout inspection', async () => {
    const { data, source } = await fixture()
    await addSupervisor(source)
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, variant: 'cpu', port: address.port })
    runtime.on('status', (status: { phase: string }) => {
      if (status.phase === 'starting') server.listen(address.port, '127.0.0.1')
    })
    await expect(runtime.start()).rejects.toThrow('owned by another process')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('cancels after checkout inspection without spawning the supervisor', async () => {
    const { data, source } = await fixture()
    await addSupervisor(source)
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, variant: 'cpu' })
    runtime.on('status', (status: { phase: string }) => {
      if (status.phase === 'starting') void runtime.stop()
    })
    await expect(runtime.start()).rejects.toThrow('cancelled')
    await runtime.stop()
    expect(runtime.status.phase).toBe('stopped')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('turns supervisor spawn errors into a typed failed state', async () => {
    const { data, source } = await fixture()
    await addSupervisor(source)
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, variant: 'cpu' })
    await expect(runtime.start()).rejects.toThrow()
    expect(runtime.status).toMatchObject({ phase: 'failed', detail: 'Dinkster could not start' })
  })

  it('starts, restarts and stops a provisioned supervisor without running checkout setup', async () => {
    const { data, source } = await fixture()
    await addSupervisor(source)
    const script = join(source, 'supervisor.cjs')
    await writeFile(script, `
      const http = require('node:http');
      const args = process.argv.slice(2);
      const instance = args[args.indexOf('--instance') + 1];
      const port = Number(args[args.indexOf('--port') + 1]);
      let restarts = 0;
      http.createServer((request, response) => {
        if (request.url === '/supervisor/engine/restart') restarts++;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({state:'ready', instance, restarts,
          accelerator:process.env.DINKSTER_ACCELERATOR,
          python:process.env.DINKSTER_EXECUTION_PYTHON}));
      }).listen(port, '127.0.0.1');
    `)
    const actual = await vi.importActual<typeof childProcess>('node:child_process')
    vi.mocked(childProcess.spawn).mockImplementation(((command, args, options) =>
      command.includes('dinkster-supervisor')
        ? actual.spawn(process.execPath, [script, ...args], options)
        : actual.spawn(command, args, options)) as typeof childProcess.spawn)
    const port = await availableLoopbackPort()
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, variant: 'cpu', port })
    await runtime.start()
    expect(runtime.status).toMatchObject({ phase: 'running', variant: 'cpu' })
    await runtime.start()
    const status = await (await fetch(`http://127.0.0.1:${port}/supervisor/status`)).json()
    expect(status).toMatchObject({ state: 'ready', restarts: 1, accelerator: 'cpu' })
    expect(status.python).toBe(process.platform === 'win32' ? join(source, '.venv', 'Scripts', 'python.exe') : join(source, '.venv', 'bin', 'python'))
    expect((await readdir(source)).sort()).toEqual(['.venv', 'supervisor.cjs'])
    await runtime.stop()
    expect(runtime.status.phase).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/supervisor/status`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  })

  it('aborts a stalled supervisor response promptly', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const controller = new AbortController()
    const waiting = waitForSupervisorReady({
      port: 3639, instance: 'test-instance', variant: 'cpu', signal: controller.signal,
      exitCode: () => null, update: () => undefined,
    })
    controller.abort()
    await expect(waiting).rejects.toThrow('cancelled')
  })

  it('rejects ready status from a different supervisor instance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ state: 'ready', instance: 'foreign' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    await expect(waitForSupervisorReady({
      port: 3639, instance: 'launched', variant: 'cpu', signal: new AbortController().signal,
      exitCode: () => null, update: () => undefined,
    })).rejects.toThrow('identity did not match')
  })

  it('bounds a stalled supervisor request by the startup deadline', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true })
    }))
    await expect(waitForSupervisorReady({
      port: 3639, instance: 'test-instance', variant: 'cpu', signal: new AbortController().signal,
      timeoutMs: 30, requestTimeoutMs: 10, exitCode: () => null, update: () => undefined,
    })).rejects.toThrow('did not become ready')
  })

  it('enables durable local mount grants for both desktop launch paths', () => {
    const arguments_ = supervisorArguments('source', 'library', 3639, 'test-instance')
    expect(arguments_).toContain('test-instance')
    expect(arguments_.slice(-3)).toEqual(['--library-root', 'library', '--allow-mount-changes'])
    expect(dirname(arguments_[arguments_.indexOf('--') + 1]!)).toContain('.venv')
  })
})
