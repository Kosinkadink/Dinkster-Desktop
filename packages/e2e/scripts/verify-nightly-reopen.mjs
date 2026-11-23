import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
import { installationManager } from './installation-manager.mjs'

assert(
  process.env.DINKSTER_DESKTOP_EXECUTABLE,
  'Supply a packaged Desktop executable',
)
assert(
  process.env.DINKSTER_DESKTOP_VERIFY_ROOT,
  'Supply a new owned evidence root',
)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
const home = join(root, 'home')
await mkdir(home)
await writeFile(
  join(home, 'model-settings.json'),
  JSON.stringify({
    version: 1,
    locations: [],
    downloadLocation: null,
    disabled: true,
  }),
)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
Object.assign(env, {
  DINKSTER_DESKTOP_DATA: join(root, 'desktop-data'),
  DINKSTER_HOME: home,
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
  APPDATA: join(root, 'app-data'),
  LOCALAPPDATA: join(root, 'local-app-data'),
})
const probe = createServer()
await new Promise((done) => probe.listen(0, '127.0.0.1', done))
const port = probe.address().port
await new Promise((done) => probe.close(done))
const project = {
  id: 'nightly',
  name: 'Nightly reopen',
  channel: 'nightly',
  root: join(root, 'project'),
  engines: [{ id: 'main', name: 'main', kind: 'local', gpus: [], port }],
}
let app
const receipt = {
  platform: process.platform,
  packaged: true,
  project: project.root,
  port,
  reopened: false,
}
function progress(message) {
  appendFileSync(
    join(root, 'progress.log'),
    `${new Date().toISOString()} ${message}\n`,
  )
}
async function launch() {
  app = await electron.launch({
    executablePath: resolve(process.env.DINKSTER_DESKTOP_EXECUTABLE),
    args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
    env,
    timeout: 60_000,
  })
  app
    .process()
    .stderr?.on('data', (bytes) =>
      appendFileSync(join(root, 'desktop-stderr.log'), bytes),
    )
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  return installationManager(app)
}
async function logs(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await logs(path, `${prefix}${entry.name}-`)
    else if (entry.isFile() && entry.name.endsWith('.log')) {
      await writeFile(
        join(root, `runtime-${prefix}${entry.name}`),
        await readFile(path),
      )
    }
  }
}
try {
  progress('Launching packaged Desktop for Nightly setup')
  let manager = await launch()
  const request = {
    root: project.root,
    operation: 'setup',
    channel: 'nightly',
    mirrors: ['https://releases.dinkster.org'],
    port,
    variant: { win32: 'win-cpu', darwin: 'mac-arm64', linux: 'linux-cpu' }[
      process.platform
    ],
    data: join(root, 'store'),
    engine: 'main',
    gpus: [],
  }
  const planned = await manager.evaluate(
    ({ project, request }) => window.dinksterProjects.plan(project, request),
    { project, request },
  )
  assert.equal(planned.result.status, 'planned')
  const applied = await manager.evaluate(
    (token) => window.dinksterProjects.apply(token),
    planned.token,
  )
  assert.equal(applied.status, 'applied')
  receipt.setup = applied
  progress('Nightly setup applied; closing Desktop')
  await app.close()
  app = undefined
  progress('Relaunching Desktop and opening the same Nightly project')
  manager = await launch()
  const opened = app.waitForEvent('window', { timeout: 180_000 })
  const [, engine] = await Promise.all([
    manager.evaluate(
      (id) => window.dinksterProjects.open(id, 'main'),
      project.id,
    ),
    opened,
  ])
  await expect(engine.getByTestId('graph-canvas')).toBeVisible({
    timeout: 180_000,
  })
  const response = await engine.request.get(
    new URL('/api/nodes?wire=1', engine.url()).href,
  )
  assert(response.ok())
  receipt.nodes = await response.json()
  receipt.url = engine.url()
  receipt.reopened = true
  await engine.screenshot({
    path: join(root, 'nightly-reopened.png'),
    fullPage: true,
  })
  progress('Same Nightly project reopened with graph canvas and node API')
} catch (error) {
  receipt.error = String(error.stack ?? error)
  throw error
} finally {
  if (app) await app.close()
  await logs(join(project.root, 'runtime'))
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
