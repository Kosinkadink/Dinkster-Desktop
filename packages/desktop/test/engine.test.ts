import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type Server } from 'node:http'
import * as childProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineRuntime, supervisorArguments, waitForSupervisorReady, type EngineRuntimeOptions } from '../src/engine.js'
import * as release from '../src/release.js'
import { ENGINE_RELEASE } from '../src/release.js'
import * as io from '../src/io.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []
const servers: Server[] = []
const runtimes: EngineRuntime[] = []
const nativeBackend = release.torchBackend

const canonicalPathAssertion = `
  function canonicalPath(path) {
    const { realpathSync } = require('node:fs')
    const { dirname, basename, join } = require('node:path')
    try { return realpathSync(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return join(realpathSync(dirname(path)), basename(path))
    }
  }
`

beforeEach(() => {
  vi.spyOn(release, 'torchBackend').mockImplementation((accelerator) => nativeBackend(accelerator, 'win32', 'x64'))
})

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

async function fixture(syncSource: string, catalogSource = ''): Promise<{ data: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dinkster-engine-test-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'sync'), syncSource)
  await writeFile(join(source, 'run'), catalogSource)
  await writeFile(join(source, ENGINE_RELEASE.aimdo.archive), 'native wheel fixture')
  return { data: join(root, 'data'), source }
}

async function cachedFixture(nativeProfile?: string, commit = ENGINE_RELEASE.commit, variant = 'cpu'): Promise<{ data: string; source: string; marker: string }> {
  const fresh = await fixture('throw new Error("cached releases must not resync")', 'console.error("catalog fixture"); process.exit(1)')
  const source = join(fresh.data, 'engine', 'releases', `${commit}-${variant}`)
  await mkdir(dirname(source), { recursive: true })
  await rename(fresh.source, source)
  await addSupervisor(source)
  const marker = join(source, '.dinkster-desktop-release.json')
  await writeFile(marker, JSON.stringify({ commit, variant, nativeProfile }))
  return { data: fresh.data, source, marker }
}

async function addSupervisor(source: string): Promise<void> {
  const bin = process.platform === 'win32' ? join(source, '.venv', 'Scripts') : join(source, '.venv', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, process.platform === 'win32' ? 'dinkster-supervisor.exe' : 'dinkster-supervisor'), 'not an executable')
  await writeFile(join(bin, process.platform === 'win32' ? 'dinkster-serve.exe' : 'dinkster-serve'), 'not an executable')
}

function waitForPhase(runtime: EngineRuntime, phase: string): Promise<void> {
  if (runtime.status.phase === phase) return Promise.resolve()
  return new Promise((resolve) => {
    const listener = (status: { phase: string }) => {
      if (status.phase !== phase) return
      runtime.off('status', listener)
      resolve()
    }
    runtime.on('status', listener)
  })
}

describe('EngineRuntime lifecycle', () => {
  it('installs the verified bundled wheel after sync and before catalog preparation', async () => {
    const { data, source } = await fixture(
      `const assert = require('node:assert/strict')
       assert.equal(process.env.UV_CONSTRAINT, undefined)
       assert.equal(process.env.UV_TORCH_BACKEND, undefined)
       require('node:fs').writeFileSync('steps', 'sync\\n')`,
      `const assert = require('node:assert/strict')
       const fs = require('node:fs')
       const { join } = require('node:path')
       const { fileURLToPath } = require('node:url')
       ${canonicalPathAssertion}
       assert.equal(process.env.UV_TORCH_BACKEND, 'cpu')
       assert.equal(canonicalPath(process.env.UV_CONSTRAINT), canonicalPath(join(process.cwd(), '.dinkster-native', 'constraints.txt')))
       const constraints = fs.readFileSync(process.env.UV_CONSTRAINT, 'utf8')
       assert.ok(constraints.includes('torch==${ENGINE_RELEASE.cudaTorch.version.split('+')[0]}+cpu'))
       assert.ok(constraints.includes('torchvision==${ENGINE_RELEASE.cudaTorch.torchvisionVersion}+cpu'))
       const wheel = join(process.cwd(), '.dinkster-native', ${JSON.stringify(ENGINE_RELEASE.aimdo.archive)})
       const pinnedWheel = constraints.split('\\n').find((line) => line.startsWith('comfy-aimdo @ '))
       assert.ok(pinnedWheel)
       assert.equal(canonicalPath(fileURLToPath(pinnedWheel.slice('comfy-aimdo @ '.length))), canonicalPath(wheel))
       assert.equal(fs.readFileSync(wheel, 'utf8'), 'native wheel fixture')
       fs.appendFileSync('steps', 'catalog\\n'); console.error('catalog fixture'); process.exit(1)`,
    )
    await addSupervisor(source)
    await writeFile(join(source, 'pip'), 'require("node:fs").appendFileSync("steps", "aimdo\\n")')
    const wheel = join(source, ENGINE_RELEASE.aimdo.archive)
    const verify = vi.spyOn(io, 'verifyFile').mockResolvedValue(undefined)
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, uvExecutable: process.execPath, aimdoWheel: wheel, variant: 'cpu' })
    await expect(runtime.start()).rejects.toThrow('catalog fixture')
    expect(verify).toHaveBeenCalledWith(wheel, ENGINE_RELEASE.aimdo.sha256)
    expect(await readFile(join(source, 'steps'), 'utf8')).toBe('sync\naimdo\ncatalog\n')
  })

  it.each([undefined, 'outdated', ENGINE_RELEASE.nativeProfile].flatMap((profile) =>
    (['cpu', 'cuda', 'nvidia'] as const).map((variant) => ({ profile, variant })),
  ))('never mutates an installed $variant native profile ($profile)', async ({ profile, variant }) => {
    const { data, source, marker } = await cachedFixture(profile, ENGINE_RELEASE.commit, variant)
    const installed = await readFile(marker, 'utf8')
    const wheel = join(source, ENGINE_RELEASE.aimdo.archive)
    const verify = vi.spyOn(io, 'verifyFile').mockResolvedValue(undefined)
    const runtime = createRuntime({ dataDirectory: data, uvExecutable: process.execPath, aimdoWheel: wheel, variant: variant === 'nvidia' ? 'cuda' : variant })
    await expect(runtime.start()).rejects.toThrow(profile === ENGINE_RELEASE.nativeProfile ? 'catalog fixture' : 'different native runtime profile')
    expect(await readFile(marker, 'utf8')).toBe(installed)
    expect(verify).not.toHaveBeenCalled()
  })

  it.each([
    ['mps', 'win32', 'x64'], ['rocm', 'win32', 'x64'], ['xpu', 'win32', 'x64'],
    ['cpu', 'linux', 'x64'], ['cuda', 'linux', 'x64'], ['cpu', 'darwin', 'arm64'],
  ] as const)('does not install or apply Windows overlays for %s on %s/%s', async (variant, platform, arch) => {
    vi.mocked(release.torchBackend).mockImplementation((accelerator) => nativeBackend(accelerator, platform, arch))
    const assertion = `
      const assert = require('node:assert/strict')
      assert.equal(process.env.DINKSTER_ACCELERATOR, ${JSON.stringify(variant)})
      assert.equal(process.env.UV_CONSTRAINT, undefined)
      assert.equal(process.env.UV_TORCH_BACKEND, undefined)
    `
    const { data, source } = await fixture(assertion, assertion)
    await addSupervisor(source)
    const native = join(source, '.dinkster-native')
    await mkdir(native)
    await writeFile(join(native, 'constraints.txt'), 'Windows-only constraints')
    const verify = vi.spyOn(io, 'verifyFile')
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, uvExecutable: process.execPath, aimdoWheel: 'unavailable.whl', variant })
    await expect(runtime.start()).rejects.toThrow()
    const launch = vi.mocked(childProcess.spawn).mock.calls.find(([command]) => command.includes('dinkster-supervisor'))
    expect(launch?.[2]?.env?.['DINKSTER_ACCELERATOR']).toBe(variant)
    expect(launch?.[2]?.env?.['UV_CONSTRAINT']).toBeUndefined()
    expect(launch?.[2]?.env?.['UV_TORCH_BACKEND']).toBeUndefined()
    expect(verify).not.toHaveBeenCalled()
    expect(await readFile(join(native, 'constraints.txt'), 'utf8')).toBe('Windows-only constraints')
  })

  it('preserves the packaged input after a native checksum failure', async () => {
    const { data, source } = await fixture('')
    await addSupervisor(source)
    const wheel = join(source, ENGINE_RELEASE.aimdo.archive)
    await writeFile(wheel, 'corrupted wheel')
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, uvExecutable: process.execPath, aimdoWheel: wheel, variant: 'cpu' })
    await expect(runtime.start()).rejects.toThrow('checksum mismatch')
    expect(await readFile(wheel, 'utf8')).toBe('corrupted wheel')
  })

  it('pins and verifies Windows CUDA Torch after sync without reinstalling it on restart', async () => {
    const { data, source, marker } = await cachedFixture(undefined, ENGINE_RELEASE.commit, 'cuda')
    await writeFile(join(source, 'sync'), '')
    const wheel = join(source, ENGINE_RELEASE.aimdo.archive)
    const cudaWheel = join(data, 'engine', 'native', ENGINE_RELEASE.cudaTorch.sha256, ENGINE_RELEASE.cudaTorch.archive)
    const verify = vi.spyOn(io, 'verifyFile').mockResolvedValue(undefined)
    const download = vi.spyOn(io, 'download').mockImplementation(async (_url, destination) => {
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, 'CUDA wheel fixture')
    })
    await writeFile(join(source, 'pip'), `
      const assert = require('node:assert/strict')
      assert.deepEqual(process.argv.slice(-2), ${JSON.stringify([wheel, cudaWheel])})
      assert.ok(process.argv.includes('--no-index'))
      assert.ok(process.argv.includes('--no-deps'))
      require('node:fs').appendFileSync('native-installs', 'installed\\n')
    `)
    await writeFile(join(source, 'run'), `
      if (process.argv[3] === 'python') {
        const assert = require('node:assert/strict')
        assert.equal(process.argv[2], '--no-sync')
        assert.ok(process.argv[5].includes('torch.__version__'))
        assert.ok(process.argv[5].includes('torch.version.cuda'))
        assert.ok(process.argv[5].includes(${JSON.stringify(ENGINE_RELEASE.cudaTorch.version)}))
        require('node:fs').writeFileSync('cuda-verified', 'verified')
      } else {
        console.error('catalog fixture')
        process.exit(1)
      }
    `)
    const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, uvExecutable: process.execPath, aimdoWheel: wheel, variant: 'cuda' })
    await expect(runtime.start()).rejects.toThrow('catalog fixture')
    expect(download).toHaveBeenCalledWith(ENGINE_RELEASE.cudaTorch.url, cudaWheel, expect.any(AbortSignal))
    expect(verify).toHaveBeenCalledWith(cudaWheel, ENGINE_RELEASE.cudaTorch.sha256)
    expect(await readFile(join(source, 'cuda-verified'), 'utf8')).toBe('verified')
    download.mockClear()
    verify.mockClear()
    await writeFile(marker, JSON.stringify({ commit: ENGINE_RELEASE.commit, variant: 'cuda', nativeProfile: ENGINE_RELEASE.nativeProfile }))
    await writeFile(join(source, 'sync'), 'throw new Error("cached releases must not resync")')
    const cached = createRuntime({ dataDirectory: data, uvExecutable: process.execPath, aimdoWheel: wheel, variant: 'cuda' })
    await expect(cached.start()).rejects.toThrow('catalog fixture')
    expect(download).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(await readFile(join(source, 'native-installs'), 'utf8')).toBe('installed\n')
  })

  it('restores older installed releases without requiring new catalog commands or native pins', async () => {
    const commit = 'a'.repeat(40)
    const { data, marker } = await cachedFixture(undefined, commit)
    const installed = await readFile(marker, 'utf8')
    const runtime = createRuntime({ dataDirectory: data, uvExecutable: process.execPath, aimdoWheel: 'unavailable.whl', releaseCommit: commit, variant: 'cpu' })
    const rejected = expect(runtime.start()).rejects.toThrow('cancelled')
    await waitForPhase(runtime, 'starting')
    await runtime.stop()
    await rejected
    expect(await readFile(marker, 'utf8')).toBe(installed)
  })

  it('restores the saved worker index rather than the current release index', async () => {
    const commit = 'a'.repeat(40)
    const { data, source } = await cachedFixture(undefined, commit, 'nvidia')
    const native = join(source, '.dinkster-native')
    await mkdir(native)
    await writeFile(join(native, 'constraints.txt'), 'torch==2.8.0+cu128\n')
    await writeFile(join(native, 'torch-backend'), 'cu128')
    const spawn = vi.mocked(childProcess.spawn)
    const runtime = createRuntime({ dataDirectory: data, uvExecutable: process.execPath, aimdoWheel: 'unavailable.whl', releaseCommit: commit, variant: 'cuda' })
    await expect(runtime.start()).rejects.toThrow()
    const launch = spawn.mock.calls.find(([command]) => command.includes('dinkster-supervisor'))
    expect(launch?.[2]?.env?.['UV_CONSTRAINT']).toBe(join(native, 'constraints.txt'))
    expect(launch?.[2]?.env?.['UV_TORCH_BACKEND']).toBe('cu128')
    expect(launch?.[2]?.env?.['DINKSTER_ACCELERATOR']).toBe('cuda')
  })

  it('rejects a foreign ready endpoint before spawning a candidate', async () => {
    const { data, source } = await fixture('')
    await addSupervisor(source)
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"state":"ready"}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('foreign server did not bind')
    const runtime = createRuntime({
      dataDirectory: data,
      sourceDirectory: source,
      uvExecutable: process.execPath,
      variant: 'cpu',
      port: address.port,
    })
    await expect(runtime.start()).rejects.toThrow('owned by another process')
    expect(childProcess.spawn).not.toHaveBeenCalled()
    expect(runtime.status.phase).toBe('failed')
  })

  it('does not start the supervisor when catalog preparation fails', async () => {
    const { data, source } = await fixture('', `
      require('node:assert/strict').equal(process.env.DINKSTER_ACCELERATOR, 'cuda')
      console.error('catalog preparation reported unhealthy packs')
      process.exit(1)
    `)
    await addSupervisor(source)
    const runtime = createRuntime({
      dataDirectory: data,
      sourceDirectory: source,
      uvExecutable: process.execPath,
      variant: 'cuda',
    })
    await expect(runtime.start()).rejects.toThrow('catalog preparation reported unhealthy packs')
    expect(runtime.status.phase).toBe('failed')
  })

  it('terminates catalog preparation and its worker when startup is cancelled', async () => {
    const { data, source } = await fixture('', `
      const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      worker.once('spawn', () => {
        require('node:fs').writeFileSync('catalog-child.pid', String(worker.pid))
        console.log('catalog preparation started')
      })
      setInterval(() => {}, 1000)
    `)
    await addSupervisor(source)
    const runtime = createRuntime({
      dataDirectory: data,
      sourceDirectory: source,
      uvExecutable: process.execPath,
      variant: 'cpu',
    })
    const preparing = new Promise<void>((resolve) => {
      runtime.on('status', (status: { detail: string }) => {
        if (status.detail === 'catalog preparation started') resolve()
      })
    })
    const rejected = expect(runtime.start()).rejects.toThrow('cancelled')
    await preparing
    const workerPid = Number(await readFile(join(source, 'catalog-child.pid'), 'utf8'))
    try {
      await runtime.stop()
      await rejected
      expect(runtime.status.phase).toBe('stopped')
      expect(() => process.kill(workerPid, 0)).toThrow()
    } finally {
      try { process.kill(workerPid) } catch { /* The worker has already exited. */ }
    }
  })

  it('rechecks port ownership after environment setup', async () => {
    const { data, source } = await fixture(`
      const assert = require('node:assert/strict')
      const { join } = require('node:path')
      ${canonicalPathAssertion}
      assert.equal(canonicalPath(process.env.UV_PROJECT_ENVIRONMENT), canonicalPath(join(process.cwd(), '.venv')))
    `, `
      const assert = require('node:assert/strict')
      const { dirname, delimiter, join } = require('node:path')
      ${canonicalPathAssertion}
      const library = join(dirname(process.cwd()), 'data', 'library')
      const args = process.argv.slice(2)
      assert.deepEqual(args.slice(0, -1), ['--no-sync', 'dinkster-pack', 'prepare-catalogs', '--defaults', '--library-root'])
      assert.equal(canonicalPath(args.at(-1)), canonicalPath(library))
      assert.equal(canonicalPath(process.env.UV_PROJECT_ENVIRONMENT), canonicalPath(join(process.cwd(), '.venv')))
      assert.equal(canonicalPath(process.env.DINKSTER_COMFYUI_PYTHON), canonicalPath(process.platform === 'win32' ? join(process.cwd(), '.venv', 'Scripts', 'python.exe') : join(process.cwd(), '.venv', 'bin', 'python')))
      assert.equal(process.env.DINKSTER_ACCELERATOR, 'cpu')
      assert.equal(canonicalPath(process.env.PATH.split(delimiter)[0]), canonicalPath(dirname(process.execPath)))
      require('node:fs').writeFileSync(join(library, 'catalog-completed'), 'ready')
    `)
    await addSupervisor(source)
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const runtime = new EngineRuntime({
      dataDirectory: data, sourceDirectory: source,
      uvExecutable: process.execPath, variant: 'cpu', port: address.port,
    })
    let setupStarted = false
    runtime.on('status', (status: { phase: string }) => {
      if (status.phase !== 'installing' || setupStarted) return
      setupStarted = true
      server.listen(address.port, '127.0.0.1')
    })
    try {
      await expect(runtime.start()).rejects.toThrow('owned by another process')
      expect(setupStarted).toBe(true)
      expect(await readFile(join(data, 'library', 'catalog-completed'), 'utf8')).toBe('ready')
      expect(runtime.status.phase).toBe('failed')
    } finally {
      await runtime.stop()
    }
  })

  it('aborts a stalled supervisor response promptly', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch
    try {
      const controller = new AbortController()
      const waiting = waitForSupervisorReady({
        port: 3639,
        instance: 'test-instance',
        variant: 'cpu',
        signal: controller.signal,
        exitCode: () => null,
        update: () => undefined,
      })
      controller.abort()
      await expect(waiting).rejects.toThrow('cancelled')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects ready status from a different supervisor instance', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ state: 'ready', instance: 'foreign' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      await expect(waitForSupervisorReady({
        port: 3639,
        instance: 'launched',
        variant: 'cpu',
        signal: new AbortController().signal,
        exitCode: () => null,
        update: () => undefined,
      })).rejects.toThrow('identity did not match')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('bounds a stalled supervisor request by the startup deadline', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true })
    })) as typeof fetch
    try {
      await expect(waitForSupervisorReady({
        port: 3639,
        instance: 'test-instance',
        variant: 'cpu',
        signal: new AbortController().signal,
        timeoutMs: 30,
        requestTimeoutMs: 10,
        exitCode: () => null,
        update: () => undefined,
      })).rejects.toThrow('did not become ready')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('enables durable local mount grants for both desktop launch paths', () => {
    const arguments_ = supervisorArguments('source', 'library', 3639, 'test-instance')
    expect(arguments_).toContain('test-instance')
    expect(arguments_).toContain('--allow-mount-changes')
    expect(arguments_.slice(-3)).toEqual(['--library-root', 'library', '--allow-mount-changes'])
  })

  it('aborts a first-run uv download before it writes an environment', async () => {
    const { data, source } = await fixture('')
    const platform = vi.spyOn(release, 'supportedPlatform').mockReturnValue('linux-x64')
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch
    try {
      const runtime = createRuntime({ dataDirectory: data, sourceDirectory: source, variant: 'cpu' })
      const started = runtime.start()
      const rejected = expect(started).rejects.toThrow()
      await waitForPhase(runtime, 'downloading')
      await runtime.stop()
      await rejected
      expect(runtime.status.phase).toBe('stopped')
      expect(existsSync(join(source, '.venv'))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      platform.mockRestore()
    }
  })

  it('terminates uv sync when startup is cancelled', async () => {
    const { data, source } = await fixture('setInterval(() => {}, 1000)')
    const runtime = createRuntime({
      dataDirectory: data,
      sourceDirectory: source,
      uvExecutable: process.execPath,
      variant: 'cpu',
      port: 0,
    })
    const started = runtime.start()
    const rejected = expect(started).rejects.toThrow('cancelled')
    await waitForPhase(runtime, 'installing')
    await runtime.stop()
    await rejected
    expect(runtime.status.phase).toBe('stopped')
  })

  it('cancels after sync without spawning the supervisor', async () => {
    const { data, source } = await fixture('')
    await addSupervisor(source)
    const runtime = createRuntime({
      dataDirectory: data,
      sourceDirectory: source,
      uvExecutable: process.execPath,
      variant: 'cpu',
      port: 0,
    })
    const started = runtime.start()
    const rejected = expect(started).rejects.toThrow('cancelled')
    await waitForPhase(runtime, 'starting')
    await runtime.stop()
    await rejected
    expect(runtime.status.phase).toBe('stopped')
  })

  it('turns supervisor spawn errors into a typed failed state', async () => {
    const { data, source } = await fixture('')
    await addSupervisor(source)
    const runtime = createRuntime({
      dataDirectory: data,
      sourceDirectory: source,
      uvExecutable: process.execPath,
      variant: 'cpu',
      port: 0,
    })
    await expect(runtime.start()).rejects.toThrow()
    expect(runtime.status).toMatchObject({ phase: 'failed', detail: 'Dinkster could not start' })
  })
})
