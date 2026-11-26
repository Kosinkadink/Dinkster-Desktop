import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert(process.env.DINKSTER_DESKTOP_VERIFY_ROOT, 'Supply a new evidence root')
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
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
assert.equal(await homeStopped(), true, 'Leave an existing Home alone')
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
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  DINKSTER_HOME: join(root, 'home'),
  DINKSTER_DESKTOP_DATA: join(root, 'desktop'),
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  APPDATA: join(root, 'app-data'),
  LOCALAPPDATA: join(root, 'local-app-data'),
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
})
await mkdir(env.HOME)
await writeFile(
  join(env.HOME, 'model-settings.json'),
  JSON.stringify({ locations: [] }),
)
const executablePath =
  process.env.DINKSTER_ELECTRON_EXECUTABLE ??
  createRequire(join(repository, 'packages/desktop/package.json'))('electron')
const receipt = {
  untrusted: undefined,
  subframe: undefined,
  ownedShutdown: false,
}
let app
try {
  app = await electron.launch({
    executablePath,
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(root, 'electron')}`,
      join(repository, 'packages/desktop'),
    ],
    env,
    timeout: 180_000,
  })
  const page = await app.firstWindow({ timeout: 180_000 })
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ Menu }) =>
            !!Menu.getApplicationMenu()?.getMenuItemById('desktop-projects'),
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
  await page.waitForLoadState()
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3638[/?]/)
  assert(
    (await page.evaluate(() => window.dinksterDesktop.locale())).length > 0,
  )
  assert.equal(
    (await page.evaluate(() => window.dinksterDesktop.windowContext())).kind,
    'primary',
  )
  receipt.home = await page.request
    .get(`${homeUrl}/supervisor/status`)
    .then((response) => response.json())
  assert.equal(receipt.home.role, 'home')
  assert.equal(receipt.home.state, 'stopped')
  const denied = {
    nativeFolderChoice: false,
    reveal: false,
    resolvePath: false,
  }
  for (const project of [undefined, '', 'default', 'invalid_project']) {
    const url = new URL(homeUrl)
    if (project !== undefined) url.searchParams.set('dinksterProject', project)
    await page.goto(url.href)
    assert.deepEqual(
      await page.evaluate(
        (url) => window.dinksterDesktop.fileCapabilities(url),
        homeUrl,
      ),
      denied,
    )
  }
  receipt.untrusted = await app.evaluate(
    async ({ BrowserWindow, app, dialog }, url) => {
      const child = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}/dist/preload.cjs`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      const original = dialog.showOpenDialog
      let dialogRequests = 0
      dialog.showOpenDialog = async () => {
        dialogRequests++
        return { canceled: true, filePaths: [] }
      }
      try {
        await child.loadURL(url)
        const result = await child.webContents.executeJavaScript(`(async () => {
        const bridge = window.dinksterDesktop
        const errors = []
        for (const action of [
          () => bridge.locale(),
          () => bridge.info(),
          () => bridge.chooseDirectory(location.origin),
          () => bridge.revealFile(location.origin, { digest: 'blake3:' + 'a1'.repeat(32), scope: 'local', project: 'default' }),
        ]) {
          try { await action(); errors.push(null) }
          catch (error) { errors.push(error.message) }
        }
        return { capabilities: await bridge.fileCapabilities(location.origin), errors }
      })()`)
        return { ...result, dialogRequests }
      } finally {
        dialog.showOpenDialog = original
        child.destroy()
      }
    },
    `${homeUrl}/?dinksterProject=default`,
  )
  assert.deepEqual(receipt.untrusted.capabilities, denied)
  assert.equal(receipt.untrusted.dialogRequests, 0)
  assert.equal(receipt.untrusted.errors.length, 4)
  for (const error of receipt.untrusted.errors)
    assert.match(error, /window is not registered|untrusted renderer/)
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.src = '/?dinksterProject=default'
    document.body.append(frame)
  })
  receipt.subframe = await page
    .frameLocator('iframe')
    .locator('body')
    .evaluate(async () => {
      if (typeof window.dinksterDesktop === 'undefined')
        return 'no native bridge'
      try {
        await window.dinksterDesktop.locale()
        return 'accepted'
      } catch {
        return 'native IPC refused'
      }
    })
  assert.notEqual(receipt.subframe, 'accepted')
  await page.locator('iframe').evaluate((frame) => frame.remove())
  console.log(
    'Shared Home native IPC: trusted main frame works; unregistered window and subframe have no authority',
  )
} catch (error) {
  receipt.error = String(error.stack ?? error)
  throw error
} finally {
  try {
    if (app) {
      const closed = app.waitForEvent('close', { timeout: 30_000 })
      await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
      await closed
      await expect.poll(homeStopped, { timeout: 30_000 }).toBe(true)
      receipt.ownedShutdown = true
    }
  } catch (error) {
    receipt.stopError = String(error.stack ?? error)
    throw error
  } finally {
    receipt.homeLog = await readFile(
      join(env.DINKSTER_DESKTOP_DATA, 'home.log'),
      'utf8',
    ).catch(() => '')
    await writeFile(
      join(root, 'native-ipc.json'),
      JSON.stringify(receipt, null, 2),
    )
  }
}
