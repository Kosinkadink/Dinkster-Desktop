import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

const execute = promisify(execFile)
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const backend = process.env.DINKSTER_BACKEND_ROOT
if (!backend)
  throw new Error('DINKSTER_BACKEND_ROOT must name the backend source checkout')
if (process.platform !== 'linux')
  throw new Error('this fixture uses the Linux CPU publisher')
if (!process.env.DISPLAY)
  throw new Error('Electron requires DISPLAY (or run under xvfb-run)')
const python = join(resolve(backend), '.venv/bin/python')
async function cleanHead(directory) {
  const status = (
    await execute('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: directory,
    })
  ).stdout
  if (status.trim())
    throw new Error(
      `integration requires a clean source checkout: ${directory}`,
    )
  return (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: directory })
  ).stdout.trim()
}
const desktopHead = await cleanHead(desktop)
const backendHead = await cleanHead(backend)
const backendModuleRoot = (
  await execute(python, [
    '-I',
    '-c',
    'import dinkster_supervisor; print(next(iter(dinkster_supervisor.__path__)))',
  ])
).stdout.trim()
assert.equal(
  resolve(backendModuleRoot),
  join(
    resolve(backend),
    'packages/dinkster-supervisor/src/dinkster_supervisor',
  ),
  'backend interpreter must import this source checkout',
)
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-cleanup-electron-'))
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const environment = {
  ...Object.fromEntries(
    [
      'PATH',
      'HOME',
      'DISPLAY',
      'XAUTHORITY',
      'XDG_RUNTIME_DIR',
      'SystemRoot',
      'TEMP',
      'TMP',
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  ),
  XDG_DATA_HOME: join(scratch, 'user-data'),
}
const options = {
  cwd: backend,
  env: environment,
  timeout: 180_000,
  maxBuffer: 4 * 1024 * 1024,
}
await readFile(
  join(
    desktop,
    'packages/desktop/resources/branding/tokens/dinkster-colors.json',
  ),
)
await execute('pnpm', ['--filter', '@dinkster/desktop', 'build'], {
  ...options,
  cwd: desktop,
})
let app
let fixture
const command = async (...args) =>
  JSON.parse(
    (
      await execute(
        python,
        [
          '-I',
          '-m',
          'dinkster_supervisor.environment',
          '--root',
          fixture.root,
          ...args,
          '--json',
        ],
        options,
      )
    ).stdout,
  )
const generations = () =>
  readdir(join(fixture.root, 'generations')).then((rows) => rows.sort())
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
try {
  // The backend fixture refuses an existing output; no live install root is accepted.
  const initialized = await execute(
    python,
    [
      '-c',
      `
import json,socket,sys
from pathlib import Path
from tests.fixtures.environments.build import build
with socket.socket() as listener:
    listener.bind(('127.0.0.1',0))
    port=listener.getsockname()[1]
print(json.dumps(build(Path(sys.argv[1]),'linux-cpu',port)))
`,
      join(scratch, 'fixture'),
    ],
    options,
  )
  fixture = JSON.parse(initialized.stdout)
  await command(
    ...fixture.commands.setup.slice(
      fixture.commands.setup.indexOf('setup'),
      -1,
    ),
  )
  await command('cleanup', '--automatic', 'off', '--yes')
  await writeFile(
    join(fixture.mirror, 'channels/main.json'),
    await readFile(fixture.updatedChannel),
  )
  await command('update', '--yes')
  await execute(
    python,
    [
      '-c',
      `
import json,sys
from pathlib import Path
from tests.fixtures.environments.build import executable_release
fixture=json.loads(Path(sys.argv[1]).read_text())
executable_release(Path(fixture['mirror']),json.loads(Path(fixture['baseManifest']).read_text()),'3.0',73)
`,
      join(scratch, 'fixture/fixture.json'),
    ],
    options,
  )
  await command('update', '--yes')
  assert.deepEqual(await generations(), ['1', '2', '3'])
  const protectedFiles = new Map()
  for (const name of await readdir(join(fixture.root, 'history'))) {
    const path = join(fixture.root, 'history', name)
    protectedFiles.set(path, await readFile(path))
  }
  for (const name of ['workflows', 'models', 'outputs', 'mounts']) {
    const directory = join(fixture.root, name)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'sentinel')
    await writeFile(path, `${name} private data`)
    protectedFiles.set(path, await readFile(path))
  }
  const cache = join(fixture.store, 'uv-cache', 'cleanup-sentinel')
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, 'shared cache must survive')
  protectedFiles.set(cache, await readFile(cache))
  protectedFiles.set(
    join(fixture.root, 'project.json'),
    await readFile(join(fixture.root, 'project.json')),
  )
  const before = await command('status')
  const engineBefore = before.engines.find((entry) => entry.name === 'main')
  assert.equal(engineBefore.state, 'ready')
  const runtimeRecord = join(fixture.root, 'runtime', '3', 'main.json')
  protectedFiles.set(runtimeRecord, await readFile(runtimeRecord))
  assert.deepEqual(
    await (await fetch(`${engineBefore.url}/api/health`)).json(),
    { ok: true },
  )
  const data = join(scratch, 'desktop')
  await mkdir(data)
  const bindings = join(data, 'projects.json')
  await writeFile(
    bindings,
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: 'studio',
          name: 'Cleanup integration',
          channel: 'main',
          root: fixture.root,
          engines: [
            {
              id: 'main',
              name: 'main',
              kind: 'local',
              gpus: [],
              port: fixture.port,
            },
          ],
        },
      ],
    }),
  )
  protectedFiles.set(bindings, await readFile(bindings))
  app = await electron.launch({
    executablePath: createRequire(
      join(desktop, 'packages/desktop/package.json'),
    )('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(desktop, 'packages/desktop'),
    ],
    env: {
      ...environment,
      DINKSTER_DESKTOP_DATA: data,
      DINKSTER_TOOLS_PYTHON: python,
    },
  })
  const manager = await app.firstWindow()
  await manager
    .getByRole('button', { name: 'Manage main', exact: true })
    .click()
  await manager.locator('#local-operation').selectOption('status')
  const review = async () => {
    await manager
      .getByRole('button', { name: 'Review environment plan' })
      .click()
    await expect(manager.locator('#plan-panel')).toBeVisible()
    await expect(
      manager.getByRole('button', { name: 'Review environment plan' }),
    ).toBeEnabled()
  }
  const apply = async () => {
    await manager.getByRole('button', { name: 'Confirm and apply' }).click()
    await expect(manager.locator('#message')).toContainText(
      'Cleanup request returned',
    )
    await expect(
      manager.getByRole('button', { name: 'Review environment plan' }),
    ).toBeEnabled()
  }
  await review()
  await expect(manager.locator('#plan')).toContainText(
    'Automatic generation cleanup: off',
  )
  await expect(manager.locator('#plan')).toContainText(
    'Generation 1: candidate',
  )
  await expect(manager.locator('#apply')).toBeHidden()
  assert.deepEqual(await generations(), ['1', '2', '3'])
  if (artifacts)
    await manager
      .locator('#plan-panel')
      .screenshot({ path: join(artifacts, 'electron-cleanup-status.png') })
  await manager.locator('#local-operation').selectOption('cleanup')
  await review()
  await apply()
  await expect(manager.locator('#message')).toContainText('returned disabled')
  assert.deepEqual(await generations(), ['1', '2', '3'])
  await manager.locator('#local-cleanup').selectOption('on')
  await review()
  await apply()
  await expect(manager.locator('#plan')).toContainText(
    'Automatic generation cleanup: on',
  )
  assert.deepEqual(await generations(), ['1', '2', '3'])
  await manager.locator('#local-cleanup').selectOption('keep')
  await manager.locator('#local-keep-previous').fill('2')
  await review()
  await apply()
  assert.equal(
    (await command('status')).cleanup.policy.previousSuccessfulActivations,
    2,
  )
  assert.deepEqual(await generations(), ['1', '2', '3'])
  await manager.locator('#local-keep-previous').fill('')
  await review()
  await apply()
  await expect(manager.locator('#message')).toContainText('returned complete')
  assert.deepEqual(await generations(), ['1', '2', '3'])
  await manager.locator('#local-keep-previous').fill('1')
  await review()
  await apply()
  assert.equal(
    (await command('status')).cleanup.policy.previousSuccessfulActivations,
    1,
  )
  assert.deepEqual(await generations(), ['1', '2', '3'])
  await manager.locator('#local-keep-previous').fill('')
  const holder = spawn(
    python,
    [
      '-I',
      '-c',
      `
import sys
from pathlib import Path
from dinkster_supervisor.environment_state import writer_lock
with writer_lock(Path(sys.argv[1])):
    print('locked',flush=True)
    sys.stdin.read()
`,
      fixture.root,
    ],
    options,
  )
  const released = once(holder, 'exit')
  let locked = ''
  holder.stdout.on('data', (chunk) => {
    locked += chunk.toString()
  })
  try {
    await expect.poll(() => locked.trim()).toBe('locked')
    await review()
    await apply()
    await expect(manager.locator('#message')).toContainText('returned deferred')
    await expect(manager.locator('#plan')).toContainText(
      'another environment writer holds',
    )
    assert.deepEqual(await generations(), ['1', '2', '3'])
    await manager.locator('#local-operation').selectOption('status')
    await review()
    await expect(manager.locator('#plan')).toContainText(
      'Last cleanup attempt: deferred',
    )
    await expect(manager.locator('#plan')).toContainText(
      'another environment writer holds',
    )
    await expect(manager.locator('#apply')).toBeHidden()
    if (artifacts)
      await manager
        .locator('#plan-panel')
        .screenshot({ path: join(artifacts, 'electron-cleanup-deferred.png') })
  } finally {
    holder.stdin.end()
    assert.deepEqual(await released, [0, null])
  }
  await manager.locator('#local-operation').selectOption('cleanup')
  await review()
  assert.deepEqual(await generations(), ['1', '2', '3'])
  await apply()
  await expect(manager.locator('#message')).toContainText('returned complete')
  assert.deepEqual(await generations(), ['2', '3'])
  if (artifacts)
    await manager
      .locator('#plan-panel')
      .screenshot({ path: join(artifacts, 'electron-cleanup-complete.png') })
  await manager.locator('#local-keep-previous').fill('2')
  await review()
  await apply()
  assert.deepEqual(await generations(), ['2', '3'])
  await manager.locator('#local-keep-previous').fill('')
  await manager.locator('#local-cleanup').selectOption('off')
  await review()
  await apply()
  await expect(manager.locator('#plan')).toContainText(
    'Automatic generation cleanup: off',
  )
  await manager.locator('#local-operation').selectOption('status')
  await review()
  await expect(manager.locator('#plan')).toContainText(
    'Automatic generation cleanup: off',
  )
  await expect(manager.locator('#apply')).toBeHidden()
  assert.deepEqual(await generations(), ['2', '3'])
  if (artifacts)
    await manager
      .locator('#plan-panel')
      .screenshot({ path: join(artifacts, 'electron-cleanup-disabled.png') })
  const after = await command('status')
  assert.equal(after.cleanup.policy.automatic, false)
  assert.equal(after.cleanup.policy.previousSuccessfulActivations, 2)
  const engineAfter = after.engines.find((entry) => entry.name === 'main')
  assert.deepEqual(engineAfter, engineBefore)
  assert.deepEqual(
    await (await fetch(`${engineAfter.url}/api/health`)).json(),
    { ok: true },
  )
  for (const [path, bytes] of protectedFiles)
    assert.equal(digest(await readFile(path)), digest(bytes), path)
  assert.equal(
    await cleanHead(desktop),
    desktopHead,
    'Desktop source changed during integration',
  )
  assert.equal(
    await cleanHead(backend),
    backendHead,
    'backend source changed during integration',
  )
  const report = {
    desktopSourceHead: desktopHead,
    backendSourceHead: backendHead,
    provenance: {
      cleanSourceWorktreesBeforeAndAfter: true,
      desktopBuildCommand: 'pnpm --filter @dinkster/desktop build',
      backendModuleRoot,
      limitation:
        'Dependencies and prepared branding assets are not attested; this is source-checkout integration, not packaged-release verification.',
    },
    fixture: scratch,
    collected: [1],
    retained: [2, 3],
    protectedFiles: protectedFiles.size,
    engineUnchanged: engineAfter,
    checks: [
      'status read-only',
      'disabled retry preserves backlog',
      'enable does not collect',
      'Desktop count persists in backend policy and retains two previous generations',
      'lower count takes effect only on next collection',
      'raising count does not recreate already collected generations',
      'busy writer defers with persistent read-only warning',
      'plan does not collect',
      'confirmed retry collects',
      'Desktop opt-out persists in backend status',
      'history/user data/bindings/cache unchanged',
      'current engine remains ready and responsive',
    ],
  }
  if (artifacts)
    await writeFile(
      join(artifacts, 'electron-cleanup-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    )
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app?.close()
  if (fixture) await command('stop', '--yes')
  console.log(
    `Disposable fixture retained at ${scratch}; explicit stop is teardown only.`,
  )
}
