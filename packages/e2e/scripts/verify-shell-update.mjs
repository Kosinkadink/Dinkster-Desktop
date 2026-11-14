import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { _electron as electron } from '@playwright/test'

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
const requests = []
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(
    new URL(request.url, 'http://localhost').pathname.slice(1),
  )
  requests.push({ name, range: request.headers.range ?? null })
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
await new Promise((done) => server.listen(0, '127.0.0.1', done))
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
if (!publicFeed)
  env.DINKSTER_UPDATE_FEED_URL = `http://127.0.0.1:${server.address().port}`
env.XDG_CONFIG_HOME = join(root, 'config')
env.XDG_CACHE_HOME = join(root, 'cache')
env.APPDATA = join(root, 'roaming')
env.LOCALAPPDATA = join(root, 'local')
if (process.platform === 'win32') {
  // NSIS relaunches through the Windows shell, which does not inherit overrides.
  // Use only the disposable hosted user's normal paths for the entire update.
  env.APPDATA = process.env.APPDATA
  env.LOCALAPPDATA = process.env.LOCALAPPDATA
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
env.APPIMAGE_EXTRACT_AND_RUN = '1'
env.TEMP = env.TMP = join(root, 'temp')
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
let app
let installerDriver
try {
  app = await launch(executable, publicFeed)
  const before = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    pid: process.pid,
  }))
  assert(before.packaged)
  assert.notEqual(before.version, expected)
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor()
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
    // Projects is deliberately not a trusted desktop renderer. Startup finishes
    // before it opens; confirm the same real feed via the main-process updater.
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
    await app.close()
    app = undefined
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
    const installing = spawn(executable, ['--no-sandbox'], {
      env,
      stdio: 'ignore',
    })
    installing.on('error', (error) => {
      console.error(error)
      process.exitCode = 1
    })
    const lock = join(env.DINKSTER_DESKTOP_DATA, 'engine', 'lifecycle.lock')
    const deadline = Date.now() + 120_000
    let owner
    for (;;) {
      try {
        const candidate = JSON.parse(await readFile(lock, 'utf8'))
        process.kill(candidate.pid, 0)
        const pending = JSON.parse(await readFile(marker, 'utf8')).pending
        if (!pending && candidate.pid !== before.pid) {
          owner = candidate
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
    // The successor cleared its own pending version. Reopen the replacement
    // executable under Playwright as an independent runtime-version check.
    process.kill(owner.pid, 'SIGTERM')
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
    app = await launch(artifact)
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), expected)
    await (await app.firstWindow())
      .getByRole('heading', { name: 'Projects', exact: true })
      .waitFor()
    await (
      await app.firstWindow()
    ).screenshot({ path: join(root, 'updated.png') })
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify(
        {
          before,
          expectedVersion: expected,
          runtimeVersionVerified: true,
          successorPid: owner.pid,
          userDataRetained: true,
          pendingClearedBySuccessor: true,
          installedArtifact: artifact,
          sha256,
          requests,
        },
        null,
        2,
      ),
    )
    console.log(
      `Installed update ${before.version} -> ${expected}; successor ${owner.pid}; user data retained`,
    )
  }
} finally {
  installerDriver?.kill()
  await app?.close().catch(() => undefined)
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
