import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, statfs, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { HomeProcess } from '../../desktop/dist/home-process.js'
import { WslHost, wslWindowsPath } from '../../desktop/dist/wsl.js'

assert.equal(process.platform, 'win32', 'Run on Windows, not inside WSL')
assert(process.env.DINKSTER_WSL_ARTIFACTS, 'Set an owned evidence directory')
assert(process.env.DINKSTER_WSL_TOOLS, 'Set the lane-local tools directory')
const artifacts = resolve(process.env.DINKSTER_WSL_ARTIFACTS)
const toolsDirectory = resolve(process.env.DINKSTER_WSL_TOOLS)
const portCollision = process.env.DINKSTER_WSL_PORT_COLLISION === '1'
const manifest = join(toolsDirectory, 'tools-manifest.json')
const tools = {
  manifest,
  release: toolsDirectory,
  sha256: createHash('sha256')
    .update(await readFile(manifest))
    .digest('hex'),
}
await mkdir(artifacts, { recursive: true })
const scratch = await mkdtemp(join(artifacts, 'wsl-home-'))
const data = join(scratch, 'desktop')
const host = new WslHost(data, tools)
const execute = promisify(execFile)
const receipt = { scratch, distribution: host.distribution, tools, steps: [] }
async function wsl(args) {
  const { stdout } = await execute('wsl.exe', args, {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 120_000,
  })
  return stdout
    .toString(stdout.includes(0) ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
}
const names = async () =>
  (await wsl(['--list', '--quiet'])).split(/\r?\n/).filter(Boolean).sort()
const original = await names()
assert(
  !original.some(
    (name) => name.toLowerCase() === host.distribution.toLowerCase(),
  ),
)
receipt.initialDistributions = original
for (const name of Object.keys(process.env)) {
  if (
    /TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
      name,
    )
  )
    delete process.env[name]
}
for (const [key, folder] of Object.entries({
  HOME: 'user-home',
  USERPROFILE: 'user-profile',
  DINKSTER_HOME: 'home',
  LOCALAPPDATA: 'local-data',
  APPDATA: 'app-data',
  XDG_DATA_HOME: 'xdg-data',
  XDG_CONFIG_HOME: 'xdg-config',
  XDG_CACHE_HOME: 'xdg-cache',
})) {
  process.env[key] = join(scratch, folder)
  await mkdir(process.env[key])
}
process.env.CUDA_VISIBLE_DEVICES = ''
process.env.DINKSTER_ACCELERATOR = 'cpu'
await writeFile(
  join(process.env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ version: 1, locations: [] }),
)
const frontend = join(scratch, 'frontend')
await mkdir(frontend)
await writeFile(
  join(frontend, 'index.html'),
  '<!doctype html><title>WSL Home evidence</title>',
)
const listener = createServer()
await new Promise((done) => listener.listen(0, '127.0.0.1', done))
const port = listener.address().port
await new Promise((done, fail) =>
  listener.close((error) => (error ? fail(error) : done())),
)
const home = new HomeProcess({ frontend, dataDirectory: data, tools, port })
const root = host.projectRoot('home-setup')
const query = (path, fields) => `${path}?${new URLSearchParams(fields)}`
async function request(path, method = 'GET', body, expected = 200) {
  receipt.lastRequest = { method, path }
  const response = await fetch(`${home.url}${path}`, {
    method,
    signal: AbortSignal.timeout(240_000),
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })
  const answer = await response.json()
  assert.equal(response.status, expected, JSON.stringify(answer))
  return answer
}
async function waitFor(read, accepted, label) {
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    const value = await read()
    if (accepted(value)) return value
    const free = await statfs(scratch)
    assert(free.bavail * free.bsize > 8 * 1024 ** 3, 'Stop below 8 GiB free')
    await setTimeout(250)
  }
  throw new Error(`${label} did not finish before its deadline`)
}
let prepared = false
let started = false
let collision
try {
  const free = await statfs(scratch)
  assert(free.bavail * free.bsize > 22 * 1024 ** 3, 'Start with 22 GiB free')
  await home.start()
  started = true
  const unavailable = await request(
    query('/supervisor/setup', { root }),
    'GET',
    undefined,
    400,
  )
  assert.match(unavailable.message, /not prepared/)
  prepared = true
  assert.equal((await host.prepare()).ready, true)
  await host.configureHome()
  const guestHome = wslWindowsPath(
    host.distribution,
    '/home/dinkster/.dinkster',
  )
  await mkdir(guestHome, { recursive: true })
  await writeFile(
    join(guestHome, 'model-settings.json'),
    JSON.stringify({ version: 1, locations: [] }),
  )
  const fields = { root, channel: 'nightly', variant: 'linux-cpu' }
  let plan = (await request(query('/supervisor/setup', fields))).plan
  assert.equal(plan.root.toLowerCase(), root.toLowerCase())
  assert.equal(plan.variant, 'linux-cpu')
  assert.equal(plan.refusal, null, JSON.stringify(plan))
  receipt.plan = plan
  if (!portCollision) {
    let job = await request(
      '/supervisor/setup',
      'POST',
      { planId: plan.id },
      202,
    )
    job = await request(`/supervisor/setup/${job.id}`, 'DELETE', undefined, 202)
    job = await waitFor(
      () => request(`/supervisor/setup/${job.id}`),
      (value) => !['running', 'cancelling'].includes(value.state),
      'Setup cancellation',
    )
    assert.equal(job.state, 'cancelled', JSON.stringify(job))
    receipt.cancelled = job
    receipt.steps.push(
      'Windows Home cancelled guest setup and awaited its cleanup',
    )
    plan = (await request(query('/supervisor/setup', fields))).plan
    assert.equal(plan.refusal, null, JSON.stringify(plan))
  }
  let job = await request('/supervisor/setup', 'POST', { planId: plan.id }, 202)
  job = await waitFor(
    () => request(`/supervisor/setup/${job.id}`),
    (value) => !['running', 'cancelling'].includes(value.state),
    'Guest setup',
  )
  assert.equal(job.state, 'completed', JSON.stringify(job))
  const status = await waitFor(
    () => request('/supervisor/status'),
    (value) => ['ready', 'failed'].includes(value.state),
    'Guest engine',
  )
  assert.equal(status.state, 'ready', JSON.stringify(status))
  assert.equal(status.open.root.toLowerCase(), root.toLowerCase())
  receipt.engine = status
  const config = JSON.parse(
    await readFile(join(data, 'wsl-context.json'), 'utf8'),
  )
  receipt.guest = JSON.parse(
    await wsl([
      '--distribution',
      host.distribution,
      '--user',
      'dinkster',
      '--cd',
      '/home/dinkster',
      '--exec',
      config.python,
      '-I',
      '-c',
      'import json,sys; from pathlib import Path; from dinkster_supervisor.environment_state import read_current,read_document; root=Path(sys.argv[1]); generation=read_current(root); snapshot=read_document(root/"builds"/str(generation)/"build.json"); records=[read_document(path) for path in (root/"runtime"/str(generation)).glob("*.json")]; print(json.dumps({"platform":sys.platform,"python":sys.executable,"variant":snapshot["variant"],"runtime":[{"name":r["name"],"pid":r["pid"],"executable":str((Path("/proc")/str(r["pid"])/"exe").resolve(strict=True))} for r in records]}))',
      '/home/dinkster/projects/home-setup',
    ]),
  )
  assert.equal(receipt.guest.platform, 'linux')
  assert.equal(receipt.guest.variant, 'linux-cpu')
  assert(
    receipt.guest.runtime.some(
      (row) =>
        row.name === 'main' && row.pid > 0 && row.executable.startsWith('/'),
    ),
  )
  if (!portCollision) {
    await request('/api/projects', 'POST', { id: 'wsl-engine-proof' })
    assert(
      (await request('/api/projects')).items.some(
        (project) => project.id === 'wsl-engine-proof',
      ),
    )
  }
  const settings = JSON.parse(
    await readFile(join(root, 'environment.json'), 'utf8'),
  )
  assert(
    settings.libraryRoot.startsWith('/'),
    'Guest settings must hold a Linux library root',
  )
  receipt.libraryRoot = settings.libraryRoot
  if (!portCollision) {
    receipt.packs = await request(
      query('/supervisor/installations/packs', { root }),
    )
    receipt.readiness = await request(
      query('/supervisor/installations/sandbox/readiness', { root }),
    )
  }
  await request('/supervisor/engine/stop', 'POST')
  if (portCollision) {
    const endpoint = JSON.parse(
      await wsl([
        '--distribution',
        host.distribution,
        '--user',
        'dinkster',
        '--exec',
        config.python,
        '-I',
        '-c',
        'import json; from pathlib import Path; from dinkster_supervisor.environment_runtime import engine_status; print(json.dumps(engine_status(Path("/home/dinkster/projects/home-setup"))))',
      ]),
    ).find((row) => row.name === 'main').url
    receipt.collisionRequests = []
    collision = createHttpServer((request, response) => {
      receipt.collisionRequests.push({
        method: request.method,
        path: request.url,
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          protocol: 1,
          state: 'ready',
          instance: 'unrelated-windows-process',
          supervisor: { pid: process.pid },
        }),
      )
    })
    await new Promise((done, fail) => {
      collision.once('error', fail)
      collision.listen(Number(new URL(endpoint).port), '127.0.0.1', done)
    })
    receipt.collisionProbe = await (
      await fetch(`${endpoint}/supervisor/status`, {
        signal: AbortSignal.timeout(5000),
      })
    ).json()
    assert.equal(receipt.collisionProbe.instance, 'unrelated-windows-process')
    await request('/supervisor/engine/restart', 'POST')
    receipt.collisionStatus = await waitFor(
      () => request('/supervisor/status'),
      (value) => ['ready', 'failed'].includes(value.state),
      'Windows port collision refusal',
    )
    assert.equal(receipt.collisionStatus.state, 'failed')
    receipt.collisionProject = await request('/api/projects', 'POST', {
      id: 'must-not-reach-windows',
    })
    receipt.collisionLibraryProject = JSON.parse(
      await wsl([
        '--distribution',
        host.distribution,
        '--user',
        'dinkster',
        '--cd',
        '/home/dinkster',
        '--exec',
        config.python,
        '-I',
        '-c',
        'import json,sys; from dinkster_library.client import LibraryClient;\nwith LibraryClient(__import__("pathlib").Path(sys.argv[1])) as client: print(json.dumps(client.call("projects.get",id="must-not-reach-windows")))',
        settings.libraryRoot,
      ]),
    )
    assert.equal(receipt.collisionProject.project.id, 'must-not-reach-windows')
    assert.equal(
      receipt.collisionLibraryProject.project.uid,
      receipt.collisionProject.project.uid,
    )
    await request('/api/nodes', 'GET', undefined, 503)
    assert(
      receipt.collisionRequests.every(
        (request) =>
          request.method === 'GET' && request.path === '/supervisor/status',
      ),
    )
    await request('/supervisor/engine/stop', 'POST')
    await new Promise((done) => collision.close(done))
    collision = undefined
    receipt.steps.push(
      'Home refused an unrelated Windows listener while project writes used the guest library',
    )
  } else {
    receipt.log = await request('/supervisor/engine/log')
    await request('/api/projects', 'POST', { id: 'wsl-proof' })
    assert(
      (await request('/api/projects')).items.some(
        (project) => project.id === 'wsl-proof',
      ),
    )
    assert.equal(
      JSON.parse(
        await wsl([
          '--distribution',
          host.distribution,
          '--user',
          'dinkster',
          '--cd',
          '/home/dinkster',
          '--exec',
          config.python,
          '-I',
          '-c',
          'import json,sys; from dinkster_library.client import LibraryClient;\nwith LibraryClient(__import__("pathlib").Path(sys.argv[1])) as client: print(json.dumps(client.call("projects.get",id="wsl-proof")))',
          settings.libraryRoot,
        ]),
      ).project.id,
      'wsl-proof',
    )
    receipt.steps.push(
      'Guest engine became ready; policy/readiness/log routes and stopped guest library answered through Windows Home',
    )
    await request('/supervisor/engine/restart', 'POST')
    assert.equal(
      (
        await waitFor(
          () => request('/supervisor/status'),
          (value) => ['ready', 'failed'].includes(value.state),
          'Guest restart',
        )
      ).state,
      'ready',
    )
  }
  receipt.success = true
} catch (error) {
  receipt.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause && {
      name: error.cause.name,
      message: error.cause.message,
      code: error.cause.code,
    },
  }
  receipt.failureHomeStatus = await home.status().catch((failure) => ({
    error: failure.message,
    code: failure.code,
  }))
  process.exitCode = 1
} finally {
  if (collision) await new Promise((done) => collision.close(done))
  if (started)
    await home.stop().catch((error) => {
      receipt.stopError = String(error)
      process.exitCode = 1
    })
  await host.close().catch((error) => {
    receipt.closeError = String(error)
    process.exitCode = 1
  })
  if (prepared) {
    const owner = await wsl([
      '--distribution',
      host.distribution,
      '--user',
      'root',
      '--exec',
      'cat',
      '/etc/dinkster-desktop-owner',
    ]).catch(() => '')
    if (owner === host.distribution && !receipt.stopError)
      await wsl(['--unregister', host.distribution]).catch((error) => {
        receipt.cleanupError = String(error)
        process.exitCode = 1
      })
    else {
      receipt.cleanupError =
        'Ownership or engine shutdown is unproven; retained distribution'
      process.exitCode = 1
    }
  }
  receipt.finalDistributions = await names()
  receipt.cleaned =
    JSON.stringify(original) === JSON.stringify(receipt.finalDistributions)
  if (!receipt.cleaned) process.exitCode = 1
  await writeFile(
    join(scratch, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
  console.log(`WSL Home evidence: ${scratch}`)
}
