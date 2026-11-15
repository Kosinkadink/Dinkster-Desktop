import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron, expect } from '@playwright/test'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const artifacts = process.env.DINKSTER_DEVELOPMENT_ARTIFACTS
if (!artifacts)
  throw new Error(
    'DINKSTER_DEVELOPMENT_ARTIFACTS must name an owned evidence directory',
  )
await mkdir(artifacts, { recursive: true })
const scratch = await mkdtemp(join(resolve(artifacts), 'development-'))
const source = (name) => {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} must name an explicit local source folder`)
  return resolve(value)
}
const sources = {
  engine: source('DINKSTER_DEVELOPMENT_ENGINE'),
  inference: source('DINKSTER_DEVELOPMENT_INFERENCE'),
  helper: source('DINKSTER_DEVELOPMENT_HELPER'),
  pack: source('DINKSTER_DEVELOPMENT_PACK'),
  frontend: join(root, 'packages/app/dist'),
}
const frontendDev = process.env.DINKSTER_DEVELOPMENT_FRONTEND_DEV
const frontendEdit = process.env.DINKSTER_DEVELOPMENT_FRONTEND_EDIT
const project = join(scratch, 'project')
const portServer = createServer()
await new Promise((done) => portServer.listen(0, '127.0.0.1', done))
const port = portServer.address().port
await new Promise((done) => portServer.close(done))
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
env.CUDA_VISIBLE_DEVICES = ''
env.DINKSTER_ACCELERATOR = 'cpu'
env.DINKSTER_DESKTOP_DATA = join(scratch, 'desktop')
env.XDG_DATA_HOME = join(scratch, 'user-data')
env.LOCALAPPDATA = join(scratch, 'user-data')
if (process.env.DINKSTER_DEVELOPMENT_TOOLS_PYTHON)
  env.DINKSTER_TOOLS_PYTHON = resolve(
    process.env.DINKSTER_DEVELOPMENT_TOOLS_PYTHON,
  )
let app
let originalFrontend
const receipt = {
  platform: process.platform,
  sources,
  project,
  port,
  toolsOverride: env.DINKSTER_TOOLS_PYTHON ?? null,
}
try {
  app = await electron.launch({
    executablePath:
      process.env.DINKSTER_ELECTRON_EXECUTABLE ??
      createRequire(join(root, 'packages/desktop/package.json'))('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'chromium')}`,
      ...(process.env.DINKSTER_ELECTRON_EXECUTABLE
        ? []
        : [join(root, 'packages/desktop')]),
    ],
    env,
  })
  const manager = await app.firstWindow()
  await manager
    .getByText('Manage a local installation', { exact: true })
    .click()
  await manager.locator('#local-name').fill('Contributor development')
  await manager.locator('#local-root').fill(project)
  await manager.locator('#local-mirrors').fill('https://releases.dinkster.org')
  await manager.locator('#local-data').fill(join(scratch, 'store'))
  await manager.locator('#local-port').fill(String(port))
  await manager.locator('#local-kind').selectOption('development')
  for (const [id, value] of Object.entries({
    'development-engine': sources.engine,
    'development-inference': sources.inference,
    'development-helper': sources.helper,
    'development-packs': sources.pack,
    ...(frontendDev
      ? { 'development-frontend-dev': frontendDev }
      : { 'development-frontend': sources.frontend }),
  }))
    await manager.locator(`#${id}`).fill(value)
  await manager
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  const variant = process.platform === 'win32' ? 'win-cpu' : 'linux-cpu'
  await expect(
    manager.locator(`#local-variant option[value="${variant}"]`),
  ).toHaveCount(1, { timeout: 120_000 })
  await manager.locator('#local-variant').selectOption(variant)
  await manager
    .locator('#local-settings')
    .screenshot({ path: join(scratch, 'development-setup.png') })
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#apply')).toBeVisible({ timeout: 120_000 })
  await manager
    .locator('#plan-panel')
    .screenshot({ path: join(scratch, 'development-plan.png') })
  await assert.rejects(readFile(join(project, 'current')), /ENOENT/)
  await manager.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(manager.locator('#apply')).toBeHidden()
  await assert.rejects(readFile(join(project, 'current')), /ENOENT/)
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(manager.locator('#apply')).toBeVisible({ timeout: 120_000 })
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await manager.waitForFunction(
    () =>
      document
        .querySelector('#projects')
        ?.textContent.includes('Development - unpublished sources') ||
      document.querySelector('#message')?.textContent.trim(),
    null,
    { timeout: 1_200_000 },
  )
  await expect(manager.locator('#projects')).toContainText(
    'Development - unpublished sources',
  )
  const generation = join(
    project,
    'generations',
    (await readFile(join(project, 'current'), 'utf8')).trim(),
  )
  receipt.generation = generation
  receipt.selection = JSON.parse(
    await readFile(join(generation, 'development-sources.json'), 'utf8'),
  )
  receipt.selection.sources = receipt.selection.sources.map(
    ({ files, ...row }) => row,
  )
  const selectedPaths = receipt.selection.sources.map((row) =>
    resolve(row.path),
  )
  for (const path of [
    sources.engine,
    sources.inference,
    sources.helper,
    sources.pack,
  ])
    assert(selectedPaths.includes(path), `selected source missing: ${path}`)
  if (frontendDev) assert.equal(receipt.selection.frontendDev, frontendDev)
  else assert.equal(resolve(receipt.selection.frontendRoot), sources.frontend)
  const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert(health.ok)
  receipt.health = await health.json()
  assert.equal(receipt.health.ok, true)
  assert.equal(receipt.health.compositionState.failed, 0)
  const python =
    process.platform === 'win32'
      ? join(generation, 'python/python.exe')
      : join(generation, 'python/bin/python3')
  const imported = await execute(
    python,
    [
      '-I',
      '-c',
      'import json,dinkster,dinkster_inference.conds,dinkster_pack_helpers; print(json.dumps({"engine":dinkster.__file__,"inference":dinkster_inference.conds.__file__,"helper":dinkster_pack_helpers.__file__}))',
    ],
    { env },
  )
  receipt.imports = JSON.parse(imported.stdout)
  for (const name of ['engine', 'inference', 'helper'])
    assert(
      resolve(receipt.imports[name]).startsWith(
        sources[name] + (process.platform === 'win32' ? '\\' : '/'),
      ),
      `${name} did not import from its selected folder`,
    )
  const opened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const engine = await opened
  const connected = []
  engine.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string' && payload.includes('"type":"connected"'))
        connected.push(new URL(socket.url()).origin)
    })
  })
  await expect
    .poll(
      () =>
        engine
          .locator('body')
          .evaluate((body) => getComputedStyle(body, '::after').content),
      { timeout: 120_000 },
    )
    .toBe('"Development project - unpublished sources"')
  assert.equal(
    await engine.evaluate(() => typeof window.dinksterProjects),
    'undefined',
  )
  assert.deepEqual(
    await engine.evaluate(() => Object.keys(window.dinksterDesktop).sort()),
    ['chooseDirectory', 'fileCapabilities', 'resolveDroppedFile', 'revealFile'],
  )
  const served = await fetch(`http://127.0.0.1:${port}/`)
  if (frontendDev) {
    assert((await served.text()).includes('/@vite/client'))
    await expect.poll(() => connected.length).toBeGreaterThan(0)
    const engineOrigin = new URL(engine.url()).origin.replace('http:', 'ws:')
    assert(
      connected.includes(engineOrigin),
      'HMR bypassed the Desktop engine gateway',
    )
    receipt.hmrOrigins = connected
    if (frontendEdit) {
      originalFrontend = await readFile(frontendEdit, 'utf8')
      await writeFile(
        frontendEdit,
        originalFrontend.replace(
          '</body>',
          '<script>document.body.dataset.developmentEdit="received"</script></body>',
        ),
      )
      await engine.waitForFunction(
        () => document.body.dataset.developmentEdit === 'received',
      )
      receipt.liveEdit = 'received without manual reload'
    }
  } else
    assert.equal(
      await served.text(),
      await readFile(join(sources.frontend, 'index.html'), 'utf8'),
    )
  await expect(engine.getByText('connected', { exact: true })).toBeVisible({
    timeout: 120_000,
  })
  await expect(
    engine.getByText('27 node schemas', { exact: true }),
  ).toBeVisible({ timeout: 120_000 })
  await manager
    .locator('#projects')
    .screenshot({ path: join(scratch, 'development-project-list.png') })
  await engine.screenshot({ path: join(scratch, 'development-engine.png') })
  receipt.status = 'passed'
  console.log(`Real Desktop development project passed: ${scratch}`)
} catch (error) {
  receipt.status = 'failed'
  receipt.error = String(error)
  const manager = app?.windows()[0]
  if (manager && !manager.isClosed()) {
    receipt.message = await manager
      .locator('#message')
      .textContent()
      .catch(() => '')
    await manager
      .screenshot({ path: join(scratch, 'failure.png'), fullPage: true })
      .catch(() => {})
    console.error(receipt.message)
  }
  throw error
} finally {
  if (originalFrontend !== undefined)
    await writeFile(frontendEdit, originalFrontend)
  if (app) await app.close().catch(() => {})
  await writeFile(
    join(scratch, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
}
