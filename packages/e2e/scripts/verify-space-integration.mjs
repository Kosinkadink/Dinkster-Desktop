import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

const execute = promisify(execFile)
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const backend = process.env.DINKSTER_BACKEND_ROOT
if (!backend || process.platform !== 'linux' || !process.env.DISPLAY)
  throw new Error(
    'Set DINKSTER_BACKEND_ROOT and DISPLAY for Linux Electron integration',
  )
const python = join(resolve(backend), '.venv/bin/python')
async function cleanHead(directory) {
  const { stdout } = await execute(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: directory },
  )
  assert.equal(stdout.trim(), '', `source must be clean: ${directory}`)
  return (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: directory })
  ).stdout.trim()
}
const desktopHead = await cleanHead(desktop)
const backendHead = await cleanHead(backend)
const moduleRoot = (
  await execute(python, [
    '-I',
    '-c',
    'import dinkster_supervisor; print(next(iter(dinkster_supervisor.__path__)))',
  ])
).stdout.trim()
assert.equal(
  resolve(moduleRoot),
  join(
    resolve(backend),
    'packages/dinkster-supervisor/src/dinkster_supervisor',
  ),
)
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-space-electron-'))
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS ?? scratch
await mkdir(artifacts, { recursive: true })
const environment = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].flatMap(
      (key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  ),
  XDG_DATA_HOME: join(scratch, 'user-data'),
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
}
const options = {
  cwd: backend,
  env: environment,
  timeout: 180_000,
  maxBuffer: 16 * 1024 * 1024,
}
await execute('pnpm', ['--filter', '@dinkster/desktop', 'build'], {
  ...options,
  cwd: desktop,
})
let fixture
let app
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
const snapshot = async () =>
  JSON.parse(
    (
      await execute(
        python,
        [
          '-I',
          '-c',
          `
import hashlib,json,os,stat,sys
from pathlib import Path
rows={}
for raw in sys.argv[1:]:
 root=Path(raw)
 if not root.exists(): continue
 for path in [root,*sorted(root.rglob('*'))]:
  info=path.lstat()
  row=[info.st_mode,info.st_size,info.st_ino,info.st_nlink,info.st_mtime_ns,info.st_ctime_ns,getattr(info,'st_blocks',None)]
  if stat.S_ISREG(info.st_mode): row.append(hashlib.sha256(path.read_bytes()).hexdigest())
  elif stat.S_ISLNK(info.st_mode): row.append(os.readlink(path))
  rows[str(path)]=row
print(json.dumps(rows,sort_keys=True))
`,
          fixture.root,
          fixture.store,
          join(scratch, 'user-data'),
        ],
        options,
      )
    ).stdout,
  )
const stableReport = ({ observedAt, ...report }) => report
try {
  fixture = JSON.parse(
    (
      await execute(
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
    ).stdout,
  )
  await command(
    ...fixture.commands.setup.slice(
      fixture.commands.setup.indexOf('setup'),
      -1,
    ),
  )
  const data = join(scratch, 'desktop')
  await mkdir(data)
  const project = {
    id: 'studio',
    name: 'Running space integration',
    channel: 'main',
    root: fixture.root,
    engines: [
      { id: 'main', name: 'main', kind: 'local', gpus: [], port: fixture.port },
    ],
  }
  const bindings = join(data, 'projects.json')
  await writeFile(bindings, JSON.stringify({ version: 1, projects: [project] }))
  for (const name of ['models', 'outputs', 'workflows', 'mounts']) {
    await mkdir(join(fixture.root, name), { recursive: true })
    await writeFile(
      join(fixture.root, name, 'sentinel.bin'),
      `${name} excluded private data`,
    )
  }
  const bindingsBefore = await readFile(bindings)
  const engineBefore = (await command('status')).engines.find(
    (row) => row.name === 'main',
  )
  assert.equal(engineBefore.state, 'ready')
  assert.deepEqual(
    await (await fetch(`${engineBefore.url}/api/health`)).json(),
    { ok: true },
  )
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
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Manage main', exact: true }).click()
  await page.locator('#local-operation').selectOption('space')
  const records = []
  for (const automatic of [true, false]) {
    if (!automatic) await command('cleanup', '--automatic', 'off', '--yes')
    const before = await snapshot()
    const cli = await command('space')
    const bridged = await page.evaluate(
      async (project) =>
        window.dinksterProjects.plan(project, {
          root: project.root,
          operation: 'space',
        }),
      project,
    )
    assert.equal(bridged.token, undefined)
    assert.deepEqual(
      stableReport(bridged.result.space),
      stableReport(cli.space),
    )
    assert.equal(cli.space.policy.automatic, automatic)
    await page.getByRole('button', { name: 'Review environment plan' }).click()
    await expect(page.locator('#plan-title')).toHaveText(
      'Managed software disk space',
    )
    await expect(
      page.getByRole('button', { name: 'Review environment plan' }),
    ).toBeEnabled()
    await expect(page.locator('#apply')).toBeHidden()
    const size =
      cli.space.allocatedBytes === null
        ? 'unavailable'
        : `${cli.space.allocatedBytes.toLocaleString('en-US')} bytes`
    await expect(page.locator('#plan')).toContainText(
      `Total allocated (shared files counted once): ${size}`,
    )
    await expect(page.locator('#plan')).toContainText(
      `Automatic generation cleanup: ${automatic ? 'on' : 'off'}`,
    )
    await expect(page.locator('#plan')).toContainText(
      'Models, outputs, workflows and mounts are excluded.',
    )
    assert.deepEqual(
      await snapshot(),
      before,
      'report changed project, managed store or user data',
    )
    assert.deepEqual(
      await readFile(bindings),
      bindingsBefore,
      'report changed Desktop bindings',
    )
    const engineAfter = (await command('status')).engines.find(
      (row) => row.name === 'main',
    )
    assert.deepEqual(engineAfter, engineBefore)
    assert.deepEqual(
      await (await fetch(`${engineAfter.url}/api/health`)).json(),
      { ok: true },
    )
    await page
      .locator('#plan-panel')
      .screenshot({
        path: join(
          artifacts,
          `electron-space-${automatic ? 'enabled' : 'disabled'}.png`,
        ),
      })
    records.push({
      automatic,
      report: cli.space,
      observedPathsUnchanged: Object.keys(before).length,
      engine: engineAfter,
    })
  }
  assert.equal(await cleanHead(desktop), desktopHead)
  assert.equal(await cleanHead(backend), backendHead)
  const report = {
    desktopHead,
    backendHead,
    moduleRoot,
    scratch,
    records,
    limitation:
      'Source-checkout Electron integration with a disposable published CPU fixture; not packaged-release or native Windows proof. Access times are excluded from the filesystem comparison.',
  }
  await writeFile(
    join(artifacts, 'electron-space-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app?.close()
  // Teardown follows the final unchanged-state and live-health checks.
  if (fixture) await command('stop', '--yes')
  console.log(`Disposable fixture retained at ${scratch}`)
}
