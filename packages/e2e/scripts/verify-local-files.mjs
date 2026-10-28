import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const source = process.env.DINKSTER_ENGINE_SOURCE
const commit = process.env.DINKSTER_REF
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
assert.ok(
  source && directory,
  'Set DINKSTER_ENGINE_SOURCE and a fresh DINKSTER_DESKTOP_VERIFY_ROOT',
)
assert.match(
  commit ?? '',
  /^[a-f0-9]{40}$/,
  'DINKSTER_REF must name the exact backend checkout',
)
assert.equal(
  execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  commit,
)
const root = resolve(directory)
await mkdir(root, { recursive: false })
const data = join(root, 'data')
await mkdir(join(data, 'engine'), { recursive: true })
// An explicit development source is not the packaged catalog release.
await writeFile(
  join(data, 'engine', 'selection.json'),
  JSON.stringify({ commit, variant: 'cpu' }),
)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^PYTHON|^VIRTUAL_ENV$/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = data
env.DINKSTER_ENGINE_SOURCE = resolve(source)
env.DINKSTER_ACCELERATOR = 'cpu'
env.DINKSTER_UV = process.env.DINKSTER_UV ?? 'uv'
const app = await electron.launch({
  args: [resolve('packages/desktop')],
  env,
  timeout: 60_000,
})
try {
  const page = await app.firstWindow()
  await page.waitForFunction(
    async () => {
      const status = await window.dinksterDesktop.status()
      if (status.phase === 'failed')
        throw new Error('Managed backend startup failed')
      return status.phase === 'running'
    },
    undefined,
    { timeout: 600_000 },
  )
  const health = await page.evaluate(async () =>
    (await fetch('/supervisor/status')).json(),
  )
  assert.equal(health.state, 'ready')
  const local = await page.evaluate(() =>
    window.dinksterDesktop.fileCapabilities(location.origin),
  )
  assert.equal(local.nativeFolderChoice, true)
  const remote = await page.evaluate(() =>
    window.dinksterDesktop.fileCapabilities('https://remote.invalid'),
  )
  assert.deepEqual(remote, { nativeFolderChoice: false, reveal: false })
  const refused = await page.evaluate(async () => {
    const bridge = window.dinksterDesktop
    const failures = []
    for (const action of [
      () => bridge.chooseDirectory('https://remote.invalid'),
      () => bridge.revealFile('https://remote.invalid', '/ungranted'),
    ]) {
      try {
        await action()
        failures.push(false)
      } catch {
        failures.push(true)
      }
    }
    return failures
  })
  assert.deepEqual(refused, [true, true])

  // Script dialog outcomes, not the IPC bridge or backend: cancellation and
  // raw native paths must survive the real renderer/main transport unchanged.
  const chosen = join(root, 'mounted network folder with spaces')
  await mkdir(chosen)
  await app.evaluate(({ dialog }, path) => {
    globalThis.originalOpenDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, chosen)
  assert.equal(
    await page.evaluate(() =>
      window.dinksterDesktop.chooseDirectory(location.origin),
    ),
    chosen,
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  assert.equal(
    await page.evaluate(() =>
      window.dinksterDesktop.chooseDirectory(location.origin),
    ),
    undefined,
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('Native folder dialog failed')
    }
  })
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.dinksterDesktop.chooseDirectory(location.origin)
        return false
      } catch (error) {
        return String(error).includes('Native folder dialog failed')
      }
    }),
    true,
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.originalOpenDialog
  })

  const untrusted = await app.evaluate(async ({ BrowserWindow }, origin) => {
    const main = BrowserWindow.getAllWindows()[0]
    const preferences = main.webContents.getLastWebPreferences()
    const child = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: preferences.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    try {
      await child.loadURL(origin)
      return await child.webContents.executeJavaScript(`(async () => {
        try { await window.dinksterDesktop.fileCapabilities(location.origin); return false }
        catch (error) { return String(error).includes('untrusted renderer') }
      })()`)
    } finally {
      child.destroy()
    }
  }, page.url())
  assert.equal(untrusted, true)
  await writeFile(
    join(root, 'local-files.json'),
    JSON.stringify(
      {
        backendCommit: commit,
        nativeFolderChoice: true,
        reveal: local.reveal,
        remoteDenied: true,
        cancellation: true,
        errorsVisible: true,
        untrustedSenderDenied: true,
      },
      null,
      2,
    ),
  )
  console.log(
    'Real managed backend and native-file IPC checks passed; native dialog outcomes were scripted',
  )
} finally {
  await app.close()
}
