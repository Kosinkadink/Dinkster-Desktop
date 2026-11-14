import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

assert.equal(
  process.env.RUNNER_ENVIRONMENT,
  'github-hosted',
  'Fresh install proof requires a disposable hosted runner',
)
const executablePath = resolve(process.env.DINKSTER_DESKTOP_EXECUTABLE)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
await mkdir(join(root, 'temporary'))
const publicRoot = 'https://releases.dinkster.org'
const channel = await fetch(`${publicRoot}/channels/stable.json`).then(
  (response) => {
    assert(response.ok())
    return response.json()
  },
)
assert(channel.tools, 'Stable must select current environment tools')
const location = channel.engine.locations.find(
  (location) => location.type === 'mirror',
).path
const bytes = Buffer.from(
  await fetch(`${publicRoot}/${location}`).then((response) => {
    assert(response.ok())
    return response.arrayBuffer()
  }),
)
assert.equal(
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  channel.engine.release,
)
const manifest = JSON.parse(bytes)
const toolsBytes = Buffer.from(
  await fetch(channel.tools.manifest).then((response) => {
    assert(response.ok())
    return response.arrayBuffer()
  }),
)
assert.equal(
  createHash('sha256').update(toolsBytes).digest('hex'),
  channel.tools.sha256,
)
assert.equal(JSON.parse(toolsBytes).commit, manifest.commit)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_|^PATH$/i.test(
        name,
      ),
  ),
)
Object.assign(env, {
  DINKSTER_DESKTOP_DATA: join(root, 'desktop'),
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
  LOCALAPPDATA: join(root, 'local-app-data'),
  APPDATA: join(root, 'app-data'),
  UV_CACHE_DIR: join(root, 'uv-cache'),
  TMPDIR: join(root, 'temporary'),
  TEMP: join(root, 'temporary'),
  TMP: join(root, 'temporary'),
  PATH:
    process.platform === 'win32'
      ? join(process.env.SystemRoot, 'System32')
      : '/usr/bin:/bin',
})
const server = createServer()
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
await new Promise((done) => server.close(done))
const projectRoot = join(root, 'project')
const app = await electron.launch({
  executablePath,
  args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
  env,
  timeout: 60_000,
})
let manager
try {
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  assert.match(
    await app.evaluate(({ app }) => app.getVersion()),
    /^\d+\.\d+\.\d+$/,
  )
  manager = await app.firstWindow()
  await manager
    .getByRole('heading', { name: 'Projects', exact: true })
    .waitFor()
  assert.equal(await manager.locator('#local-channel').inputValue(), 'stable')
  const project = {
    id: 'stable-project',
    name: 'Fresh Stable project',
    channel: 'stable',
    root: projectRoot,
    engines: [{ id: 'main', name: 'main', kind: 'local', gpus: [], port }],
  }
  const request = {
    root: projectRoot,
    operation: 'setup',
    channel: 'stable',
    variant: process.platform === 'win32' ? 'win-cpu' : 'linux-cpu',
    mirrors: [publicRoot],
    data: join(root, 'store'),
    engine: 'main',
    gpus: [],
    port,
  }
  const planned = await manager.evaluate(
    ({ project, request }) => window.dinksterProjects.plan(project, request),
    { project, request },
  )
  await writeFile(join(root, 'plan.json'), JSON.stringify(planned, null, 2))
  assert.equal(planned.result.status, 'planned')
  assert(planned.token)
  const result = await manager.evaluate(
    (token) => window.dinksterProjects.apply(token),
    planned.token,
  )
  await writeFile(join(root, 'setup.json'), JSON.stringify(result, null, 2))
  assert.equal(result.status, 'applied')
  const number = (await readFile(join(projectRoot, 'current'), 'utf8')).trim()
  assert.match(number, /^[1-9][0-9]*$/)
  const generation = join(projectRoot, 'generations', number)
  const record = JSON.parse(
    await readFile(join(generation, 'generation.json'), 'utf8'),
  )
  assert.equal(record.engine.release, channel.engine.release)
  assert.equal(record.engine.version, channel.engine.version)
  const python = join(
    generation,
    'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3',
  )
  const installed = JSON.parse(
    execFileSync(
      python,
      [
        '-I',
        '-c',
        `
import importlib.metadata as metadata, json, sys
from pathlib import Path
from packaging.version import Version
from dinkster_workers import load_manifest
from dinkster_workers.pack_wheel import pack_manifest_path
root = Path(sys.argv[1])
packages = {name: metadata.version(name) for name in ('dinkster', 'dinkster-engine', 'dinkster-inference', 'dinkster-frontend')}
assert Version(packages['dinkster']) >= Version('0.0.4')
assert Version(packages['dinkster-inference']) >= Version('0.1.2')
assert Version(packages['dinkster-frontend']) >= Version('0.1.0')
lock = json.loads((root / 'dinkster.lock').read_text())
packs = {entry['pack']: entry['version'] for entry in lock['packs']}
for name, version in packs.items():
    manifest = load_manifest(pack_manifest_path(root / 'pack-sources' / name))
    assert manifest.compatibility.version == version, name
print(json.dumps({'python': sys.executable, 'packages': packages, 'packs': packs}))
`,
        generation,
      ],
      { encoding: 'utf8', env },
    ),
  )
  assert.equal(installed.packages.dinkster, channel.engine.version)
  assert.equal(installed.packages['dinkster-engine'], channel.engine.version)
  assert.equal(
    installed.packages['dinkster-frontend'],
    (channel.frontend ?? manifest.frontend).version,
  )
  assert.deepEqual(installed.packs, manifest.defaultPacks)
  const toolsTrees = []
  for (const name of await readdir(env.TEMP)) {
    if (!name.startsWith('dinkster-tools-')) continue
    const path = join(env.TEMP, name)
    const bytes = await readFile(join(path, 'tools-manifest.json'))
    if (
      createHash('sha256').update(bytes).digest('hex') === channel.tools.sha256
    )
      toolsTrees.push(path)
  }
  assert.equal(
    toolsTrees.length,
    1,
    'Desktop must acquire the exact Stable tools',
  )
  const toolsPython = join(
    toolsTrees[0],
    'payload/python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3',
  )
  const git = JSON.parse(
    execFileSync(
      toolsPython,
      [
        '-I',
        '-c',
        `
import json, sys, pygit2
from dinkster_supervisor.git_sources import fetched_git_source
with fetched_git_source(sys.argv[1]) as (checkout, provenance):
    assert (checkout / 'pyproject.toml').is_file()
    print(json.dumps({'pygit2': pygit2.__version__, 'libgit2': pygit2.LIBGIT2_VERSION, 'provenance': provenance}))
`,
        `https://github.com/Kosinkadink/Dinkster.git#ref=${manifest.commit}`,
      ],
      { encoding: 'utf8', env },
    ),
  )
  await manager.reload()
  const opened = app.waitForEvent('window', { timeout: 120_000 })
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const engine = await opened
  await expect(engine.getByTestId('graph-canvas')).toBeVisible({
    timeout: 120_000,
  })
  const health = await engine.request.get(
    new URL('/api/health', engine.url()).href,
  )
  assert(health.ok())
  await expect
    .poll(
      async () => {
        const response = await engine.request.get(
          new URL('/api/composition', engine.url()).href,
        )
        const state = await response.json()
        return (
          state.composing === undefined &&
          Object.keys(state.packs).length > 0 &&
          Object.values(state.packs).every((pack) => pack.state === 'announced')
        )
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  await engine.screenshot({
    path: join(root, 'stable-project.png'),
    fullPage: true,
  })
  await writeFile(
    join(root, 'installed-generation.json'),
    JSON.stringify(
      {
        channel,
        manifest,
        generation: record,
        installed,
        git,
        health: await health.json(),
        url: engine.url(),
      },
      null,
      2,
    ),
  )
  await engine.close()
} catch (error) {
  await manager
    ?.screenshot({ path: join(root, 'failed.png'), fullPage: true })
    .catch(() => undefined)
  throw error
} finally {
  await app.close()
}
