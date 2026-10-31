import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

// Run online once, then offline with the same root and an OS-level outbound
// block. The offline probe refuses to count a merely disconnected mirror.
const mode = process.argv[2]
assert(['online', 'offline'].includes(mode), 'Choose online or offline')
const executablePath = resolve(process.env.DINKSTER_DESKTOP_EXECUTABLE ?? '')
const root = process.env.DINKSTER_BUNDLED_VERIFY_ROOT
assert(
  root && process.env.DINKSTER_DESKTOP_EXECUTABLE,
  'Set DINKSTER_DESKTOP_EXECUTABLE and DINKSTER_BUNDLED_VERIFY_ROOT',
)
assert.equal(resolve(root), root, 'Verification root must be absolute')
if (mode === 'online') await mkdir(root)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = join(root, 'desktop')
env.XDG_DATA_HOME = join(root, 'xdg-data')
env.XDG_CACHE_HOME = join(root, 'xdg-cache')
env.LOCALAPPDATA = join(root, 'local-app-data')
env.APPDATA = join(root, 'app-data')
env.UV_CACHE_DIR = join(root, 'uv-cache')
const app = await electron.launch({
  executablePath,
  args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
  env,
  timeout: 60_000,
})
let manager
try {
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  // Node fetch owns Desktop channel/tools acquisition; retain every request,
  // including failures, independently of whether a tool tree was reused.
  await app.evaluate(() => {
    globalThis.toolsVerificationRequests = []
    const original = globalThis.fetch
    globalThis.fetch = (input, init) => {
      globalThis.toolsVerificationRequests.push(String(input))
      return original(input, init)
    }
  })
  manager = await app.firstWindow()
  await manager
    .getByRole('heading', { name: 'Projects', exact: true })
    .waitFor()
  if (mode === 'online') {
    const server = createServer()
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const port = server.address().port
    await new Promise((done) => server.close(done))
    const request = {
      root: join(root, 'project'),
      operation: 'setup',
      channel: 'main',
      variant: process.platform === 'win32' ? 'win-cpu' : 'linux-cpu',
      mirrors: ['https://releases.dinkster.org'],
      data: join(root, 'store'),
      engine: 'main',
      gpus: [],
      port,
    }
    const project = {
      id: 'bundled-tools',
      name: 'Bundled tools local project',
      channel: 'main',
      root: request.root,
      engines: [{ id: 'main', name: 'main', kind: 'local', gpus: [], port }],
    }
    for (const operation of ['setup', 'update']) {
      console.log(
        `Installed Desktop ${operation}: reviewing real published ${request.variant} inputs`,
      )
      const planned = await manager.evaluate(
        async ({ project, request }) =>
          window.dinksterProjects.plan(project, request),
        {
          project,
          request:
            operation === 'setup' ? request : { root: request.root, operation },
        },
      )
      assert.equal(planned.result.status, 'planned')
      assert(planned.token)
      const result = await manager.evaluate(
        (token) => window.dinksterProjects.apply(token),
        planned.token,
      )
      assert.equal(result.status, 'applied')
      await writeFile(
        join(root, `${operation}.json`),
        JSON.stringify(result, null, 2),
      )
    }
  }
  const probe = await app.evaluate(
    () =>
      new Promise((resolve) => {
        const socket = process
          .getBuiltinModule('node:net')
          .connect(443, '1.1.1.1')
        socket.setTimeout(5000)
        socket.once('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.once('error', (error) => resolve(error.code))
        socket.once('timeout', () => {
          socket.destroy()
          resolve('timeout')
        })
      }),
  )
  if (mode === 'offline')
    assert.notEqual(
      probe,
      'connected',
      'OS-level block must deny external TCP, not just a channel URL',
    )
  else
    assert.equal(
      probe,
      'connected',
      'Online control must reach the same external TCP endpoint',
    )
  if (mode === 'online') {
    // Updates can move a live engine to a spare port. Stop before exercising
    // the saved binding, just as the cold offline relaunch does.
    await environmentOperations(app, join(root, 'project'), ['stop'])
  }
  await manager.reload()
  const opened = app.waitForEvent('window', { timeout: 120_000 })
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const engine = await opened
  await engine.waitForLoadState('domcontentloaded')
  assert.equal(new URL(engine.url()).hostname, '127.0.0.1')
  await expect(engine.locator('body')).not.toBeEmpty()
  const response = await engine.request.get(
    new URL('/api/health', engine.url()).href,
  )
  assert(
    response.ok(),
    `Started engine must answer /api/health, got ${response.status()}`,
  )
  await engine.screenshot({
    path: join(root, `${mode}-engine.png`),
    fullPage: true,
  })
  const results = await environmentOperations(app, join(root, 'project'), [
    'status',
    'doctor',
    'stop',
  ])
  assert.deepEqual(
    results.map((result) => result.operation),
    ['status', 'doctor', 'stop'],
  )
  assert(
    results.every((result) => ['clean', 'applied'].includes(result.status)),
  )
  const requests = await app.evaluate(
    () => globalThis.toolsVerificationRequests,
  )
  assert(
    !requests.some((url) => /dinkster-tools-|release-manifest\.json/.test(url)),
    'No runtime tools acquisition',
  )
  const cache = await app.evaluate(async ({ app }) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const path = process.getBuiltinModule('node:path')
    const root = path.join(app.getPath('userData'), 'environment-tools')
    const digests = (await fs.readdir(root)).filter((name) =>
      /^[a-f0-9]{64}$/.test(name),
    )
    assertOne(digests)
    function assertOne(values) {
      if (values.length !== 1)
        throw new Error('Expected one completed tools tree')
    }
    const python = path.join(
      root,
      digests[0],
      'payload/python',
      process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    )
    return {
      digest: digests[0],
      python,
      mtime: (await fs.stat(python)).mtimeMs,
    }
  })
  if (mode === 'offline')
    assert.deepEqual(
      cache,
      JSON.parse(await readFile(join(root, 'online.json'), 'utf8')).cache,
    )
  await writeFile(
    join(root, `${mode}.json`),
    JSON.stringify(
      { mode, executablePath, networkProbe: probe, cache, requests, results },
      null,
      2,
    ),
  )
  console.log(
    `Installed Desktop ${mode}: real local engine start, status, doctor, stop; no tools requests`,
  )
} catch (error) {
  await manager
    ?.screenshot({ path: join(root, `${mode}-failed.png`), fullPage: true })
    .catch(() => undefined)
  throw error
} finally {
  await app.close()
}

async function environmentOperations(app, projectRoot, operations) {
  return app.evaluate(
    async ({ app }, { projectRoot, operations }) => {
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(joinPath(app.getAppPath(), 'package.json'))
      function joinPath(...parts) {
        return process.getBuiltinModule('node:path').join(...parts)
      }
      const { EnvironmentClient } = require(
        joinPath(app.getAppPath(), 'dist/environment.js'),
      )
      const pin = require(
        joinPath(app.getAppPath(), 'dist/environment-tools-release.json'),
      )
      const client = new EnvironmentClient(
        undefined,
        undefined,
        undefined,
        {
          manifest: joinPath(process.resourcesPath, 'tools', pin.manifest.name),
          sha256: pin.manifest.sha256,
          release: joinPath(process.resourcesPath, 'tools'),
          cacheRoot: joinPath(app.getPath('userData'), 'environment-tools'),
        },
        app.getVersion(),
      )
      try {
        const results = []
        for (const operation of operations)
          results.push(
            await client.run(
              { root: projectRoot, operation, engine: 'main' },
              true,
            ),
          )
        return results
      } finally {
        await client.dispose()
      }
    },
    { projectRoot, operations },
  )
}
