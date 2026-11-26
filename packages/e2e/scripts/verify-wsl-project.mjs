import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron, expect } from '@playwright/test'
import { WslHost, wslLocation, wslWindowsPath } from '../../desktop/dist/wsl.js'

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
const receipt = { distribution: host.distribution, data, tools, steps: [] }
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
  HOME: join(scratch, 'home'),
  USERPROFILE: join(scratch, 'home'),
  DINKSTER_HOME: join(scratch, 'home'),
  DINKSTER_DESKTOP_DATA: data,
  XDG_DATA_HOME: join(scratch, 'xdg-data'),
  XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
  XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
  APPDATA: join(scratch, 'app-data'),
  LOCALAPPDATA: join(scratch, 'local-app-data'),
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
})
await mkdir(env.DINKSTER_HOME)
await writeFile(
  join(env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ locations: [] }),
)
const homeUrl = 'http://127.0.0.1:3638'
async function homeStopped() {
  try {
    await fetch(`${homeUrl}/supervisor/status`, {
      signal: AbortSignal.timeout(2000),
    })
    return false
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return true
    if (error.cause?.code === 'ECONNRESET') return false
    throw error
  }
}
assert.equal(
  await homeStopped(),
  true,
  'Leave an existing Home on port 3638 alone',
)
let app
let page
let restoreOwner = false
let distributionPrepared = false
async function quit() {
  const closed = app.waitForEvent('close')
  await app
    .evaluate(({ Menu }) => {
      Menu.getApplicationMenu()
        .items[0].submenu.items.find((item) => item.label === 'Quit')
        .click()
    })
    .catch(() => undefined)
  await closed
  app = undefined
  await expect.poll(homeStopped, { timeout: 30_000 }).toBe(true)
}
async function setOwner(owner) {
  await promisify(execFile)(
    'wsl.exe',
    [
      '--distribution',
      host.distribution,
      '--user',
      'root',
      '--cd',
      '/',
      '--exec',
      '/bin/sh',
      '-ec',
      'printf "%s\\n" "$1" > /etc/dinkster-desktop-owner',
      'owner-check',
      owner,
    ],
    { timeout: 30_000, windowsHide: true },
  )
}
try {
  receipt.initial = await host.status()
  assert.equal(receipt.initial.available, true, receipt.initial.detail)
  assert.equal(
    receipt.initial.ready,
    false,
    'Use a fresh data directory, never an existing private distribution',
  )
  const { stdout } = await promisify(execFile)(
    'wsl.exe',
    ['--list', '--quiet'],
    { encoding: 'buffer', timeout: 30_000, windowsHide: true },
  )
  const distributions = stdout
    .toString(stdout.includes(0) ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
  assert.equal(
    distributions.some(
      (name) => name.trim().toLowerCase() === host.distribution.toLowerCase(),
    ),
    false,
    'Never prepare or terminate a pre-existing distribution',
  )
  app = await electron.launch({
    executablePath: process.env.DINKSTER_DESKTOP_EXECUTABLE
      ? resolve(process.env.DINKSTER_DESKTOP_EXECUTABLE)
      : createRequire(join(repository, 'packages/desktop/package.json'))(
          'electron',
        ),
    args: [
      ...(process.env.DINKSTER_DESKTOP_EXECUTABLE
        ? []
        : [join(repository, 'packages/desktop')]),
      `--user-data-dir=${join(scratch, 'chromium')}`,
    ],
    env,
    timeout: 180_000,
  })
  page = await app.firstWindow({ timeout: 180_000 })
  await expect(page).toHaveURL(
    new RegExp(`^${homeUrl.replaceAll('.', '\\.')}[/?]`),
  )
  await expect(page.locator('.dinkster-window-toolbar-host')).toHaveAttribute(
    'data-desktop-chrome',
    '',
  )
  const initial = await page.evaluate(() => window.dinksterDesktop.wslStatus())
  assert.equal(initial.distribution, host.distribution)
  assert.equal(initial.ready, false)
  distributionPrepared = true
  receipt.ready = await page.evaluate(() => window.dinksterDesktop.prepareWsl())
  assert.equal(receipt.ready.ready, true)
  assert.equal(receipt.ready.distribution, host.distribution)
  assert.equal(
    (await page.evaluate(() => window.dinksterDesktop.wslStatus())).ready,
    true,
  )
  receipt.steps.push(
    'Shared Home native bridge prepared its derived private distribution',
  )

  const projectRoot = await page.evaluate(() =>
    window.dinksterDesktop.wslProjectRoot('wsl-check'),
  )
  assert.deepEqual(wslLocation(projectRoot), {
    distribution: host.distribution,
    path: '/home/dinkster/projects/wsl-check',
  })
  receipt.root = projectRoot
  await app.evaluate(({ dialog }) => {
    globalThis.wslOriginalDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  assert.equal(
    await page.evaluate(() => window.dinksterDesktop.copyWslModels()),
    undefined,
  )
  receipt.cancelledCopy = true
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
  assert.equal(
    await page.evaluate(() => window.dinksterDesktop.copyWslModels()),
    '/home/dinkster/models/models',
  )
  const copied = wslWindowsPath(
    host.distribution,
    '/home/dinkster/models/models/sentinel.safetensors',
  )
  assert.deepEqual(await readFile(copied), bytes)
  assert.deepEqual(await readFile(join(source, 'sentinel.safetensors')), bytes)
  await assert.rejects(
    page.evaluate(() => window.dinksterDesktop.copyWslModels()),
    /already exists/,
  )
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

  const revokedSource = join(scratch, 'revoked-models')
  await mkdir(revokedSource)
  await writeFile(join(revokedSource, 'sentinel.safetensors'), bytes)
  await app.evaluate(({ dialog }) => {
    globalThis.wslDialogEntered = false
    dialog.showOpenDialog = () =>
      new Promise((done) => {
        globalThis.wslFinishDialog = done
        globalThis.wslDialogEntered = true
      })
  })
  const pending = page.evaluate(async () => {
    try {
      return { path: await window.dinksterDesktop.copyWslModels() }
    } catch (error) {
      return { error: error.message }
    }
  })
  await expect
    .poll(() => app.evaluate(() => globalThis.wslDialogEntered))
    .toBe(true)
  restoreOwner = true
  await setOwner('unrecognized-owner')
  try {
    await app.evaluate(
      (source) =>
        globalThis.wslFinishDialog({ canceled: false, filePaths: [source] }),
      revokedSource,
    )
    const refused = await pending
    assert.match(refused.error, /not owned/)
    assert.equal(refused.path, undefined)
    assert.equal(
      (await page.evaluate(() => window.dinksterDesktop.wslStatus())).ready,
      false,
    )
    await assert.rejects(
      page.evaluate(() => window.dinksterDesktop.wslProjectRoot('wsl-check')),
      /not owned/,
    )
    await assert.rejects(
      page.evaluate(() => window.dinksterDesktop.prepareWsl()),
      /not owned/,
    )
    receipt.ownerReplacementRefused = true
  } finally {
    await setOwner(host.distribution)
    restoreOwner = false
  }
  assert.equal(
    (await page.evaluate(() => window.dinksterDesktop.wslStatus())).ready,
    true,
  )
  assert.deepEqual(await readFile(copied), bytes)
  await assert.rejects(
    stat(
      wslWindowsPath(host.distribution, '/home/dinkster/models/revoked-models'),
    ),
    { code: 'ENOENT' },
  )
  receipt.steps.push(
    'Changed distribution ownership during folder choice denied copy, root and preparation; restored ownership recovered readiness',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.wslOriginalDialog
    delete globalThis.wslOriginalDialog
    delete globalThis.wslFinishDialog
    delete globalThis.wslDialogEntered
  })
  await quit()
  receipt.ownedShutdown = true
  receipt.result = 'pass'
} catch (error) {
  receipt.result = 'fail'
  receipt.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
  throw error
} finally {
  if (restoreOwner)
    await setOwner(host.distribution).catch((error) => {
      receipt.restoreError = String(error)
      process.exitCode = 1
    })
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        if (globalThis.wslOriginalDialog)
          dialog.showOpenDialog = globalThis.wslOriginalDialog
        globalThis.wslFinishDialog?.({ canceled: true, filePaths: [] })
      })
      .catch(() => undefined)
    await quit().catch(async (error) => {
      receipt.stopError = String(error)
      process.exitCode = 1
      await app?.close().catch(() => undefined)
    })
  }
  if (distributionPrepared)
    await promisify(execFile)('wsl.exe', ['--terminate', host.distribution], {
      timeout: 30_000,
      windowsHide: true,
    }).catch((error) => {
      receipt.terminateError = String(error)
      process.exitCode = 1
    })
  await writeFile(
    join(scratch, 'home.log'),
    await readFile(join(data, 'home.log'), 'utf8').catch(() => ''),
  )
  await writeFile(
    join(scratch, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
  console.log(`WSL acceptance artifacts: ${scratch}`)
}
