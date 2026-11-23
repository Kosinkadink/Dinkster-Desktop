import assert from 'node:assert/strict'
import { installationManager } from './installation-manager.mjs'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer as createMirror } from 'node:http'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { forwardMirror } from './forward-mirror.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { verifyChannel } from '../../desktop/src/channel-signatures.ts'

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
const channelText = await fetch(`${publicRoot}/channels/stable.json`).then(
  (response) => {
    assert(response.ok)
    return response.text()
  },
)
const channel = verifyChannel(channelText, 'stable')
assert(channel.tools, 'Stable must select current environment tools')
const location = channel.engine.locations.find(
  (location) => location.type === 'mirror',
).path
const bytes = Buffer.from(
  await fetch(`${publicRoot}/${location}`).then((response) => {
    assert(response.ok)
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
    assert(response.ok)
    return response.arrayBuffer()
  }),
)
assert.equal(
  createHash('sha256').update(toolsBytes).digest('hex'),
  channel.tools.sha256,
)
assert.equal(JSON.parse(toolsBytes).commit, manifest.commit)
const toolsManifest = JSON.parse(toolsBytes)
const toolsOs = { win32: 'windows', linux: 'linux', darwin: 'macos' }[
  process.platform
]
const toolsArch = { x64: 'x86_64', arm64: 'arm64' }[process.arch]
assert(toolsOs && toolsArch, 'Unsupported packaged acceptance platform')
const toolsName = `dinkster-tools-${toolsOs}-${toolsArch}.zip`
const toolsRow = toolsManifest.artifacts.find((row) => row.name === toolsName)
assert(toolsRow)
const toolsArchive = Buffer.from(
  await fetch(`${channel.tools.release}/${toolsName}`).then((response) => {
    assert(response.ok)
    return response.arrayBuffer()
  }),
)
assert.equal(toolsArchive.length, toolsRow.size)
assert.equal(
  createHash('sha256').update(toolsArchive).digest('hex'),
  toolsRow.sha256,
)
const toolsPath = `/tools/${channel.tools.label}`
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
let mirrorChannel = channelText
let mirrorOnline = true
const mirrorRequests = []
const mirrorFailures = []
const failedMirrorRequests = new Set()
const mirror = createMirror(async (request, response) => {
  mirrorRequests.push(request.url)
  if (!mirrorOnline) {
    response.writeHead(503).end('Mirror unavailable')
    return
  }
  if (
    request.url === '/channels/stable.json' ||
    request.url === '/channels/nightly.json'
  ) {
    response.setHeader('Content-Type', 'application/json')
    response.end(mirrorChannel)
    return
  }
  if (request.url === `${toolsPath}/tools-manifest.json`) {
    response.end(toolsBytes)
    return
  }
  if (request.url === `${toolsPath}/${toolsName}`) {
    response.end(toolsArchive)
    return
  }
  try {
    await forwardMirror(`${publicRoot}${request.url}`, response)
    failedMirrorRequests.delete(request.url)
  } catch (error) {
    failedMirrorRequests.add(request.url)
    mirrorFailures.push(error)
    console.error(error)
    writeFileSync(
      join(root, 'mirror-failures.json'),
      JSON.stringify(
        mirrorFailures.map((failure) => failure.diagnostic),
        null,
        2,
      ),
    )
  }
})
await new Promise((done) => mirror.listen(0, '127.0.0.1', done))
const mirrorUrl = `http://127.0.0.1:${mirror.address().port}`
const app = await electron.launch({
  executablePath,
  args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
  env,
  timeout: 60_000,
})
let manager
let toolsPython
try {
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  await app.evaluate(() => {
    const original = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.hostname === 'releases.dinkster.org')
        throw new Error('Official tools origin denied')
      return original(input, options)
    }
  })
  await assert.rejects(
    app.evaluate(() => fetch('https://releases.dinkster.org/tools/denied')),
    /Official tools origin denied/,
  )
  assert.match(
    await app.evaluate(({ app }) => app.getVersion()),
    /^\d+\.\d+\.\d+$/,
  )
  manager = await installationManager(app)
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
    variant: { win32: 'win-cpu', linux: 'linux-cpu', darwin: 'mac-arm64' }[
      process.platform
    ],
    mirrors: [mirrorUrl],
    data: join(root, 'store'),
    engine: 'main',
    gpus: [],
    port,
  }
  const envelope = JSON.parse(channelText)
  const refusedChannels = {
    unsigned: JSON.stringify(envelope.signed),
    tampered: channelText.replace(channel.engine.version, '999.0.0'),
    wrongKey: channelText.replace(
      envelope.signatures[0].keyId,
      `sha256:${'f'.repeat(64)}`,
    ),
    wrongChannel: await fetch(`${publicRoot}/channels/nightly.json`).then(
      (response) => {
        assert(response.ok)
        return response.text()
      },
    ),
  }
  for (const [name, text] of Object.entries(refusedChannels)) {
    assert.notEqual(text, channelText)
    mirrorChannel = text
    await assert.rejects(
      manager.evaluate(
        ({ project, request }) =>
          window.dinksterProjects.plan(project, request),
        { project, request },
      ),
      /no mirror supplied a valid trusted channel/,
      name,
    )
    await assert.rejects(stat(projectRoot), { code: 'ENOENT' })
  }
  mirrorChannel = channelText
  const integrity = await app.evaluate(
    async ({ app }, { root, tools, manifest, toolsName }) => {
      const path = process.getBuiltinModule('node:path')
      const fs = process.getBuiltinModule('node:fs/promises')
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(path.join(app.getAppPath(), 'package.json'))
      const { acquireEnvironmentTools } = require(
        path.join(app.getAppPath(), 'dist/environment-tools.js'),
      )
      const directory = path.join(root, 'corrupt-tools')
      await fs.mkdir(directory)
      const input = {
        ...tools,
        manifest: path.join(directory, 'tools-manifest.json'),
        release: directory,
      }
      const results = {}
      const refuse = async (name) => {
        try {
          const accepted = await acquireEnvironmentTools(input)
          if (!accepted.persistent)
            await fs.rm(accepted.directory, { recursive: true })
          throw new Error(`Accepted corrupt tools: ${name}`)
        } catch (error) {
          if (error.message.startsWith('Accepted corrupt tools:')) throw error
          results[name] = error.message
        }
      }
      await fs.writeFile(input.manifest, '{}')
      await refuse('manifest')
      await fs.writeFile(input.manifest, manifest)
      const native = JSON.parse(manifest).artifacts.find(
        (row) => row.name === toolsName,
      )
      const archive = path.join(directory, native.name)
      await fs.writeFile(archive, 'x')
      await refuse('size')
      await fs.truncate(archive, native.size)
      await refuse('digest')
      return results
    },
    {
      root,
      tools: channel.tools,
      manifest: toolsBytes.toString('utf8'),
      toolsName,
    },
  )
  assert.match(integrity.manifest, /checksum mismatch/)
  assert.match(integrity.size, /size mismatch/)
  assert.match(integrity.digest, /checksum mismatch/)
  await writeFile(
    join(root, 'refusals.json'),
    JSON.stringify(
      { channels: Object.keys(refusedChannels), integrity },
      null,
      2,
    ),
  )
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
  const generation = join(projectRoot, 'builds', number)
  const record = JSON.parse(
    await readFile(join(generation, 'build.json'), 'utf8'),
  )
  const settings = JSON.parse(
    await readFile(join(projectRoot, 'environment.json'), 'utf8'),
  )
  assert.equal(settings.channel, 'stable')
  const readiness = await manager.evaluate(
    (root) => window.dinksterProjects.sandbox(root),
    projectRoot,
  )
  assert.equal(readiness.format, 'dinkster.sandbox-readiness/1')
  assert.equal(typeof readiness.available, 'boolean')
  assert(readiness.detail)
  await writeFile(
    join(root, 'sandbox-readiness.json'),
    JSON.stringify(readiness, null, 2),
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
import importlib.metadata as metadata, json, subprocess, sys
from pathlib import Path
from packaging.version import Version
from packaging.specifiers import SpecifierSet
from dinkster import __version__
from dinkster_workers import load_manifest
from dinkster_workers.pack_wheel import pack_manifest_path
root = Path(sys.argv[1])
packages = {name: metadata.version(name) for name in ('dinkster', 'dinkster-engine', 'dinkster-inference', 'dinkster-frontend')}
assert __version__ == packages['dinkster'] == packages['dinkster-engine']
assert Version(packages['dinkster']) >= Version('0.0.4')
assert Version(packages['dinkster-inference']) >= Version('0.1.2')
assert Version(packages['dinkster-frontend']) >= Version('0.1.0')
lock = json.loads((root / 'dinkster.lock').read_text())
minimums = json.loads(sys.argv[2])
packs = {entry['pack']: entry['version'] for entry in lock['packs']}
assert len(packs) == len(lock['packs'])
assert packs.keys() == minimums.keys(), (packs, minimums)
for name, version in packs.items():
    assert Version(version) >= Version(minimums[name]), (name, version, minimums[name])
    manifest = load_manifest(pack_manifest_path(root / 'pack-sources' / name))
    assert manifest.compatibility.version == version, name
    assert SpecifierSet(manifest.compatibility.engine).contains(packages['dinkster-engine'], prereleases=True), name
    dependency_lock = json.loads((root / 'packs' / name / 'pack-lock.json').read_text())
    assert dependency_lock['pack'] == name
    selected = [package['version'] for package in dependency_lock['packages'] if package['name'] == name]
    assert selected == [version], (name, selected, version)
    pack_python = root / 'packs' / name / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    actual = subprocess.check_output([str(pack_python), '-I', '-c', 'import importlib.metadata as m, sys; print(m.version(sys.argv[1]))', name], text=True).strip()
    assert actual == version, (name, actual, version)
print(json.dumps({'python': sys.executable, 'packages': packages, 'packs': packs, 'sourceLock': lock}))
`,
        generation,
        JSON.stringify(manifest.defaultPacks),
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
  toolsPython = join(
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
  assert(
    mirrorRequests.includes(`/${location}`),
    'engine manifest must pass through the configured mirror',
  )
  assert(
    mirrorRequests.some(
      (path) => path.startsWith('/base/') && path.includes('base.tar.zst.'),
    ),
    'native Base must pass through the configured mirror',
  )
  assert(
    mirrorRequests.includes(`${toolsPath}/tools-manifest.json`),
    'tools manifest must pass through the configured mirror with its origin denied',
  )
  assert(
    mirrorRequests.includes(`${toolsPath}/${toolsName}`),
    'native tools must pass through the configured mirror with their origin denied',
  )
  mirrorOnline = false
  const offlineRequests = mirrorRequests.length
  await manager.reload()
  await expect(
    manager.getByRole('button', { name: 'Open main', exact: true }),
  ).toBeVisible({ timeout: 120_000 })
  assert.equal(
    mirrorRequests.length,
    offlineRequests,
    'installed project browsing must not consult the unavailable mirror',
  )
  mirrorOnline = true
  const writer = spawn(
    toolsPython,
    [
      '-I',
      '-c',
      `
import sys, time
from pathlib import Path
from dinkster_supervisor.environment_state import writer_lock
with writer_lock(Path(sys.argv[1])):
    print('writer acquired', flush=True)
    time.sleep(10)
`,
      projectRoot,
    ],
    { env, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const released = once(writer, 'exit')
  const [ready] = await Promise.race([
    once(writer.stdout, 'data'),
    released.then(() => {
      throw new Error(
        'competing writer exited before acquiring the project lock',
      )
    }),
  ])
  assert.equal(ready.toString().trim(), 'writer acquired')
  let engine
  try {
    const opened = app.waitForEvent('window', { timeout: 120_000 })
    await manager
      .getByRole('button', { name: 'Open main', exact: true })
      .click()
    engine = await opened
  } finally {
    const [code] = await released
    assert.equal(code, 0)
  }
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
  await expect(engine.getByText(/loading schemas/i)).toHaveCount(0, {
    timeout: 120_000,
  })
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
  const startRequests = mirrorRequests.slice(offlineRequests)
  assert(
    startRequests.includes('/channels/stable.json'),
    'installed start must select the signed channel tools',
  )
  assert(
    startRequests.every(
      (path) =>
        path === '/channels/stable.json' || path.startsWith(`${toolsPath}/`),
    ),
    'installed start must not reacquire engine or base artifacts',
  )
  mirrorChannel = refusedChannels.wrongChannel
  const nightly = verifyChannel(mirrorChannel, 'nightly')
  const updatedPlan = await manager.evaluate(
    ({ project, request }) => window.dinksterProjects.plan(project, request),
    {
      project,
      request: {
        root: projectRoot,
        operation: 'update',
        channel: 'nightly',
        mirrors: [mirrorUrl],
      },
    },
  )
  assert.equal(updatedPlan.result.status, 'planned')
  assert(updatedPlan.token)
  const updated = await manager.evaluate(
    (token) => window.dinksterProjects.apply(token),
    updatedPlan.token,
  )
  assert.equal(updated.status, 'applied')
  const nextNumber = (
    await readFile(join(projectRoot, 'current'), 'utf8')
  ).trim()
  assert.notEqual(nextNumber, number)
  const nextGeneration = join(projectRoot, 'builds', nextNumber)
  const nextRecord = JSON.parse(
    await readFile(join(nextGeneration, 'build.json'), 'utf8'),
  )
  assert.equal(nextRecord.engine.release, nightly.engine.release)
  const nextPython = join(
    nextGeneration,
    'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3',
  )
  assert.equal(
    execFileSync(
      nextPython,
      [
        '-I',
        '-c',
        'from dinkster import __version__; import importlib.metadata as m; assert __version__ == m.version("dinkster-engine"); print(__version__)',
      ],
      { encoding: 'utf8', env },
    ).trim(),
    nightly.engine.version,
  )
  await expect(engine.getByTestId('graph-canvas')).toBeVisible({
    timeout: 120_000,
  })
  await engine.screenshot({
    path: join(root, 'nightly-project.png'),
    fullPage: true,
  })
  mirrorOnline = false
  const recoveryRequests = mirrorRequests.length
  const rollbackPlan = await manager.evaluate(
    ({ project, request }) => window.dinksterProjects.plan(project, request),
    {
      project: { ...project, channel: 'nightly' },
      request: { root: projectRoot, operation: 'rollback' },
    },
  )
  assert.equal(rollbackPlan.result.status, 'planned')
  assert(rollbackPlan.token)
  const rolledBack = await manager.evaluate(
    (token) => window.dinksterProjects.apply(token),
    rollbackPlan.token,
  )
  assert.equal(rolledBack.status, 'applied')
  const recoveredNumber = (
    await readFile(join(projectRoot, 'current'), 'utf8')
  ).trim()
  assert.notEqual(recoveredNumber, nextNumber)
  assert.notEqual(recoveredNumber, number)
  const recovered = JSON.parse(
    await readFile(
      join(projectRoot, 'builds', recoveredNumber, 'build.json'),
      'utf8',
    ),
  )
  assert.deepEqual(recovered.engine, record.engine)
  assert.equal(recovered.base, record.base)
  await writeFile(
    join(root, 'recovered-generation.json'),
    JSON.stringify(
      { previous: number, updated: nextNumber, recovered },
      null,
      2,
    ),
  )
  assert.equal(
    mirrorRequests.length,
    recoveryRequests,
    'rollback must not consult the unavailable mirror',
  )
  await expect(engine.getByTestId('graph-canvas')).toBeVisible({
    timeout: 120_000,
  })
  assert(
    (await engine.request.get(new URL('/api/health', engine.url()).href)).ok(),
  )
  await engine.screenshot({
    path: join(root, 'recovered-project.png'),
    fullPage: true,
  })
  await writeFile(
    join(root, 'mirror-recovery.json'),
    JSON.stringify(
      {
        mirrorUrl,
        requests: mirrorRequests,
        updated,
        generation: nextRecord,
        rolledBack,
      },
      null,
      2,
    ),
  )
  await engine.close()
  const stopPlan = await manager.evaluate(
    ({ project, root }) =>
      window.dinksterProjects.plan(project, {
        root,
        operation: 'stop',
        engine: 'main',
      }),
    { project, root: projectRoot },
  )
  assert(stopPlan.token)
  const stopped = await manager.evaluate(
    (token) => window.dinksterProjects.apply(token),
    stopPlan.token,
  )
  assert.equal(stopped.status, 'applied')
  assert.equal(
    stopped.engines.find((engine) => engine.name === 'main').state,
    'stopped',
  )
  await writeFile(join(root, 'stopped.json'), JSON.stringify(stopped, null, 2))
  assert.equal(
    failedMirrorRequests.size,
    0,
    'Every failed upstream mirror request must recover',
  )
} catch (error) {
  if (String(error).includes('another environment writer holds')) {
    const lockPath = join(projectRoot, '.lock')
    const diagnostic = {
      error: String(error),
      capturedAt: new Date().toISOString(),
    }
    try {
      const bytes = await readFile(lockPath)
      const metadata = await stat(lockPath)
      diagnostic.lock = {
        bytes: bytes.subarray(0, 4096).toString('base64'),
        size: metadata.size,
        inode: metadata.ino,
        modifiedAt: metadata.mtime.toISOString(),
      }
    } catch (captureError) {
      diagnostic.lockError = captureError.message
    }
    if (process.platform !== 'win32') {
      try {
        diagnostic.openFiles = execFileSync(
          'lsof',
          ['-Fpcnfl', '--', lockPath],
          {
            encoding: 'utf8',
            timeout: 5000,
          },
        )
      } catch (captureError) {
        diagnostic.openFiles = captureError.stdout?.toString() ?? ''
        diagnostic.holderError = captureError.message
      }
    }
    await writeFile(
      join(root, 'writer-lock-diagnostics.json'),
      JSON.stringify(diagnostic, null, 2),
    )
  }
  if (
    process.platform === 'win32' &&
    toolsPython &&
    String(error).includes('authenticated supervisor did not stop')
  ) {
    try {
      const diagnostic = execFileSync(
        toolsPython,
        [
          '-I',
          '-c',
          `
import hashlib, json, sys, time
from pathlib import Path
root = Path(sys.argv[1])
number = (root / 'project/current').read_text().strip()
record = json.loads((root / 'project/runtime' / number / 'main.json').read_text())
instance = record['instance']
lifecycle = root / 'project/runtime' / number / 'main.process' / hashlib.sha256(instance.encode()).hexdigest()
state = json.loads((lifecycle / 'state.json').read_text())
assert state['instance'] == instance and state['pid'] == record['pid']
if state['state'] != 'running':
    print('Supervisor lifecycle is not running; no attachment attempted')
else:
    output = root / 'supervisor-shutdown.log'
    script = root / 'supervisor-shutdown-diagnostic.py'
    script.write_text(r'''import asyncio, faulthandler, sys
from pathlib import Path
if (__INSTANCE__ in sys.argv
        and Path(sys.argv[0]).name == 'supervisor.py'
        and Path(sys.argv[0]).parent.name == 'dinkster_supervisor'):
    with Path(__OUTPUT__).open('w') as output:
        faulthandler.dump_traceback(file=output, all_threads=True)
        try:
            tasks = asyncio.all_tasks()
        except RuntimeError:
            tasks = ()
        for task in tasks:
            output.write('Async task\\n')
            coroutine = task.get_coro()
            while coroutine is not None:
                frame = getattr(coroutine, 'cr_frame', getattr(coroutine, 'gi_frame', None))
                if frame is not None:
                    output.write(f'{frame.f_code.co_filename}:{frame.f_lineno} {frame.f_code.co_name}\\n')
                coroutine = getattr(coroutine, 'cr_await', getattr(coroutine, 'gi_yieldfrom', None))
'''.replace('__INSTANCE__', repr('--instance=' + instance)).replace('__OUTPUT__', repr(str(output))), encoding='utf-8')
    # A pending request may still read the script, so retain it until runner disposal.
    sys.remote_exec(record['pid'], str(script))
    deadline = time.monotonic() + 5
    while not output.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    print('Shutdown stacks retained' if output.exists() else 'Attachment requested; target did not produce stacks')
`,
          root,
        ],
        { encoding: 'utf8', env, timeout: 10_000 },
      )
      await writeFile(join(root, 'shutdown-diagnostics.log'), diagnostic)
    } catch (diagnosticError) {
      await writeFile(
        join(root, 'shutdown-diagnostics.log'),
        `Shutdown stack capture failed: ${diagnosticError.message}`,
      )
    }
  }
  await manager
    ?.screenshot({ path: join(root, 'failed.png'), fullPage: true })
    .catch(() => undefined)
  if (mirrorFailures.length)
    throw new AggregateError(
      [error, ...mirrorFailures],
      'Stable verification failed after upstream mirror errors',
    )
  throw error
} finally {
  try {
    await app.close()
  } finally {
    mirror.closeAllConnections()
    await new Promise((done) => mirror.close(done))
  }
}
