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
env.DINKSTER_UPDATE_FEED_URL = `http://127.0.0.1:${server.address().port}`
env.XDG_CONFIG_HOME = join(root, 'config')
env.XDG_CACHE_HOME = join(root, 'cache')
env.APPDATA = join(root, 'roaming')
env.LOCALAPPDATA = join(root, 'local')
env.APPIMAGE_EXTRACT_AND_RUN = '1'
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: ['--no-sandbox'],
    env,
    timeout: 120_000,
  })
let app
try {
  app = await launch()
  const before = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    pid: process.pid,
  }))
  assert(before.packaged)
  assert.notEqual(before.version, expected)
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor()
  const marker = join(
    env.DINKSTER_DESKTOP_DATA,
    'updates',
    'shell-attempts.json',
  )
  if (corrupt) {
    const pending = await readFile(marker, 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
    assert.equal(pending?.pending, undefined)
    assert(
      requests.some(
        (request) => /\.(AppImage|exe)$/.test(request.name) && !request.range,
      ),
      'The corrupt installer must have been downloaded',
    )
    assert.equal(
      await app.evaluate(({ app }) => app.getVersion()),
      before.version,
    )
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify(
        { before, corruptDownloadRejected: true, requests },
        null,
        2,
      ),
    )
    console.log(
      `Rejected corrupt update; installed version remains ${before.version}`,
    )
  } else {
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')).pending, {
      version: expected,
      attempts: 0,
    })
    const sentinel = join(
      env.DINKSTER_DESKTOP_DATA,
      'update-retains-user-data.txt',
    )
    await writeFile(sentinel, 'retained user data\n')
    await page.screenshot({ path: join(root, 'download-ready.png') })
    await app.close()
    app = undefined
    // Do not attach Playwright to the installing process: its replacement does
    // not carry the inspector endpoint and can start before attachment finishes.
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
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify(
        {
          before,
          expectedVersion: expected,
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
    // Only terminate the successor that holds this proof directory's own lease.
    process.kill(owner.pid, 'SIGTERM')
    console.log(
      `Installed update ${before.version} -> ${expected}; successor ${owner.pid}; user data retained`,
    )
  }
} finally {
  await app?.close().catch(() => undefined)
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
