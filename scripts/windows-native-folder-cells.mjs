import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const rawRoot = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
const rawEntry = process.env.DINKSTER_DIAGNOSTIC_DESKTOP_ENTRY
const rawSource = process.env.DINKSTER_ENGINE_SOURCE
const rawRef = process.env.DINKSTER_REF
const executablePath = process.env.DINKSTER_DIAGNOSTIC_ELECTRON_EXECUTABLE
assert.ok(rawRoot, 'Set DINKSTER_DESKTOP_VERIFY_ROOT')
assert.ok(rawEntry, 'Set DINKSTER_DIAGNOSTIC_DESKTOP_ENTRY')
assert.ok(rawSource, 'Set DINKSTER_ENGINE_SOURCE')
const require = createRequire(join(resolve(rawEntry), '../e2e/package.json'))
const { _electron: electron } = require('@playwright/test')
assert.match(
  rawRef ?? '',
  /^[a-f0-9]{40}$/,
  'Set DINKSTER_REF to the frozen backend commit',
)
assert.ok(executablePath, 'Set DINKSTER_DIAGNOSTIC_ELECTRON_EXECUTABLE')
assert.equal(
  createHash('sha256').update(readFileSync(executablePath)).digest('hex'),
  '8d205e25b40da3ada4a08c92f32bfbd8e8d38edb4bfe443deea77fc9de685bac',
  'Retained Electron executable hash mismatch',
)
const root = resolve(rawRoot)
const entry = resolve(rawEntry)
const source = resolve(rawSource)
assert.equal(
  execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  rawRef,
  'Frozen backend checkout mismatch',
)
const localPath = join(root, 'local folder with spaces')
const uncPath = process.env.DINKSTER_DESKTOP_VERIFY_NETWORK_DIRECTORY
const mappedPath = process.env.DINKSTER_DESKTOP_VERIFY_MAPPED_DIRECTORY
const cellTimeoutMs = 60_000

assert.ok(uncPath, 'Set DINKSTER_DESKTOP_VERIFY_NETWORK_DIRECTORY')
assert.ok(mappedPath, 'Set DINKSTER_DESKTOP_VERIFY_MAPPED_DIRECTORY')

await mkdir(root, { recursive: false })
await mkdir(localPath)
const data = join(root, 'data')
await mkdir(join(data, 'engine'), { recursive: true })
await mkdir(join(data, 'library'), { recursive: true })
await writeFile(
  join(data, 'engine', 'selection.json'),
  JSON.stringify({ commit: rawRef, variant: 'cpu' }),
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
env.DINKSTER_ENGINE_SOURCE = source
env.DINKSTER_ACCELERATOR = 'cpu'
env.DINKSTER_UV = 'uv'
const catalogCheck = String.raw`
import contextlib
import json
import os
with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
    from dinkster.compose import default_pack_specs
    from dinkster.comfy_compose import comfy_compat_specs
    from dinkster.serve import load_manifest, resolve_manifest_path
    from dinkster_workers.catalog import read_catalog
    specs = (*default_pack_specs(), *comfy_compat_specs())
    valid = [read_catalog(load_manifest(resolve_manifest_path(spec.manifest))) is not None for spec in specs]
print(json.dumps({"count": len(valid), "valid": sum(valid)}))
`
const catalogs = JSON.parse(
  execFileSync('uv', ['run', '--no-sync', 'python', '-c', catalogCheck], {
    cwd: source,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 60_000,
  }),
)
assert.deepEqual(
  catalogs,
  { count: 14, valid: 14 },
  'Prepared source catalogs must remain valid',
)
await writeFile(
  join(root, 'phase-catalog-validated.json'),
  JSON.stringify({ complete: true, ...catalogs }),
)
let app
const eventPath = join(root, 'isolated-native-folder-events.jsonl')
async function addEvent(state) {
  await writeFile(
    eventPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), state })}\n`,
    { flag: 'a' },
  )
}
async function chooseWithTimeout(page, target, mountId) {
  console.log(`Select this folder in the native dialog: ${target}`)
  await addEvent('chooser-prompted')
  const result = await Promise.race([
    page.evaluate(() =>
      window.dinksterDesktop.chooseDirectory(location.origin),
    ),
    delay(cellTimeoutMs).then(() => {
      throw new Error('Native folder chooser timed out')
    }),
  ])
  assert.equal(result, target)
  const registered = await page.evaluate(
    async ({ id, path }) => {
      const added = await fetch('/api/mounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, path, mode: 'read', project: 'default' }),
      })
      if (added.status !== 201)
        throw new Error('Native chosen folder registration failed')
      const response = await fetch('/api/mounts/locations?project=default')
      if (!response.ok) throw new Error('Registered folder lookup failed')
      return (await response.json()).mounts.find((mount) => mount.id === id)
    },
    { id: mountId, path: result },
  )
  assert.equal(registered?.id, mountId)
  assert.equal(registered.path, target)
  assert.equal(registered.mode, 'read')
  const persisted = JSON.parse(
    execFileSync(
      join(source, '.venv', 'Scripts', 'python.exe'),
      [
        '-c',
        'import json,sys,tomllib; from pathlib import Path; data=tomllib.loads(Path(sys.argv[1]).read_text(encoding="utf-8")); print(json.dumps(data["mounts"][sys.argv[2]]))',
        join(data, 'library', 'mounts.toml'),
        mountId,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      },
    ),
  )
  assert.equal(persisted.path, target)
  assert.equal(persisted.mode, 'read')
  await writeFile(
    join(root, `${mountId}-confirmed.json`),
    JSON.stringify({ complete: true, ipcPath: result, registered, persisted }),
  )
  await addEvent('chooser-result-confirmed')
}
try {
  app = await electron.launch({
    args: [entry],
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 60_000,
  })
  await writeFile(
    join(root, 'isolated-native-folder-ready.json'),
    JSON.stringify({ mainPid: await app.evaluate(() => process.pid) }),
  )
  const page = await app.firstWindow()
  const deadline = Date.now() + 600_000
  let status
  do {
    status = await page.evaluate(() => window.dinksterDesktop.status())
    if (status.phase === 'failed')
      throw new Error('Managed backend failed before native dialog cells')
    if (status.phase === 'running') break
    await delay(250)
  } while (Date.now() < deadline)
  assert.equal(status.phase, 'running', 'Managed backend did not become ready')
  await writeFile(
    join(root, 'phase-backend-ready.json'),
    JSON.stringify({ complete: true }),
  )

  await chooseWithTimeout(page, localPath, 'native-local')
  await chooseWithTimeout(page, uncPath, 'native-unc')
  const mapReadyPath = join(root, 'mapped-drive-ready')
  const mapDeadline = Date.now() + cellTimeoutMs
  while (!existsSync(mapReadyPath) && Date.now() < mapDeadline) await delay(100)
  assert.ok(Date.now() < mapDeadline, 'Mapped-drive readiness timed out')
  await chooseWithTimeout(page, mappedPath, 'native-mapped')
  await writeFile(join(root, 'mapped-folder-result-acknowledged'), '')
  const beforeCancel = readFileSync(
    join(data, 'library', 'mounts.toml'),
    'utf8',
  )
  console.log('Cancel the next native folder dialog')
  const canceled = await Promise.race([
    page.evaluate(() =>
      window.dinksterDesktop.chooseDirectory(location.origin),
    ),
    delay(cellTimeoutMs).then(() => {
      throw new Error('Native folder cancellation timed out')
    }),
  ])
  assert.equal(canceled, undefined)
  assert.equal(
    readFileSync(join(data, 'library', 'mounts.toml'), 'utf8'),
    beforeCancel,
  )
  await writeFile(
    join(root, 'isolated-native-folder-result.json'),
    JSON.stringify({ complete: true }),
  )
} finally {
  if (app) {
    await Promise.race([
      app.close(),
      delay(10_000).then(() => {
        throw new Error('Owned application did not close within ten seconds')
      }),
    ])
  }
}
