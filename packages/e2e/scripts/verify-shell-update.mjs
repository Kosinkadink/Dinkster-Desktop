import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, createReadStream, openSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { _electron as electron, expect } from '@playwright/test'

// Supply real packaged builds, not a development Electron process or a fake updater.
const executable = resolve(process.env.DINKSTER_UPDATE_OLD_EXECUTABLE ?? '')
const feed = resolve(process.env.DINKSTER_UPDATE_RELEASE ?? '')
const root = resolve(process.env.DINKSTER_UPDATE_PROOF_ROOT ?? '')
const expected = process.env.DINKSTER_UPDATE_EXPECTED_VERSION
const corrupt = process.env.DINKSTER_UPDATE_CORRUPT === '1'
const unavailable = process.env.DINKSTER_UPDATE_EXPECT_UNAVAILABLE === '1'
const signatureRefusal =
  process.env.DINKSTER_UPDATE_EXPECT_SIGNATURE_REFUSAL === '1'
const publicFeed = process.env.DINKSTER_UPDATE_PUBLIC_FEED === '1'
assert(
  !publicFeed || !(corrupt || unavailable || signatureRefusal),
  'Negative controls require the isolated feed',
)
if (process.platform === 'win32') {
  assert(
    process.env.GITHUB_ACTIONS === 'true' &&
      process.env.RUNNER_ENVIRONMENT === 'github-hosted',
    'Windows installed-update verification requires a disposable GitHub-hosted runner',
  )
}
assert(
  expected &&
    process.env.DINKSTER_UPDATE_OLD_EXECUTABLE &&
    process.env.DINKSTER_UPDATE_RELEASE &&
    process.env.DINKSTER_UPDATE_PROOF_ROOT,
  'Set DINKSTER_UPDATE_OLD_EXECUTABLE, DINKSTER_UPDATE_RELEASE, DINKSTER_UPDATE_PROOF_ROOT and DINKSTER_UPDATE_EXPECTED_VERSION',
)
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
assert.equal(
  await homeStopped(),
  true,
  'Leave an existing Home on port 3638 alone',
)
const requests = []
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(
    new URL(request.url, 'http://localhost').pathname.slice(1),
  )
  const outcome = {
    name,
    url: `http://127.0.0.1:${server.address().port}/${encodeURIComponent(name)}`,
    range: request.headers.range ?? null,
    status: null,
  }
  requests.push(outcome)
  response.on('finish', () => {
    outcome.status = response.statusCode
  })
  if (basename(name) !== name) {
    response.writeHead(404).end()
    return
  }
  try {
    const path = join(feed, name)
    const size = (await stat(path)).size
    const range = corrupt
      ? null
      : /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range && range[2] ? Number(range[2]) : size - 1
    response.writeHead(range ? 206 : 200, {
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    })
    const source = createReadStream(path, { start, end })
    if (corrupt && !name.endsWith('.yml')) {
      let changed = false
      source
        .pipe(
          new Transform({
            transform(chunk, _encoding, done) {
              if (!changed) {
                chunk[0] ^= 1
                changed = true
              }
              done(null, chunk)
            },
          }),
        )
        .pipe(response)
    } else source.pipe(response)
  } catch {
    response.writeHead(404).end()
  }
})
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = join(root, 'data')
env.HOME = env.USERPROFILE = join(root, 'home')
env.DINKSTER_HOME = join(env.HOME, '.dinkster')
env.DINKSTER_ACCELERATOR = 'cpu'
env.CUDA_VISIBLE_DEVICES = ''
env.XDG_DATA_HOME = join(root, 'xdg-data')
env.XDG_CONFIG_HOME = join(root, 'config')
env.XDG_CACHE_HOME = join(root, 'cache')
env.APPDATA = join(root, 'roaming')
env.LOCALAPPDATA = join(root, 'local')
if (process.platform === 'win32') {
  // NSIS relaunches through the Windows shell, which does not inherit overrides.
  // Use only the disposable hosted user's normal paths for the entire update.
  env.APPDATA = process.env.APPDATA
  env.LOCALAPPDATA = process.env.LOCALAPPDATA
  env.HOME = env.USERPROFILE = process.env.USERPROFILE
  // The installer successor must use the same default Home without overrides.
  env.DINKSTER_HOME = join(env.USERPROFILE, '.dinkster')
  env.DINKSTER_DESKTOP_DATA = join(env.LOCALAPPDATA, 'Dinkster Desktop')
  assert.equal(
    await stat(env.DINKSTER_DESKTOP_DATA).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false
        throw error
      },
    ),
    false,
    'The hosted user must not have existing Desktop data',
  )
}
await mkdir(env.DINKSTER_HOME, { recursive: process.platform !== 'win32' })
await writeFile(
  join(env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ locations: [] }),
)
env.APPIMAGE_EXTRACT_AND_RUN = '1'
env.TEMP = env.TMP = join(root, 'temp')
env.TMPDIR = env.TEMP
await mkdir(env.TEMP)
const launch = (path = executable, recordNetwork = false) =>
  electron.launch({
    executablePath: path,
    args: [
      '--no-sandbox',
      ...(recordNetwork ? [`--log-net-log=${join(root, 'network.json')}`] : []),
    ],
    env,
    timeout: 120_000,
  })
const sentinel = join(env.DINKSTER_DESKTOP_DATA, 'update-retains-user-data.txt')
await mkdir(env.DINKSTER_DESKTOP_DATA, { recursive: true })
await writeFile(sentinel, 'retained user data\n')
await new Promise((done) => server.listen(0, '127.0.0.1', done))
if (!publicFeed)
  env.DINKSTER_UPDATE_FEED_URL = `http://127.0.0.1:${server.address().port}`
let app
let installerDriver
let before
let successor
const lock = join(env.DINKSTER_DESKTOP_DATA, 'engine', 'lifecycle.lock')
const homes = []
async function sharedHome() {
  const page = await app.firstWindow({ timeout: 120_000 })
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
  assert(Number.isSafeInteger(status.supervisor.pid))
  assert.equal(typeof status.instance, 'string')
  assert(status.instance.length > 0)
  homes.push(status)
  return page
}
async function quit() {
  const closed = app.waitForEvent('close', { timeout: 30_000 })
  await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await closed
  app = undefined
  await expect.poll(homeStopped, { timeout: 30_000 }).toBe(true)
}
async function closeSuccessor(owner) {
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), owner)
  // Use the native window-close path, not SIGTERM, so detached Home stops too.
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$ErrorActionPreference = 'Stop'
$process = Get-Process -Id ${owner.pid}
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $process.Refresh()
  if ($process.HasExited) { throw 'Successor exited before its native window opened' }
  if ($process.MainWindowHandle -ne 0) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $process.CloseMainWindow()) { throw 'Successor has no closeable native window' }`,
      ],
      { env, timeout: 35_000 },
    )
  } else {
    let ids
    await expect
      .poll(
        () => {
          ids = execFileSync('wmctrl', ['-lp'], {
            env,
            encoding: 'utf8',
            timeout: 10_000,
          })
            .trim()
            .split('\n')
            .map((line) => line.trim().split(/\s+/))
            .filter((fields) => fields[2] === String(owner.pid))
            .map((fields) => fields[0])
          return ids.length
        },
        { timeout: 30_000 },
      )
      .toBe(1)
    execFileSync('wmctrl', ['-ic', ids[0]], { env, timeout: 10_000 })
  }
  const stopped = Date.now() + 30_000
  for (;;) {
    try {
      process.kill(owner.pid, 0)
    } catch {
      break
    }
    assert(Date.now() < stopped, 'Successor did not stop')
    await new Promise((done) => setTimeout(done, 100))
  }
  await expect.poll(homeStopped, { timeout: 30_000 }).toBe(true)
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
}
try {
  app = await launch(executable, publicFeed)
  before = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    pid: process.pid,
  }))
  assert(before.packaged)
  assert.notEqual(before.version, expected)
  let page = await app.firstWindow({ timeout: 120_000 })
  // A published predecessor can still have the removed Desktop manager.
  // The updated successor must use shared Home, never this old bridge.
  const historicalManager = await page.evaluate(
    () => typeof window.dinksterProjects !== 'undefined',
  )
  if (historicalManager)
    await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor()
  else page = await sharedHome()
  const channel = before.version.includes('-rc.') ? 'rc' : 'latest'
  const manifest = `${channel}${process.platform === 'linux' ? '-linux' : ''}.yml`
  if (!publicFeed)
    assert(
      requests.some((request) => request.name === manifest),
      'Startup must request its own channel manifest',
    )
  assert(
    requests
      .filter((request) => request.name.endsWith('.yml'))
      .every((request) => request.name === manifest),
    'Startup must not consult the other channel',
  )
  const marker = join(
    env.DINKSTER_DESKTOP_DATA,
    'updates',
    'shell-attempts.json',
  )
  if (corrupt || unavailable || signatureRefusal) {
    const startupRequests = requests.slice()
    // Shared Home cannot initiate an update. Startup finishes before it opens;
    // confirm the same real feed via the main-process updater.
    const update = await app.evaluate(async ({ app }, download) => {
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(`${app.getAppPath()}/package.json`)
      const { autoUpdater } = require('electron-updater')
      const result = await autoUpdater.checkForUpdates()
      let refusalCode
      if (download) {
        try {
          await autoUpdater.downloadUpdate()
        } catch (error) {
          refusalCode = error.code
        }
      }
      return {
        version: result?.updateInfo.version,
        available: result?.isUpdateAvailable,
        refusalCode,
      }
    }, !unavailable)
    assert.equal(
      update.version,
      expected,
      'The real feed must parse successfully',
    )
    assert.equal(
      update.available,
      !unavailable,
      'Only the newer version may be offered',
    )
    if (!unavailable)
      assert.equal(
        update.refusalCode,
        signatureRefusal
          ? 'ERR_UPDATER_INVALID_SIGNATURE'
          : 'ERR_CHECKSUM_MISMATCH',
        'The installed updater must refuse the actual integrity or publisher violation',
      )
    assert.equal(await readFile(sentinel, 'utf8'), 'retained user data\n')
    const pending = await readFile(marker, 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
    assert.equal(pending?.pending, undefined)
    assert(
      startupRequests.some((request) => request.name.endsWith('.yml')),
      'The feed must have been checked during startup',
    )
    const downloaded = startupRequests.some((request) =>
      /\.(AppImage|exe)$/.test(request.name),
    )
    assert.equal(
      downloaded,
      !unavailable,
      unavailable
        ? 'A downgrade must not download an installer'
        : 'The refused installer must have been downloaded during startup',
    )
    assert.equal(
      await app.evaluate(({ app }) => app.getVersion()),
      before.version,
    )
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify(
        {
          before,
          corruptDownloadRejected: corrupt,
          downgradeRejected: unavailable,
          signatureRejected: signatureRefusal,
          userDataRetained: true,
          update,
          startupRequests,
          requests,
          homes,
          historicalManager,
        },
        null,
        2,
      ),
    )
    console.log(
      `Rejected ${corrupt ? 'corrupt update' : signatureRefusal ? 'unsigned update' : 'downgrade'}; installed version remains ${before.version}`,
    )
  } else {
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')).pending, {
      version: expected,
      attempts: 0,
    })
    await page.screenshot({ path: join(root, 'download-ready.png') })
    await quit()
    if (publicFeed) {
      const network = await readFile(join(root, 'network.json'), 'utf8')
      assert(
        network.includes(
          'https://github.com/Kosinkadink/Dinkster-Desktop/releases/',
        ),
        'The default public release feed must be requested',
      )
      assert(
        network.includes(manifest),
        'The public feed must request its own channel manifest',
      )
      assert.equal(
        requests.length,
        0,
        'A public-feed update must not use the loopback feed',
      )
    }
    // Do not attach Playwright to the installing process: its replacement does
    // not carry the inspector endpoint and can start before attachment finishes.
    if (process.platform === 'win32') {
      installerDriver = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-File',
          join(import.meta.dirname, 'advance-update-installer.ps1'),
          '-Root',
          root,
        ],
        { env, stdio: 'ignore' },
      )
    }
    const output = openSync(join(root, 'installing-output.txt'), 'w')
    const installing = spawn(executable, ['--no-sandbox'], {
      env,
      stdio: ['ignore', output, output],
    })
    closeSync(output)
    installing.on('error', (error) => {
      console.error(error)
      process.exitCode = 1
    })
    const deadline = Date.now() + 120_000
    let owner
    for (;;) {
      try {
        const candidate = JSON.parse(await readFile(lock, 'utf8'))
        process.kill(candidate.pid, 0)
        const pending = JSON.parse(await readFile(marker, 'utf8')).pending
        if (!pending && candidate.pid !== before.pid) {
          owner = candidate
          successor = candidate
          break
        }
      } catch {}
      if (Date.now() >= deadline)
        throw new Error(
          'The installed successor did not start and clear its pending version',
        )
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.equal(await readFile(sentinel, 'utf8'), 'retained user data\n')
    const files = await readdir(join(executable, '..'))
    const artifact =
      process.platform === 'linux'
        ? join(
            executable,
            '..',
            files.find(
              (name) => name.endsWith('.AppImage') && name.includes(expected),
            ) ?? basename(executable),
          )
        : executable
    assert((await stat(artifact)).mode & 0o111 || process.platform === 'win32')
    const sha256 = createHash('sha256')
      .update(await readFile(artifact))
      .digest('hex')
    if (process.platform === 'linux') {
      assert.equal(
        sha256,
        createHash('sha256')
          .update(await readFile(join(feed, basename(artifact))))
          .digest('hex'),
      )
    }
    let successorHome
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${homeUrl}/supervisor/status`, {
              signal: AbortSignal.timeout(2000),
            })
            assert(response.ok)
            successorHome = await response.json()
            return (
              successorHome.role === 'home' && successorHome.state === 'stopped'
            )
          } catch {
            return false
          }
        },
        { timeout: 120_000 },
      )
      .toBe(true)
    if (homes.length) assert.notEqual(successorHome.instance, homes[0].instance)
    assert(Number.isSafeInteger(successorHome.supervisor.pid))
    assert.equal(typeof successorHome.instance, 'string')
    assert(successorHome.instance.length > 0)
    homes.push(successorHome)
    await closeSuccessor(owner)
    successor = undefined
    // Reopen independently to verify the installed runtime, not just its marker.
    app = await launch(artifact)
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), expected)
    const updatedPage = await sharedHome()
    assert.notEqual(homes.at(-1).instance, successorHome.instance)
    await updatedPage.screenshot({ path: join(root, 'updated.png') })
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify(
        {
          before,
          expectedVersion: expected,
          runtimeVersionVerified: true,
          successorPid: owner.pid,
          successorClosedNatively: true,
          successorHomeStopped: true,
          successorLeaseReleased: true,
          userDataRetained: true,
          pendingClearedBySuccessor: true,
          installedArtifact: artifact,
          sha256,
          requests,
          homes,
          historicalManager,
          desktopLog: await readFile(
            join(env.DINKSTER_DESKTOP_DATA, 'logs', 'desktop.log'),
            'utf8',
          ),
          installerProcesses:
            process.platform === 'win32'
              ? await readFile(
                  join(root, 'installer-processes.json'),
                  'utf8',
                ).catch(String)
              : undefined,
        },
        null,
        2,
      ),
    )
    console.log(
      `Installed update ${before.version} -> ${expected}; successor ${owner.pid}; user data retained`,
    )
  }
} catch (error) {
  const diagnostics = {
    error: String(error),
    before,
    expectedVersion: expected,
    requests,
  }
  for (const [name, path] of Object.entries({
    marker: join(env.DINKSTER_DESKTOP_DATA, 'updates', 'shell-attempts.json'),
    lifecycle: join(env.DINKSTER_DESKTOP_DATA, 'engine', 'lifecycle.lock'),
    desktopLog: join(env.DINKSTER_DESKTOP_DATA, 'logs', 'desktop.log'),
    installerProcesses: join(root, 'installer-processes.json'),
  })) {
    diagnostics[name] = await readFile(path, 'utf8').catch(String)
  }
  if (process.platform === 'win32') {
    try {
      diagnostics.processes = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient
$bounds = [Windows.Forms.SystemInformation]::VirtualScreen
$image = New-Object Drawing.Bitmap $bounds.Width,$bounds.Height
$graphics = [Drawing.Graphics]::FromImage($image)
$graphics.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size)
$image.Save((Join-Path $env:DINKSTER_DIAGNOSTIC_ROOT 'installer-failed.png'))
$graphics.Dispose()
$image.Dispose()
$processes = @(Get-Process | Where-Object { $_.ProcessName -like '*dinkster*' -or $_.MainWindowTitle -like 'Dinkster*' })
foreach ($process in $processes) {
  if ($process.MainWindowHandle -eq 0) { continue }
  $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Add-Content (Join-Path $env:DINKSTER_DIAGNOSTIC_ROOT 'installer-controls.txt')
}
$processes | Select-Object Id,ProcessName,Path,MainWindowTitle | ConvertTo-Json
`,
        ],
        {
          env: { ...env, DINKSTER_DIAGNOSTIC_ROOT: root },
          encoding: 'utf8',
          timeout: 10_000,
        },
      )
    } catch (diagnosticError) {
      diagnostics.processes = String(diagnosticError)
    }
  }
  await writeFile(
    join(root, 'failure.json'),
    JSON.stringify(diagnostics, null, 2),
  )
  throw error
} finally {
  installerDriver?.kill()
  try {
    if (app) await quit()
    if (successor) await closeSuccessor(successor)
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}
