import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WslHost, wslWindowsPath } from '../../desktop/dist/wsl.js'

assert.equal(process.platform, 'win32', 'Run on Windows, not inside WSL')
const artifacts = process.env.DINKSTER_WSL_ARTIFACTS
assert(
  artifacts,
  'DINKSTER_WSL_ARTIFACTS must name an owned evidence directory',
)
await mkdir(artifacts, { recursive: true })
const scratch = await mkdtemp(join(resolve(artifacts), 'wsl-jobs-'))
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const pin = JSON.parse(
  await readFile(
    join(repository, 'packages/desktop/src/environment-tools-release.json'),
    'utf8',
  ),
)
const host = new WslHost(join(scratch, 'desktop'), {
  manifest: `https://releases.dinkster.org/tools/${pin.label}/tools-manifest.json`,
  release: `https://releases.dinkster.org/tools/${pin.label}`,
  sha256: pin.manifest.sha256,
})
const execute = promisify(execFile)
async function wsl(args) {
  const { stdout } = await execute('wsl.exe', args, {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 60_000,
  })
  return stdout
    .toString(stdout.includes(0) ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
}
const names = async () =>
  (await wsl(['--list', '--quiet'])).split(/\r?\n/).filter(Boolean).sort()
const original = await names()
assert(
  !original.some(
    (name) => name.toLowerCase() === host.distribution.toLowerCase(),
  ),
  'Never test on an existing distribution',
)
const receipt = {
  distribution: host.distribution,
  scratch,
  original,
  events: [],
  steps: [],
}
const free = await statfs(scratch)
assert(
  free.bavail * free.bsize >= 22 * 1024 ** 3,
  'Start with at least 22 GiB free',
)

async function finish(job, cancelStage) {
  const deadline = Date.now() + 30 * 60_000
  let previous = ''
  let cancelled = false
  while (Date.now() < deadline) {
    const current = host.job('windows-check', job.id)
    const label = `${current.state}:${current.progress.stage}`
    if (label !== previous) {
      receipt.events.push({
        id: job.id,
        state: current.state,
        progress: current.progress,
      })
      previous = label
    }
    if (!['running', 'cancelling'].includes(current.state)) {
      assert.equal(
        current.state,
        cancelStage ? 'cancelled' : 'completed',
        JSON.stringify(current),
      )
      if (cancelStage)
        assert(cancelled, `Did not exercise cancellation at ${cancelStage}`)
      return current
    }
    const free = await statfs(scratch)
    if (free.bavail * free.bsize < 20 * 1024 ** 3) {
      host.cancelJob('windows-check', job.id)
      await host.close()
      throw new Error('Stopped below 20 GiB free')
    }
    if (
      !cancelled &&
      cancelStage === current.progress.stage &&
      (cancelStage !== 'downloading-distribution' ||
        current.progress.completed > 0)
    ) {
      host.cancelJob('windows-check', job.id)
      cancelled = true
    }
    await setTimeout(10)
  }
  throw new Error('WSL job did not finish before its deadline')
}

try {
  receipt.initial = await host.status()
  assert(receipt.initial.available, receipt.initial.detail)
  assert(!receipt.initial.ready)
  await finish(host.startPrepare('windows-check'), 'downloading-distribution')
  assert.deepEqual(await names(), original)
  assert.deepEqual(await readdir(join(scratch, 'desktop/wsl')), [])
  receipt.steps.push(
    'Cancelled a streamed Ubuntu download; no disk or partial download remains',
  )

  await finish(host.startPrepare('windows-check'), 'configuring-distribution')
  assert.deepEqual(await names(), original)
  assert.deepEqual(await readdir(join(scratch, 'desktop/wsl')), [])
  receipt.steps.push(
    'Cancelled guest configuration; the newly imported disk and registration were removed',
  )

  const prepared = await finish(host.startPrepare('windows-check'))
  assert.equal(prepared.result.ready, true)
  assert.equal((await host.status()).ready, true)
  receipt.steps.push('Prepared and checked a private WSL2 distribution')

  const source = join(scratch, 'model-source')
  await mkdir(source)
  const bytes = Buffer.alloc(64 * 1024 * 1024, 137)
  await writeFile(join(source, 'weights.bin'), bytes)
  const controller = new AbortController()
  await assert.rejects(
    host.copyModels(source, controller.signal, (progress) => {
      if (progress.stage === 'copying-models' && progress.completed > 0)
        controller.abort()
    }),
    { name: 'AbortError' },
  )
  const models = wslWindowsPath(host.distribution, '/home/dinkster/models')
  assert.deepEqual(await readdir(models), [])
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  assert.equal(hash(await readFile(join(source, 'weights.bin'))), hash(bytes))
  receipt.steps.push(
    'Cancelled a real model stream; staging removed and source unchanged',
  )

  const copied = await finish(host.startCopy('windows-check', source))
  assert.equal(
    hash(
      await readFile(
        wslWindowsPath(host.distribution, `${copied.result}/weights.bin`),
      ),
    ),
    hash(bytes),
  )
  await assert.rejects(host.copyModels(source), /already exists/)
  receipt.steps.push(
    'Completed model copy has identical bytes and refuses replacement',
  )
  receipt.success = true
} catch (error) {
  receipt.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  try {
    await host.close()
    const remaining = await names()
    if (remaining.includes(host.distribution)) {
      assert.equal(
        await wsl([
          '--distribution',
          host.distribution,
          '--user',
          'root',
          '--exec',
          'cat',
          '/etc/dinkster-desktop-owner',
        ]),
        host.distribution,
      )
      await wsl(['--unregister', host.distribution])
    }
    assert.deepEqual(await names(), original)
    receipt.cleaned = true
  } catch (error) {
    receipt.cleanupError = error.stack ?? String(error)
    process.exitCode = 1
  }
  await writeFile(
    join(artifacts, 'wsl-jobs-results.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
  console.log(JSON.stringify(receipt, null, 2))
}
