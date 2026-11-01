import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from '@playwright/test'

const source = process.env.DINKSTER_ENGINE_SOURCE
const commit = process.env.DINKSTER_REF
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
const executablePath = process.env.DINKSTER_DESKTOP_VERIFY_ELECTRON
const network = process.env.DINKSTER_DESKTOP_VERIFY_NETWORK_DIRECTORY
const mapped = process.env.DINKSTER_DESKTOP_VERIFY_MAPPED_DIRECTORY
assert.ok(source && directory && executablePath)
assert.match(commit ?? '', /^[a-f0-9]{40}$/)
assert.equal(
  execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  commit,
)
assert.equal(
  process.platform,
  'win32',
  'This packet qualifies Windows path forms',
)
assert.ok(network?.startsWith('\\\\') && isAbsolute(network))
assert.match(mapped ?? '', /^[D-Z]:\\$/)
assert.equal((await stat(network)).isDirectory(), true)
const root = resolve(directory)
await mkdir(root, { recursive: false })
const local = join(root, 'local folder with spaces')
const configured = join(root, 'existing custom output')
const data = join(root, 'data')
await mkdir(local)
await mkdir(configured)
await mkdir(join(data, 'engine'), { recursive: true })
await writeFile(join(configured, 'keep.txt'), 'existing output bytes')
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
env.DINKSTER_UV = 'uv'
// The hook is set before launch, so this packet cannot open an OS picker.
env.DINKSTER_TEST_FOLDER_CHOICE = 'null'
const python = join(source, '.venv', 'Scripts', 'python.exe')
const catalog = JSON.parse(
  execFileSync(
    python,
    [
      '-c',
      `
import contextlib,json,os
with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
    from dinkster.compose import default_pack_specs
    from dinkster.comfy_compose import comfy_compat_specs
    from dinkster.serve import load_manifest,resolve_manifest_path
    from dinkster_workers.catalog import read_catalog
    specs=(*default_pack_specs(),*comfy_compat_specs())
    valid=[read_catalog(load_manifest(resolve_manifest_path(s.manifest))) is not None for s in specs]
print(json.dumps({'count':len(valid),'valid':sum(valid)}))
`,
    ],
    {
      cwd: source,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    },
  ),
)
assert.deepEqual(catalog, { count: 14, valid: 14 })
const mountsFile = join(data, 'library', 'mounts.toml')
let app
let page
let ownsMapping = false
let stage = 'launch'
const result = {
  complete: false,
  osPickerDriven: false,
  local: false,
  unc: false,
  mapped: false,
  cancellation: false,
  defaultOutputCreated: false,
  configuredOutputPreserved: false,
  restart: false,
}

async function launch() {
  app = await electron.launch({
    args: [fileURLToPath(new URL('../../desktop', import.meta.url))],
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 60_000,
  })
  app.process().stdout.on('data', () => {})
  app.process().stderr.on('data', () => {})
  await app.evaluate(({ app, dialog }) => {
    if (app.isPackaged)
      throw new Error('Chooser seam packet requires a development app')
    // A missing/broken hook must fail, never fall through to native automation.
    dialog.showOpenDialog = async () => {
      throw new Error('OS picker disabled in seam packet')
    }
  })
  page = await app.firstWindow()
  const deadline = Date.now() + 600_000
  do {
    const status = await page.evaluate(() => window.dinksterDesktop.status())
    if (status.phase === 'failed') throw new Error('Managed backend failed')
    if (status.phase === 'running') return
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error('Managed backend readiness deadline exceeded')
}

async function choose(path) {
  await app.evaluate((_, value) => {
    process.env.DINKSTER_TEST_FOLDER_CHOICE = JSON.stringify(value)
  }, path)
  return Promise.race([
    page.evaluate(() =>
      window.dinksterDesktop.chooseDirectory(location.origin),
    ),
    delay(60_000, undefined, { ref: false }).then(() => {
      throw new Error('Chooser IPC deadline exceeded')
    }),
  ])
}

async function close() {
  await Promise.race([
    app.close(),
    delay(30_000, undefined, { ref: false }).then(() => {
      throw new Error('Owned application close deadline exceeded')
    }),
  ])
}

async function locations() {
  return page.evaluate(async () => {
    const response = await fetch('/api/mounts/locations?project=default')
    const project = await fetch('/api/mounts?project=default')
    if (!response.ok || !project.ok) throw new Error('Folder lookup failed')
    return {
      ...(await response.json()),
      outputMount: (await project.json()).outputMount,
    }
  })
}

async function register(id, path, mode) {
  const ipcPath = await choose(path)
  assert.equal(ipcPath, path)
  assert.equal((await stat(ipcPath)).isDirectory(), true)
  await page.evaluate(
    async ({ id, path, mode }) => {
      const response = await fetch('/api/mounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, path, mode, project: 'default' }),
      })
      if (response.status !== 201)
        throw new Error('Chosen folder registration failed')
    },
    { id, path: ipcPath, mode },
  )
  const registered = (await locations()).mounts.find((mount) => mount.id === id)
  assert.equal(registered?.path, path)
  assert.equal(registered.mode, mode)
  const persisted = JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        'import json,sys,tomllib; from pathlib import Path; print(json.dumps(tomllib.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["mounts"][sys.argv[2]]))',
        mountsFile,
        id,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      },
    ),
  )
  assert.equal(persisted.path, path)
  // The backend omits the default read mode from mounts.toml.
  assert.equal(persisted.mode ?? 'read', mode)
  await writeFile(
    join(root, `${id}.json`),
    JSON.stringify({ ipcPath, registered, persisted }),
  )
}

try {
  console.log(
    JSON.stringify({ state: 'chooser-seam-started', pid: process.pid }),
  )
  await launch()
  const initial = await locations()
  const output = initial.activeMounts.find(
    (mount) => mount.id === initial.outputMount,
  )
  assert.equal(output?.path, join(data, 'library', 'output'))
  assert.equal(output.mode, 'readwrite')
  assert.equal((await stat(output.path)).isDirectory(), true)
  result.defaultOutputCreated = true
  stage = 'local'
  await register('seam-local', local, 'read')
  result.local = true
  stage = 'unc'
  // Python Path serializes a UNC share root with its trailing separator.
  await register('seam-unc', resolve(network), 'read')
  result.unc = true
  stage = 'mapped'
  const drive = mapped.slice(0, 2)
  let existing = true
  try {
    execFileSync('net.exe', ['use', drive], { stdio: 'ignore' })
  } catch (error) {
    if (error.status === undefined) throw error
    existing = false
  }
  assert.equal(existing, false, 'Mapped drive already in use')
  try {
    await stat(mapped)
    throw new Error('Drive letter already exists')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  execFileSync('net.exe', ['use', drive, network, '/persistent:no'], {
    stdio: 'ignore',
    timeout: 10_000,
  })
  ownsMapping = true
  await register('seam-mapped', mapped, 'read')
  result.mapped = true
  stage = 'cancel'
  const beforeCancel = await readFile(mountsFile)
  assert.equal(await choose(null), undefined)
  assert.deepEqual(await readFile(mountsFile), beforeCancel)
  result.cancellation = true
  stage = 'configured-output'
  await register('seam-output', configured, 'readwrite')
  await page.evaluate(async () => {
    const selected = await fetch('/api/mounts/output', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'seam-output' }),
    })
    if (!selected.ok) throw new Error('Output selection failed')
    const current = await (await fetch('/api/mounts?project=default')).json()
    const project = await fetch('/api/mounts/projects/default', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mounts: current.mounts.map((mount) => mount.id),
        outputMount: 'seam-output',
      }),
    })
    if (!project.ok) throw new Error('Project output selection failed')
  })
  stage = 'restart'
  await close()
  app = undefined
  await launch()
  const restarted = await locations()
  assert.equal(restarted.outputMount, 'seam-output')
  assert.equal(
    restarted.activeMounts.find((mount) => mount.id === 'seam-output')?.path,
    configured,
  )
  assert.equal(
    await readFile(join(configured, 'keep.txt'), 'utf8'),
    'existing output bytes',
  )
  assert.equal(await choose(local), local)
  result.configuredOutputPreserved = true
  result.restart = true
} catch (error) {
  await writeFile(
    join(root, 'failure.json'),
    JSON.stringify({
      stage,
      type: error.constructor.name,
      message: error.message,
      stack: error.stack,
      result,
    }),
  )
  console.log(
    JSON.stringify({ state: 'chooser-seam-failed', stage, complete: false }),
  )
  process.exitCode = 1
} finally {
  try {
    if (app) await close()
  } finally {
    if (ownsMapping)
      execFileSync('net.exe', ['use', mapped.slice(0, 2), '/delete', '/y'], {
        stdio: 'ignore',
        timeout: 10_000,
      })
  }
}
if (process.exitCode !== 1) {
  result.complete = true
  await writeFile(join(root, 'result.json'), JSON.stringify(result))
  console.log(JSON.stringify(result))
}
