import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

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
  HOME: home,
  USERPROFILE: home,
  DINKSTER_DESKTOP_DATA: join(root, 'desktop-data'),
  DINKSTER_HOME: home,
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
  APPDATA: join(root, 'app-data'),
  LOCALAPPDATA: join(root, 'local-app-data'),
})
const installation = join(root, 'installation')
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
const receipt = {
  platform: process.platform,
  packaged: true,
  installation,
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
  const page = await app.firstWindow({ timeout: 180_000 })
  await expect(page).toHaveURL(
    new RegExp(`^${homeUrl.replaceAll('.', '\\.')}[/?]`),
  )
  await expect(page.locator('.dinkster-window-toolbar-host')).toHaveAttribute(
    'data-desktop-chrome',
    '',
  )
  const response = await page.request.get(`${homeUrl}/supervisor/status`)
  assert.equal(response.status(), 200)
  const status = await response.json()
  assert.equal(status.role, 'home')
  assert.equal(status.state, 'stopped')
  return { page, status }
}
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
  const first = await launch()
  const planned = await first.page.request.get(`${homeUrl}/supervisor/setup`, {
    params: {
      root: installation,
      channel: 'nightly',
      variant: { win32: 'win-cpu', darwin: 'mac-arm64', linux: 'linux-cpu' }[
        process.platform
      ],
    },
    timeout: 120_000,
  })
  assert.equal(planned.status(), 200)
  const { plan } = await planned.json()
  assert.equal(plan.refusal, null, JSON.stringify(plan.refusal))
  const started = await first.page.request.post(`${homeUrl}/supervisor/setup`, {
    data: { planId: plan.id },
  })
  assert.equal(started.status(), 202)
  const job = await started.json()
  let applied
  await expect
    .poll(
      async () => {
        const response = await first.page.request.get(
          `${homeUrl}/supervisor/setup/${job.id}`,
        )
        assert.equal(response.status(), 200)
        applied = await response.json()
        assert.notEqual(applied.state, 'failed', JSON.stringify(applied.error))
        return applied.state
      },
      { timeout: 30 * 60_000 },
    )
    .toBe('completed')
  receipt.setup = applied
  progress('Nightly setup applied; closing Desktop')
  await quit()
  progress('Relaunching Desktop and opening the same Nightly installation')
  const second = await launch()
  assert.notEqual(
    second.status.instance,
    first.status.instance,
    'Restart must acquire a new Home incarnation',
  )
  const opened = await second.page.request.post(
    `${homeUrl}/supervisor/engine`,
    {
      data: { root: installation, engine: 'main' },
    },
  )
  assert.equal(opened.status(), 200)
  let ready
  await expect
    .poll(
      async () => {
        const response = await second.page.request.get(
          `${homeUrl}/supervisor/status`,
        )
        assert.equal(response.status(), 200)
        ready = await response.json()
        assert.equal(ready.open.root, installation)
        assert.notEqual(ready.state, 'failed', JSON.stringify(ready))
        return ready.state
      },
      { timeout: 180_000 },
    )
    .toBe('ready')
  assert.equal(typeof ready.installationFrontend, 'string')
  const engine = second.page
  await engine.evaluate((url) => {
    location.href = url
  }, ready.installationFrontend)
  await expect(engine).toHaveURL(new URL(ready.installationFrontend).href)
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
  receipt.home = { before: first.status, after: second.status, ready }
  await quit()
  receipt.ownedShutdown = true
  progress(
    'Same Nightly installation reopened with graph canvas and node API; owned Home stopped',
  )
} catch (error) {
  receipt.error = String(error.stack ?? error)
  throw error
} finally {
  if (app)
    await quit().catch((error) => {
      receipt.stopError = String(error)
      process.exitCode = 1
    })
  await logs(join(installation, 'runtime'))
  await writeFile(
    join(root, 'home.log'),
    await readFile(join(env.DINKSTER_DESKTOP_DATA, 'home.log'), 'utf8').catch(
      () => '',
    ),
  )
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
