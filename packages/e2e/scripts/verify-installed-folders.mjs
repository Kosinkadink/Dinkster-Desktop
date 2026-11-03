import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

// Use the supported environment client, never a backend checkout or setup.py.
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
const python = process.env.DINKSTER_TOOLS_PYTHON
const mirrors = JSON.parse(process.env.DINKSTER_DESKTOP_VERIFY_MIRRORS ?? '[]')
const version = process.env.DINKSTER_DESKTOP_VERIFY_ENGINE_VERSION
const port = Number(process.env.DINKSTER_DESKTOP_VERIFY_PORT)
const executablePath = process.env.DINKSTER_DESKTOP_VERIFY_ELECTRON
const packaged = process.env.DINKSTER_DESKTOP_EXECUTABLE
assert.ok(directory && python && isAbsolute(python) && version)
assert.ok(Array.isArray(mirrors) && mirrors.length > 0)
assert.ok(mirrors.every((mirror) => typeof mirror === 'string' && mirror))
assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535)
assert.equal((await stat(python)).isFile(), true)
const root = resolve(directory)
await mkdir(root, { recursive: false })
const installation = join(root, 'installation')
const library = join(installation, 'dinkster-library')
const configured = join(root, 'existing output with spaces')
const marker = 'existing configured output must survive the installed launch'
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^PYTHON|^VIRTUAL_ENV$/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = join(root, 'desktop')
env.DINKSTER_TOOLS_PYTHON = python
// Keep the volume's store registration inside this run, not the user's registry.
env.XDG_DATA_HOME = join(root, 'user-data')
env.LOCALAPPDATA = join(root, 'user-data')
const project = {
  id: 'installed-folders',
  name: 'Installed folder verification',
  channel: 'main',
  root: installation,
  engines: [{ id: 'main', name: 'main', kind: 'local', gpus: [], port }],
}
let app
let manager
let stage = 'launch'
const result = {
  complete: false,
  backendCheckoutUsed: false,
  osPickerDriven: false,
  defaultOutputCreated: false,
  importsCreated: false,
  configuredOutputPreserved: false,
  restart: false,
}

async function launch() {
  app = await electron.launch({
    executablePath: packaged ?? executablePath,
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(root, 'chromium')}`,
      ...(packaged
        ? []
        : [fileURLToPath(new URL('../../desktop', import.meta.url))]),
    ],
    env,
    timeout: 60_000,
  })
  app.process().stdout.on('data', () => {})
  app.process().stderr.on('data', () => {})
  assert.equal(
    await app.evaluate(({ app }) => app.isPackaged),
    Boolean(packaged),
  )
  manager = await app.firstWindow()
  await manager
    .getByRole('heading', { name: 'Projects', exact: true })
    .waitFor()
}

async function open() {
  const opened = app.waitForEvent('window', { timeout: 600_000 })
  await manager.evaluate(
    ({ id }) => window.dinksterProjects.open(id, 'main'),
    project,
  )
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return page
}

async function locations(page) {
  return page.evaluate(async () => {
    const locations = await fetch('/api/mounts/locations?project=default')
    const project = await fetch('/api/mounts?project=default')
    if (!locations.ok || !project.ok)
      throw new Error('Installed folder lookup failed')
    return {
      ...(await locations.json()),
      outputMount: (await project.json()).outputMount,
    }
  })
}

try {
  await launch()
  stage = 'setup'
  const setup = await manager.evaluate(
    async ({ project, mirrors, root, variant, version }) => {
      const planned = await window.dinksterProjects.plan(project, {
        root: project.root,
        operation: 'setup',
        channel: 'main',
        variant,
        mirrors,
        data: root,
        engine: 'main',
      })
      if (!planned.token)
        throw new Error('Installed setup did not return a plan')
      if (!planned.result.plan.some((line) => line.includes(version)))
        throw new Error(
          'Installed plan does not use the pinned published engine',
        )
      return window.dinksterProjects.apply(planned.token)
    },
    {
      project,
      mirrors,
      root: join(root, 'store'),
      variant: process.platform === 'win32' ? 'win-cpu' : 'linux-cpu',
      version,
    },
  )
  assert.equal(setup.status, 'applied')
  assert.equal(setup.current, 1)
  assert.ok(
    setup.plan.some((line) => line.includes(version)),
    'Setup must use the pinned published engine',
  )
  await writeFile(join(root, 'setup.json'), JSON.stringify(setup, null, 2))
  const page = await open()
  stage = 'defaults'
  const initial = await locations(page)
  const output = initial.activeMounts.find(
    (mount) => mount.id === initial.outputMount,
  )
  const imports = initial.activeMounts.find(
    (mount) => mount.id === initial.importMount,
  )
  assert.equal(output?.path, join(library, 'output'))
  assert.equal(output.mode, 'readwrite')
  assert.equal((await stat(output.path)).isDirectory(), true)
  assert.equal(imports?.path, join(library, 'imports'))
  assert.equal((await stat(imports.path)).isDirectory(), true)
  result.defaultOutputCreated = true
  result.importsCreated = true
  const capabilities = await page.evaluate(() =>
    window.dinksterDesktop.fileCapabilities(location.origin),
  )
  assert.equal(capabilities.nativeFolderChoice, true)
  assert.equal(capabilities.reveal, true)
  await writeFile(
    join(root, 'defaults.json'),
    JSON.stringify({ initial, capabilities }, null, 2),
  )
  await page.screenshot({ path: join(root, 'installed-defaults.png') })

  stage = 'configure-output'
  await mkdir(configured)
  await writeFile(join(configured, 'keep.txt'), marker)
  await page.evaluate(async (path) => {
    async function change(url, method, body) {
      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('Installed output configuration failed')
    }
    await change('/api/mounts', 'POST', {
      id: 'installed-output',
      path,
      mode: 'readwrite',
      project: 'default',
    })
    await change('/api/mounts/output', 'PUT', { id: 'installed-output' })
    const current = await (await fetch('/api/mounts?project=default')).json()
    await change('/api/mounts/projects/default', 'PUT', {
      mounts: current.mounts.map((mount) => mount.id),
      outputMount: 'installed-output',
    })
  }, configured)
  const mounts = await readFile(join(library, 'mounts.toml'), 'utf8')
  stage = 'restart'
  await app.close()
  app = undefined
  await launch()
  const restarted = await open()
  const after = await locations(restarted)
  assert.equal(after.outputMount, 'installed-output')
  const selected = after.activeMounts.find(
    (mount) => mount.id === after.outputMount,
  )
  assert.equal(selected?.path, configured)
  assert.equal(selected.mode, 'readwrite')
  assert.equal(await readFile(join(configured, 'keep.txt'), 'utf8'), marker)
  assert.equal(await readFile(join(library, 'mounts.toml'), 'utf8'), mounts)
  result.configuredOutputPreserved = true
  result.restart = true
  await writeFile(join(root, 'configured.json'), JSON.stringify(after, null, 2))
  await restarted.screenshot({ path: join(root, 'installed-configured.png') })
} catch (error) {
  await writeFile(
    join(root, 'failure.json'),
    JSON.stringify(
      { stage, type: error.constructor.name, message: error.message, result },
      null,
      2,
    ),
  )
  throw error
} finally {
  if (app) await app.close()
}
result.complete = true
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
