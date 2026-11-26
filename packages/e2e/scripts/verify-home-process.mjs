import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { HomeProcess } from '../../desktop/src/home-process.ts'
import { acquireEnvironmentTools } from '../../desktop/src/environment-tools.ts'

assert(
  process.env.DINKSTER_DESKTOP_VERIFY_ROOT,
  'Set DINKSTER_DESKTOP_VERIFY_ROOT to a new evidence directory',
)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
for (const [name, path] of Object.entries({
  HOME: 'home',
  USERPROFILE: 'home',
  DINKSTER_HOME: 'home',
  XDG_DATA_HOME: 'xdg-data',
  XDG_CONFIG_HOME: 'xdg-config',
  LOCALAPPDATA: 'local-app-data',
  APPDATA: 'app-data',
})) {
  process.env[name] = join(root, path)
  await mkdir(process.env[name], { recursive: true })
}
await writeFile(
  join(root, 'home/model-settings.json'),
  JSON.stringify({ locations: [] }),
)
process.env.CUDA_VISIBLE_DEVICES = ''
process.env.DINKSTER_ACCELERATOR = 'cpu'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const pin = JSON.parse(
  await readFile(
    join(repository, 'packages/desktop/src/environment-tools-release.json'),
    'utf8',
  ),
)
const frontend = join(root, 'frontend')
await mkdir(frontend)
const html =
  '<!doctype html><title>Dinkster process boundary</title><p>Served by the real process</p>'
await writeFile(join(frontend, 'index.html'), html)
const tools = {
  manifest: `https://releases.dinkster.org/tools/${pin.label}/tools-manifest.json`,
  sha256: pin.manifest.sha256,
  release: `https://releases.dinkster.org/tools/${pin.label}`,
  cacheRoot: join(root, 'tools'),
}
const occupied = createServer((_request, response) =>
  response.setHeader('Content-Type', 'application/json').end('{}'),
)
await new Promise((done) => occupied.listen(0, '127.0.0.1', done))
const port = occupied.address().port
const options = { port, frontend, tools, dataDirectory: root }
const clients = []
const client = (overrides = {}) => {
  const home = new HomeProcess({ ...options, ...overrides })
  clients.push(home)
  return home
}
async function stopped(home) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      if (!(await home.status())) return
    } catch (error) {
      // A listener draining shutdown can reset a late status request. It is
      // not evidence of exit: keep checking until the port refuses connection.
      if (error.code !== 'ECONNRESET') throw error
    }
    await setTimeout(50)
  }
  assert.fail('The real Dinkster process did not release its listener')
}
const results = []
try {
  const refused = client()
  await assert.rejects(
    refused.start(),
    /does not answer as the Dinkster process/,
  )
  await refused.stop()
  assert.equal((await fetch(refused.url)).status, 200)
  results.push('An unrelated occupied port is refused and left running')
  await new Promise((done) => occupied.close(done))

  const broken = client({ python: join(root, 'missing-python') })
  await assert.rejects(broken.start(), { code: 'ENOENT' })
  assert.equal(await broken.status(), undefined)
  results.push('A missing interpreter fails without leaving a process')

  const owner = client()
  const started = await owner.start()
  assert.equal(started.role, 'home')
  assert.equal(started.frontend, frontend)
  assert.equal(await (await fetch(owner.url)).text(), html)
  assert.equal((await owner.ownedStatus('default')).instance, started.instance)
  const adopter = client({
    frontend: join(root, 'different-frontend'),
    python: join(root, 'must-not-run'),
  })
  assert.equal((await adopter.start()).supervisor.pid, started.supervisor.pid)
  await assert.rejects(
    adopter.ownedStatus('default'),
    /started by this Desktop/,
  )
  await adopter.stop()
  assert.equal((await owner.status()).supervisor.pid, started.supervisor.pid)
  results.push(
    'The real tools serve the requested frontend; adoption neither replaces nor stops it',
  )

  await owner.stop()
  await stopped(owner)
  results.push('The launcher stops the process it started')

  const stale = client()
  const old = await stale.start()
  const shutdown = await fetch(`${stale.url}/supervisor/shutdown`, {
    method: 'POST',
  })
  assert.equal((await shutdown.json()).status, 'stopped')
  await stopped(stale)
  const replay = createServer((_request, response) =>
    response
      .setHeader('Content-Type', 'application/json')
      .end(JSON.stringify(old)),
  )
  await new Promise((done) => replay.listen(port, '127.0.0.1', done))
  try {
    assert.equal((await stale.status()).instance, old.instance)
    await assert.rejects(stale.ownedStatus('default'))
  } finally {
    await new Promise((done) => replay.close(done))
  }
  results.push(
    'Replaying an owned child HTTP identity on a replacement listener cannot authorize native files',
  )
  const replacement = client()
  const next = await replacement.start()
  assert.notEqual(next.instance, old.instance)
  await assert.rejects(stale.ownedStatus('default'))
  assert.equal(
    (await replacement.ownedStatus('default')).instance,
    next.instance,
  )
  await stale.stop()
  assert.equal((await replacement.status()).instance, next.instance)
  await replacement.stop()
  await stopped(replacement)
  results.push('A stale launcher leaves a replacement process alone')

  const { python } = await acquireEnvironmentTools(tools)
  const first = client({ python })
  const second = client({ python })
  const [a, b] = await Promise.all([first.start(), second.start()])
  assert.equal(a.supervisor.pid, b.supervisor.pid)
  assert.equal(a.instance, b.instance)
  await first.stop()
  await second.stop()
  await stopped(first)
  results.push('Simultaneous launchers converge on one process and release it')
} finally {
  await Promise.allSettled(clients.map((home) => home.stop()))
  occupied.close()
  await writeFile(
    join(root, 'results.json'),
    `${JSON.stringify({ tools: pin, results }, null, 2)}\n`,
  )
}
console.log(results.join('\n'))
