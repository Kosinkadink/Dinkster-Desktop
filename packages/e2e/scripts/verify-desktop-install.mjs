import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

const executablePath = process.env.DINKSTER_DESKTOP_EXECUTABLE
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
if (!executablePath || !directory)
  throw new Error('Set DINKSTER_DESKTOP_EXECUTABLE and a new DINKSTER_DESKTOP_VERIFY_ROOT')
const root = resolve(directory)
await mkdir(root)
const homeUrl = 'http://127.0.0.1:3638'
async function status() {
  try {
    const response = await fetch(`${homeUrl}/supervisor/status`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    return await response.json()
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return undefined
    throw error
  }
}
assert.equal(await status(), undefined, 'Leave an existing process on port 3638 alone')
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
  value !== undefined && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_|^PATH$/i.test(name),
))
Object.assign(env, {
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  DINKSTER_HOME: join(root, 'home'),
  DINKSTER_DESKTOP_DATA: join(root, 'data'),
  DINKSTER_ENV: join(root, 'environment-tools-must-not-run'),
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
  LOCALAPPDATA: join(root, 'local-app-data'),
  APPDATA: join(root, 'app-data'),
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
  // AppImage needs shell utilities; Home must use its verified bundled interpreter.
  PATH: process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin',
})
await mkdir(env.DINKSTER_HOME)
await writeFile(join(env.DINKSTER_HOME, 'model-settings.json'), JSON.stringify({ locations: [] }))
let previousInstance
for (const launch of ['first-run', 'restart']) {
  const app = await electron.launch({
    executablePath: resolve(executablePath),
    args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
    env,
    timeout: 180_000,
  })
  let page
  try {
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
    page = await app.firstWindow({ timeout: 180_000 })
    await expect(page).toHaveURL(new RegExp(`^${homeUrl.replaceAll('.', '\\.')}[/?]`))
    await expect(page.locator('.dinkster-window-toolbar-host')).toHaveAttribute('data-desktop-chrome', '')
    const current = await status()
    assert.equal(current.role, 'home')
    assert.equal(current.state, 'stopped')
    assert(Number.isSafeInteger(current.supervisor.pid) && current.supervisor.pid > 0)
    assert.equal(typeof current.instance, 'string')
    assert(current.instance.length > 0)
    assert.notEqual(current.instance, previousInstance, 'Restart must acquire a new owned Home incarnation')
    previousInstance = current.instance
    const renderer = await page.evaluate(async () => ({
      node: typeof window.require,
      process: typeof window.process,
      projects: typeof window.dinksterProjects,
      library: typeof window.dinksterLibrary,
      info: await window.dinksterDesktop.info(),
      locale: await window.dinksterDesktop.locale(),
      context: await window.dinksterDesktop.windowContext(),
      files: await window.dinksterDesktop.fileCapabilities(location.origin),
    }))
    assert.equal(renderer.node, 'undefined')
    assert.equal(renderer.process, 'undefined')
    assert.equal(renderer.projects, 'undefined')
    assert.equal(renderer.library, 'undefined')
    assert.equal(renderer.context.id, 'primary')
    assert(renderer.info.appVersion.length > 0)
    assert(renderer.locale.length > 0)
    assert.deepEqual(renderer.files, { nativeFolderChoice: false, reveal: false, resolvePath: false })
    await assert.rejects(stat(join(env.DINKSTER_DESKTOP_DATA, 'projects.json')), { code: 'ENOENT' })
    if (process.env.DINKSTER_VERIFY_PUBLIC_UPDATE === '1') {
      const update = await app.evaluate(async ({ app }) => {
        const require = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
        const { autoUpdater } = require('electron-updater')
        const result = await autoUpdater.checkForUpdates()
        return { version: result?.updateInfo.version, available: result?.isUpdateAvailable, runningVersion: app.getVersion() }
      })
      assert.equal(update.version, update.runningVersion, 'The installed build must resolve its published version from the default feed')
      assert.equal(update.available, false, 'The current published installation must be up to date')
      await writeFile(join(root, `${launch}-update.json`), JSON.stringify(update, null, 2))
    }
    await page.screenshot({ path: join(root, `${launch}.png`), fullPage: true })
    await writeFile(join(root, `${launch}.json`), JSON.stringify({ packaged: true, status: current, renderer }, null, 2))
    const closed = app.waitForEvent('close')
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu().items[0].submenu.items.find((item) => item.label === 'Quit').click()
    }).catch(() => {})
    await closed
    await expect.poll(() => status().catch((error) => {
      if (error.cause?.code === 'ECONNRESET') return null
      throw error
    }), { timeout: 30_000 }).toBeUndefined()
    console.log(`Verified installed Desktop ${launch}: shared Home, isolated renderer, owned shutdown and no Desktop registry`)
  } catch (error) {
    await page?.screenshot({ path: join(root, `${launch}-failed.png`), fullPage: true }).catch(() => undefined)
    throw error
  } finally {
    await app.close().catch(() => undefined)
    await writeFile(join(root, `${launch}-home.log`), await readFile(join(env.DINKSTER_DESKTOP_DATA, 'home.log'), 'utf8').catch(() => ''))
  }
}
