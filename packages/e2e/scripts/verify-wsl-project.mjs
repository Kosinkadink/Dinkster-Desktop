import assert from 'node:assert/strict'
import { installationManager } from './installation-manager.mjs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { WslHost, wslLocation, wslWindowsPath } from '../../desktop/dist/wsl.js'
import { EnvironmentClient } from '../../desktop/dist/environment.js'

assert.equal(
  process.platform,
  'win32',
  'Run on the Windows host, not inside WSL',
)
const artifacts = process.env.DINKSTER_WSL_ARTIFACTS
assert(
  artifacts,
  'DINKSTER_WSL_ARTIFACTS must name an owned evidence directory',
)
await mkdir(artifacts, { recursive: true })
const scratch = await mkdtemp(join(resolve(artifacts), 'private-wsl-'))
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const pin = JSON.parse(
  await readFile(
    join(repository, 'packages/desktop/src/environment-tools-release.json'),
    'utf8',
  ),
)
const tools = {
  label: pin.label,
  sha256: pin.manifest.sha256,
  manifest: `https://releases.dinkster.org/tools/${pin.label}/tools-manifest.json`,
  release: `https://releases.dinkster.org/tools/${pin.label}`,
}
const data = join(scratch, 'desktop')
const host = new WslHost(data, tools)
const client = new EnvironmentClient(
  'dinkster-env',
  [],
  undefined,
  undefined,
  undefined,
  host,
)
const receipt = { distribution: host.distribution, data, tools, steps: [] }
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = data
env.CUDA_VISIBLE_DEVICES = ''
env.DINKSTER_ACCELERATOR = 'cpu'
let app
let manager
let root
let setupStarted = false
try {
  const initial = await host.status()
  receipt.initial = initial
  assert.equal(initial.available, true, initial.detail)
  assert.equal(
    initial.ready,
    false,
    'Use a fresh data directory, never an existing private distribution',
  )
  app = await electron.launch({
    executablePath: createRequire(
      join(repository, 'packages/desktop/package.json'),
    )('electron'),
    args: [
      join(repository, 'packages/desktop'),
      `--user-data-dir=${join(scratch, 'chromium')}`,
    ],
    env,
  })
  manager = await installationManager(app)
  await manager.getByText('Advanced settings', { exact: true }).click()
  await manager.getByLabel('Engine host').selectOption('wsl2')
  await manager.getByRole('button', { name: 'Check WSL2' }).click()
  await expect(manager.getByText('Prepare a private Ubuntu')).toBeVisible()
  await manager.screenshot({
    path: join(scratch, 'before-provisioning.png'),
    fullPage: true,
  })
  await manager
    .getByRole('button', { name: 'Prepare private distribution' })
    .click()
  await expect(
    manager.getByText('Private WSL2 distribution ready'),
  ).toBeVisible({
    timeout: 30 * 60_000,
  })
  receipt.ready = await host.status()
  assert.equal(receipt.ready.ready, true)
  receipt.steps.push(
    'Explicit UI preparation created a private WSL2 distribution',
  )

  await manager
    .getByLabel('Environment name', { exact: true })
    .fill('Private WSL acceptance')
  await manager
    .getByRole('button', { name: 'Use Linux environment folder' })
    .click()
  await expect(manager.getByLabel('Install location')).toHaveValue(
    /\\\\wsl\.localhost\\Dinkster-Desktop-/,
  )
  root = await manager.getByLabel('Install location').inputValue()
  assert.equal(wslLocation(root).distribution, host.distribution)
  receipt.root = root

  const source = join(scratch, 'models')
  await mkdir(source)
  const bytes = Buffer.from('Desktop WSL model-copy acceptance\n')
  await writeFile(join(source, 'sentinel.safetensors'), bytes)
  // Select an owned fixture folder without opening a blocking native dialog.
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [source],
    })
  }, source)
  await manager
    .getByRole('button', { name: 'Copy Windows model folder' })
    .click()
  await expect(
    manager
      .getByRole('status')
      .filter({ hasText: /Models copied|already exists/ }),
  ).toContainText('Models copied to /home/dinkster/models/models')
  const copied = wslWindowsPath(
    host.distribution,
    '/home/dinkster/models/models/sentinel.safetensors',
  )
  assert.deepEqual(await readFile(copied), bytes)
  assert.deepEqual(await readFile(join(source, 'sentinel.safetensors')), bytes)
  await manager
    .getByRole('button', { name: 'Copy Windows model folder' })
    .click()
  await expect(
    manager
      .getByRole('status')
      .filter({ hasText: /Models copied|already exists/ }),
  ).toContainText('already exists')
  assert.deepEqual(await readFile(copied), bytes)
  receipt.copy = {
    source,
    destination: copied,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    replacementRefused: true,
  }
  receipt.steps.push(
    'Real Windows-to-WSL copy preserved originals and refused replacement',
  )

  await manager
    .getByLabel('Mirrors, in order')
    .fill('https://releases.dinkster.org')
  await manager.getByLabel('Channel', { exact: true }).selectOption('nightly')
  await manager
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  await expect(
    manager.getByLabel('Hardware variant').locator('option[value="linux-cpu"]'),
  ).toHaveCount(1, { timeout: 10 * 60_000 })
  // CPU is explicit; no device is admitted by this Desktop lifecycle check.
  assert.equal(
    await manager.getByLabel('Assigned NVIDIA devices').inputValue(),
    '',
  )
  await manager.getByLabel('Hardware variant').selectOption('linux-cpu')
  await manager
    .getByLabel('Supervisor port')
    .fill(process.env.DINKSTER_WSL_PORT ?? '54796')
  await manager
    .getByRole('button', { name: 'Review environment plan', exact: true })
    .click()
  await expect(
    manager.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeVisible({ timeout: 10 * 60_000 })
  await manager.screenshot({
    path: join(scratch, 'install-plan.png'),
    fullPage: true,
  })
  setupStarted = true
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await expect(
    manager.getByRole('button', { name: 'Open main', exact: true }),
  ).toBeVisible({ timeout: 30 * 60_000 })
  const status = await client.run({ root, operation: 'status' })
  assert.notEqual(status.current, null)
  assert.equal(status.root, root)
  receipt.installed = status
  const settings = JSON.parse(
    await readFile(join(root, 'environment.json'), 'utf8'),
  )
  assert.equal(settings.variant, 'linux-cpu')
  receipt.steps.push(
    'UI installed the Linux engine through verified Linux tools and wsl.exe',
  )

  const opened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const frontend = await opened
  await frontend.waitForLoadState('domcontentloaded')
  await expect(frontend.locator('body')).not.toBeEmpty({ timeout: 60_000 })
  const health = await fetch(
    `http://127.0.0.1:${process.env.DINKSTER_WSL_PORT ?? '54796'}/api/health`,
  )
  assert(
    health.ok,
    'The selected Linux engine must answer its health endpoint through WSL localhost forwarding',
  )
  receipt.health = await health.json()
  assert.equal(receipt.health.ok, true)
  assert.equal(receipt.health.compositionState.failed, 0)
  const url = new URL(frontend.url())
  assert(
    ['127.0.0.1', 'localhost'].includes(url.hostname),
    'Desktop must reach the Linux engine on localhost',
  )
  await frontend.screenshot({
    path: join(scratch, 'linux-engine-open.png'),
    fullPage: true,
  })
  receipt.frontend = { url: frontend.url(), title: await frontend.title() }
  receipt.steps.push('Desktop opened the real Linux-engine frontend')
  await manager.screenshot({
    path: join(scratch, 'installed-project.png'),
    fullPage: true,
  })
  receipt.result = 'pass'
} catch (error) {
  receipt.result = 'fail'
  receipt.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
  if (manager)
    await manager
      .screenshot({ path: join(scratch, 'failure.png'), fullPage: true })
      .catch(() => undefined)
  throw error
} finally {
  if (setupStarted && root) {
    try {
      receipt.stop = await client.run({ root, operation: 'stop' }, true)
    } catch (error) {
      receipt.stopError = error.message
      process.exitCode = 1
    }
  }
  await app?.close().catch(() => undefined)
  await client.dispose()
  await writeFile(
    join(scratch, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
  console.log(`WSL acceptance artifacts: ${scratch}`)
}
