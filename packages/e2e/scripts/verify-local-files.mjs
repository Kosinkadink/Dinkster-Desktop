import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const source = process.env.DINKSTER_ENGINE_SOURCE
const commit = process.env.DINKSTER_REF
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
const nativeDialog = process.env.DINKSTER_DESKTOP_VERIFY_NATIVE_DIALOG === '1'
const networkDirectory = process.env.DINKSTER_DESKTOP_VERIFY_NETWORK_DIRECTORY
assert.ok(
  source && directory,
  'Set DINKSTER_ENGINE_SOURCE and a fresh DINKSTER_DESKTOP_VERIFY_ROOT',
)
if (networkDirectory) {
  assert.ok(nativeDialog, 'Network selection requires actual native dialogs')
  assert.ok(
    isAbsolute(networkDirectory),
    'Use an absolute mounted network path',
  )
  assert.ok(
    (await stat(networkDirectory)).isDirectory(),
    'The network directory must already exist',
  )
}
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
// Development sources skip the release catalog preparation in EngineRuntime.
const preparationLog = openSync(join(root, 'catalog-preparation.log'), 'wx')
try {
  execFileSync(
    env.DINKSTER_UV,
    [
      'run',
      '--no-sync',
      'dinkster-pack',
      'prepare-catalogs',
      '--defaults',
      '--library-root',
      join(data, 'library'),
    ],
    {
      cwd: resolve(source),
      env,
      stdio: ['ignore', preparationLog, preparationLog],
    },
  )
} finally {
  closeSync(preparationLog)
}
const app = await electron.launch({
  args: [fileURLToPath(new URL('../../desktop', import.meta.url))],
  chromiumSandbox: true,
  env,
  timeout: 60_000,
})
try {
  const page = await app.firstWindow()
  const deadline = Date.now() + 600_000
  let status
  do {
    status = await page.evaluate(() => window.dinksterDesktop.status())
    if (status.phase === 'failed')
      throw new Error(status.error ?? status.detail)
    if (status.phase === 'running') break
    await delay(250)
  } while (Date.now() < deadline)
  assert.equal(status.phase, 'running', 'Managed backend did not become ready')
  const health = await page.evaluate(async () =>
    (await fetch('/supervisor/status', { cache: 'no-store' })).json(),
  )
  await writeFile(join(root, 'supervisor-status.json'), JSON.stringify(health))
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

  const chosen = join(root, 'local folder with spaces')
  await mkdir(chosen)
  if (nativeDialog) {
    console.log(`Select this folder in the native dialog: ${chosen}`)
    assert.equal(
      await page.evaluate(() =>
        window.dinksterDesktop.chooseDirectory(location.origin),
      ),
      chosen,
    )
    console.log('Cancel the next native folder dialog')
    assert.equal(
      await page.evaluate(() =>
        window.dinksterDesktop.chooseDirectory(location.origin),
      ),
      undefined,
    )
    if (networkDirectory) {
      console.log(`Select this existing network folder: ${networkDirectory}`)
      assert.equal(
        await page.evaluate(() =>
          window.dinksterDesktop.chooseDirectory(location.origin),
        ),
        networkDirectory,
      )
    }
  }
  // Script dialog outcomes, not the IPC bridge or backend: cancellation and
  // raw native paths must survive the real renderer/main transport unchanged.
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

  const untrusted = await app.evaluate(
    async ({ BrowserWindow, app }, origin) => {
      const child = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}/dist/preload.cjs`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      try {
        await child.loadURL(origin)
        return await child.webContents.executeJavaScript(`(async () => {
          const bridge = window.dinksterDesktop
          const results = []
          for (const action of [
            () => bridge.fileCapabilities(location.origin),
            () => bridge.chooseDirectory(location.origin),
            () => bridge.revealFile(location.origin, '/ungranted'),
          ]) {
            try { await action(); results.push('accepted') }
            catch (error) { results.push(String(error)) }
          }
          return results
        })()`)
      } finally {
        child.destroy()
      }
    },
    page.url(),
  )
  await writeFile(
    join(root, 'untrusted-sender.json'),
    JSON.stringify(untrusted),
  )
  assert.equal(untrusted.length, 3)
  for (const rejection of untrusted)
    assert.match(rejection, /untrusted renderer/)

  // Nested frames must not receive their own native-capability bridge.
  const attached = page.waitForEvent('frameattached')
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.id = 'native-capability-frame'
    frame.src = location.origin
    document.body.append(frame)
  })
  const subframe = await attached
  await subframe.waitForLoadState('domcontentloaded')
  assert.equal(
    await subframe.evaluate(() => typeof window.dinksterDesktop),
    'undefined',
  )
  await page.evaluate(() =>
    document.getElementById('native-capability-frame').remove(),
  )

  // Restart the real backend while the dialog is pending. Cached shell status
  // remains running, but the returned path must lose native authority.
  await app.evaluate(
    ({ dialog }, { origin, path }) => {
      dialog.showOpenDialog = async () => {
        const response = await fetch(`${origin}/supervisor/engine/restart`, {
          method: 'POST',
        })
        const status = await response.json()
        if (!response.ok || status.state !== 'starting') {
          throw new Error('Backend restart did not enter the starting state')
        }
        return { canceled: false, filePaths: [path] }
      }
    },
    { origin: new URL(page.url()).origin, path: chosen },
  )
  const restartRejection = await page.evaluate(async () => {
    try {
      await window.dinksterDesktop.chooseDirectory(location.origin)
      return 'accepted'
    } catch (error) {
      return String(error)
    }
  })
  assert.match(restartRejection, /shell-managed backend is no longer available/)
  assert.equal(
    (await page.evaluate(() => window.dinksterDesktop.status())).phase,
    'running',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.originalOpenDialog
  })
  const restartDeadline = Date.now() + 600_000
  let recovered
  do {
    recovered = await page.evaluate(async () =>
      (await fetch('/supervisor/status', { cache: 'no-store' })).json(),
    )
    if (recovered.state === 'failed') throw new Error(recovered.detail)
    if (recovered.state === 'ready') break
    await delay(250)
  } while (Date.now() < restartDeadline)
  assert.equal(recovered.state, 'ready')
  assert.equal(recovered.instance, health.instance)
  assert.notEqual(recovered.engine.pid, health.engine.pid)
  assert.equal(
    (
      await page.evaluate(() =>
        window.dinksterDesktop.fileCapabilities(location.origin),
      )
    ).nativeFolderChoice,
    true,
  )
  await writeFile(
    join(root, 'restart-during-choice.json'),
    JSON.stringify({ rejection: restartRejection, recovered }),
  )
  await writeFile(
    join(root, 'local-files.json'),
    JSON.stringify(
      {
        backendCommit: commit,
        nativeFolderDialogVerified: nativeDialog,
        ...(nativeDialog ? { nativeFolderPath: chosen } : {}),
        scriptedDialogOutcomes: true,
        nativeNetworkPathsVerified: nativeDialog && Boolean(networkDirectory),
        ...(networkDirectory
          ? { nativeNetworkFolderPath: networkDirectory }
          : {}),
        nativeFolderChoice: true,
        reveal: local.reveal,
        remoteDenied: true,
        cancellation: true,
        errorsVisible: true,
        untrustedSenderDenied: true,
        subframeBridgeAbsent: true,
        restartDuringChoiceDenied: true,
      },
      null,
      2,
    ),
  )
  console.log(
    nativeDialog
      ? 'Real managed backend, native folder dialogs and IPC checks passed'
      : 'Real managed backend and native-file IPC checks passed; native dialog outcomes were scripted',
  )
} finally {
  await app.close()
}
