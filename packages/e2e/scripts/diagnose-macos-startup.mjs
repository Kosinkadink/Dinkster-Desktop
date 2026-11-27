import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const { _electron: electron } = createRequire(
  resolve('packages/e2e/package.json'),
)('@playwright/test')
assert.equal(process.platform, 'darwin')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
await mkdir(root)
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
  DINKSTER_DESKTOP_DATA: join(root, 'data'),
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
  APPDATA: join(root, 'app-data'),
  LOCALAPPDATA: join(root, 'local-app-data'),
})
await mkdir(env.DINKSTER_HOME)
await writeFile(
  join(env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ version: 1, downloadLocation: null, locations: [] }),
)
const receipt = { source: 'db7babace86971f42cc98c9c945c95b56d1d7879' }
let app
let sampleTimer
try {
  app = await electron.launch({
    executablePath: process.env.DINKSTER_DESKTOP_EXECUTABLE,
    args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
    env,
    timeout: 60_000,
  })
  app
    .process()
    .stderr?.on('data', (bytes) =>
      appendFileSync(join(root, 'desktop-stderr.log'), bytes),
    )
  sampleTimer = setTimeout(() => {
    spawn(
      '/usr/bin/sample',
      [
        String(app.process().pid),
        '5',
        '1',
        '-file',
        join(root, 'main-sample.txt'),
      ],
      { stdio: 'ignore' },
    )
  }, 30_000)
  await app.evaluate(({ app, BrowserWindow, webContents }, root) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const record = (stage, value = {}) =>
      fs.appendFileSync(
        path.join(root, 'main-trace.log'),
        JSON.stringify({ time: new Date().toISOString(), stage, ...value }) +
          '\n',
      )
    const snapshot = () =>
      record('snapshot', {
        ready: app.isReady(),
        windows: BrowserWindow.getAllWindows().map((w) => ({
          id: w.id,
          visible: w.isVisible(),
          destroyed: w.isDestroyed(),
        })),
        contents: webContents
          .getAllWebContents()
          .map((w) => ({
            id: w.id,
            type: w.getType(),
            url: w.getURL(),
            loading: w.isLoading(),
          })),
      })
    app.on('browser-window-created', (_event, window) => {
      record('window-created', { id: window.id })
      window.on('ready-to-show', () =>
        record('ready-to-show', { id: window.id }),
      )
      window.webContents.on('did-finish-load', () =>
        record('did-finish-load', { id: window.id }),
      )
      window.webContents.on('did-fail-load', (_event, code, message) =>
        record('did-fail-load', { code, message }),
      )
    })
    snapshot()
    setInterval(snapshot, 5000).unref()
  }, root)
  const page = await app.firstWindow({ timeout: 180_000 })
  receipt.url = page.url()
  receipt.title = await page.title()
  receipt.firstWindow = true
} catch (error) {
  receipt.error = String(error)
  process.exitCode = 1
} finally {
  clearTimeout(sampleTimer)
  if (app) {
    let closeTimer
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => {
          closeTimer = setTimeout(
            () => reject(new Error('Close exceeded 30000ms')),
            30_000,
          )
        }),
      ])
    } catch (error) {
      receipt.closeError = String(error)
      app.process().kill('SIGKILL')
    } finally {
      clearTimeout(closeTimer)
    }
  }
  await copyFile(
    join(env.DINKSTER_DESKTOP_DATA, 'home.log'),
    join(root, 'home.log'),
  ).catch(() => undefined)
  await copyFile(
    join(env.DINKSTER_DESKTOP_DATA, 'logs', 'desktop.log'),
    join(root, 'desktop.log'),
  ).catch(() => undefined)
  await writeFile(join(root, 'baseline.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt))
  process.exit(process.exitCode ?? 0)
}
