import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { EnvironmentClient } from '../../desktop/dist/environment.js'
import { acquireEnvironmentTools } from '../../desktop/dist/environment-tools.js'
import { DesktopLibrary } from '../../desktop/dist/library.js'
import {
  WslHost,
  wslLinuxPath,
  wslWindowsPath,
} from '../../desktop/dist/wsl.js'

assert.equal(process.platform, 'win32', 'Run this bridge check on Windows')
const fixture = process.env.DINKSTER_LIBRARY_FIXTURE
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
assert(fixture && isAbsolute(fixture), 'Set an absolute fixture directory')
assert(
  artifacts && isAbsolute(artifacts),
  'Set an absolute owned evidence directory',
)
const execute = promisify(execFile)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const pin = JSON.parse(
  await readFile(
    join(repository, 'packages/desktop/src/environment-tools-release.json'),
    'utf8',
  ),
)
const tools = {
  label: pin.label,
  sha256: pin.manifest.sha256,
  manifest: `https://releases.dinkster.org/tools/${pin.label}/tools-manifest.json`,
  release: `https://releases.dinkster.org/tools/${pin.label}`,
}
await mkdir(artifacts, { recursive: true })
// Keep the registered disk's backing directory for the commissioning owner's cleanup.
const scratch = await mkdtemp(join(artifacts, 'private-library-'))
const desktop = join(scratch, 'desktop')
const host = new WslHost(desktop, tools)
const client = new EnvironmentClient(
  'dinkster-env',
  [],
  undefined,
  undefined,
  undefined,
  host,
)
const library = new DesktopLibrary(desktop, client)
const run = async (...args) =>
  execute(
    'wsl.exe',
    [
      '--distribution',
      host.distribution,
      '--user',
      'dinkster',
      '--cd',
      '/home/dinkster',
      '--exec',
      '/usr/bin/env',
      '-i',
      'HOME=/home/dinkster',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      ...args,
    ],
    { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
  )
const decode = (output) =>
  output
    .toString(output.includes(0) ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
const initialNames = decode(
  (await execute('wsl.exe', ['--list', '--quiet'], { encoding: 'buffer' }))
    .stdout,
).split(/\r?\n/)
assert(
  !initialNames.includes(host.distribution),
  'Never adopt an existing distribution',
)
const steps = []
let preparationStarted = false
try {
  const initial = await host.status()
  assert.equal(initial.available, true, initial.detail)
  preparationStarted = true
  const ready = await host.prepare()
  assert.equal(ready.ready, true, ready.detail)
  await mkdir(desktop, { recursive: true })
  const storage = host.projectRoot('library-acceptance')
  await mkdir(storage)
  const installation = join(storage, 'installation')
  await cp(fixture, installation, { recursive: true })
  const missing = join(storage, 'missing')
  const unreadable = join(storage, 'unreadable')
  await mkdir(join(unreadable, 'dinkster-library'), { recursive: true })
  await writeFile(
    join(unreadable, 'dinkster-library/records.sqlite'),
    'not a database',
  )
  await writeFile(
    join(desktop, 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: [
        ['local', installation],
        ['missing', missing],
        ['unreadable', unreadable],
      ].map(([id, root]) => ({
        id,
        name: id,
        root,
        channel: 'nightly',
        engines: [{ id: 'main', name: 'Main', kind: 'local', gpus: [] }],
      })),
    }),
  )
  const database = join(installation, 'dinkster-library/library.sqlite')
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const before = digest(await readFile(database))
  const checkProcesses = async (step) => {
    const output = await run('ps', '-eo', 'pid=,comm=')
    const processes = output.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [pid, executable] = line.trim().split(/\s+/)
        return { pid: Number(pid), executable }
      })
    assert(
      !processes.some(({ executable }) =>
        /^python|^dinkster(?:$|-engine)/i.test(executable),
      ),
    )
    steps.push({ step, processes })
  }
  assert.equal((await library.installations()).length, 3)
  assert.deepEqual(
    (await library.projects('local', null)).items.map((row) => row.name),
    ['Beta project', 'Default', 'Zebra project'],
  )
  await checkProcesses('projects')
  for (const [project, count] of [
    ['beta', 3],
    ['default', 1],
  ]) {
    assert.deepEqual(
      new Set(
        (await library.workflows('local', project, null)).items.map(
          (row) => row.name,
        ),
      ),
      new Set(
        Array.from({ length: count }, (_, i) => `${project}-workflow-${i}`),
      ),
    )
    await checkProcesses(`${project}-workflows`)
    assert.deepEqual(
      new Set(
        (await library.assets('local', project, null)).items.map(
          (row) => row.name,
        ),
      ),
      new Set(Array.from({ length: count }, (_, i) => `${project}-${i}.png`)),
    )
    await checkProcesses(`${project}-assets`)
  }
  assert.deepEqual(await library.projects('missing', null), {
    items: [],
    cursor: null,
  })
  await checkProcesses('missing')
  await assert.rejects(library.projects('unreadable', null), {
    message:
      'By the way, these projects and files cannot be shown with the installed tools.',
  })
  await checkProcesses('unreadable')
  assert.equal(digest(await readFile(database)), before)
  assert.deepEqual((await readdir(installation)).sort(), [
    'dinkster-library',
    'project.json',
  ])
  const installed = await acquireEnvironmentTools({
    ...tools,
    platform: 'linux',
    cacheRoot: wslWindowsPath(
      host.distribution,
      `/home/dinkster/tools/${pin.manifest.sha256}`,
    ),
  })
  const harness = join(storage, 'verify-library-cli.py')
  await cp(
    join(repository, 'packages/e2e/scripts/verify-library-cli.py'),
    harness,
  )
  const python = wslLinuxPath(host.distribution, installed.python)
  await run(
    python,
    '-I',
    wslLinuxPath(host.distribution, harness),
    '--tools-python',
    python,
    '--fixture',
    wslLinuxPath(host.distribution, installation),
    '--complete',
    '--evidence',
    wslLinuxPath(host.distribution, join(storage, 'cli')),
  )
  await cp(join(storage, 'cli'), join(artifacts, 'cli'), { recursive: true })
  await checkProcesses('cli-complete')
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify(
      {
        platform: 'win32-private-wsl',
        distribution: host.distribution,
        directory: scratch,
        toolsCommit: pin.commit,
        toolsManifest: pin.manifest.sha256,
        windowsDesktopLaunched: false,
        libraryUnchanged: true,
        steps,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: real Desktop library bridge through private wsl.exe tools; no Windows Desktop or engine launched; all helpers exited; unchanged library',
  )
} finally {
  await client.dispose()
  if (preparationStarted)
    await execute('wsl.exe', ['--terminate', host.distribution])
}
