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
const windows = process.platform === 'win32'
if (
  !backend ||
  (!windows && (process.platform !== 'linux' || !process.env.DISPLAY))
)
  throw new Error(
    'Set DINKSTER_BACKEND_ROOT on Windows, or with DISPLAY on Linux',
  )
const python = join(
  resolve(backend),
  windows ? '.venv/Scripts/python.exe' : '.venv/bin/python',
)
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
for (const path of ['tokens/dinkster-colors.json', 'raster/color/32.png'])
  await readFile(join(desktop, 'packages/desktop/resources/branding', path))
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-space-electron-'))
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS ?? scratch
await mkdir(artifacts, { recursive: true })
const environment = {
  ...Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SYSTEMROOT',
      'SystemRoot',
      'COMSPEC',
      'PATHEXT',
      'TEMP',
      'TMP',
      'DISPLAY',
      'XAUTHORITY',
      'XDG_RUNTIME_DIR',
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  ),
  XDG_DATA_HOME: join(scratch, 'user-data'),
  LOCALAPPDATA: join(scratch, 'user-data'),
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
  shell: windows,
})
let fixture
let fixtureStarted = false
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
const snapshot = async (bindings) =>
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
          bindings,
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
print(json.dumps(build(Path(sys.argv[1]),'fixture-cpu',port)))
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
  fixtureStarted = true
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
    const expectedAllocated = Number(
      (
        await execute(
          python,
          [
            '-I',
            '-c',
            `
import os,stat,subprocess,sys
from pathlib import Path
root,store=map(Path,sys.argv[1:])
trees=[root/name for name in ('generations','history','journal','current','project.json','store','cleanup.json','.lock')]
trees=[path for path in trees if path.exists()]
trees.extend(store.iterdir())
generations=root/'generations'
trees.remove(generations)
trees.extend(generations.iterdir())
if sys.platform=='win32':
 import ctypes,struct
 from ctypes import wintypes
 kernel=ctypes.WinDLL('kernel32',use_last_error=True)
 native=ctypes.WinDLL('ntdll')
 kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
 kernel.CreateFileW.restype=wintypes.HANDLE
 kernel.CloseHandle.argtypes=[wintypes.HANDLE]
 kernel.GetVolumeInformationByHandleW.argtypes=[wintypes.HANDLE,wintypes.LPWSTR,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD),ctypes.POINTER(wintypes.DWORD),ctypes.POINTER(wintypes.DWORD),wintypes.LPWSTR,wintypes.DWORD]
 native.NtQueryInformationFile.argtypes=[wintypes.HANDLE,wintypes.LPVOID,wintypes.LPVOID,wintypes.ULONG,ctypes.c_int]
 native.NtQueryInformationFile.restype=wintypes.LONG
 seen=set()
 volumes=set()
 total=0
 for tree in trees:
  for path in [tree,*tree.rglob('*')] if tree.is_dir() else [tree]:
   info=path.lstat()
   assert not path.is_symlink() and not path.is_junction(),path
   identity=(info.st_dev,info.st_ino)
   if identity in seen: continue
   seen.add(identity)
   handle=kernel.CreateFileW(str(path),0x80,7,None,3,0x02200000,None)
   assert handle!=ctypes.c_void_p(-1).value,(path,ctypes.get_last_error())
   try:
    if info.st_dev not in volumes:
     flags=wintypes.DWORD()
     assert kernel.GetVolumeInformationByHandleW(handle,None,0,None,None,ctypes.byref(flags),None,0),(path,ctypes.get_last_error())
     assert not flags.value&0x08000000,'This independent file-allocation oracle cannot deduplicate cloned extents.'
     volumes.add(info.st_dev)
    status=ctypes.create_string_buffer(2*ctypes.sizeof(ctypes.c_void_p))
    standard=ctypes.create_string_buffer(24)
    result=native.NtQueryInformationFile(handle,status,standard,len(standard),5)
    assert result==0,(path,result)
    total+=struct.unpack_from('=q',standard.raw)[0]
   finally: kernel.CloseHandle(handle)
 print(total)
else:
 # Prepare only this newly created fixture before the measured read-only window.
 for tree in trees:
  for path in [tree,*tree.rglob('*')] if tree.is_dir() else [tree]:
   if stat.S_ISREG(path.lstat().st_mode):
    with path.open('rb') as stream: os.fsync(stream.fileno())
 output=subprocess.check_output(['du','-s','--block-size=1','--',*map(str,trees)],text=True)
 print(sum(int(line.split()[0]) for line in output.splitlines()))
`,
            fixture.root,
            fixture.store,
          ],
          options,
        )
      ).stdout.trim(),
    )
    const before = await snapshot(bindings)
    const cli = await command('space')
    assert.equal(cli.space.complete, true, JSON.stringify(cli.space.warnings))
    assert.equal(cli.space.allocatedBytes, expectedAllocated)
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
    await expect(page.locator('#plan')).toContainText(cli.space.scope)
    assert.deepEqual(
      await snapshot(bindings),
      before,
      'report changed project, managed store, user data or Desktop bindings',
    )
    const engineAfter = (await command('status')).engines.find(
      (row) => row.name === 'main',
    )
    assert.deepEqual(engineAfter, engineBefore)
    assert.deepEqual(
      await (await fetch(`${engineAfter.url}/api/health`)).json(),
      { ok: true },
    )
    await page.locator('#plan-panel').screenshot({
      path: join(
        artifacts,
        `electron-space-${automatic ? 'enabled' : 'disabled'}.png`,
      ),
    })
    records.push({
      automatic,
      report: cli.space,
      expectedAllocatedBytes: expectedAllocated,
      allocationOracle: windows
        ? 'NtQueryInformationFile FileStandardInformation, unique file identities'
        : 'GNU du allocated bytes',
      observedPathsUnchanged: Object.keys(before).length,
      engine: engineAfter,
    })
  }
  assert.equal(await cleanHead(desktop), desktopHead)
  assert.equal(await cleanHead(backend), backendHead)
  const report = {
    desktopHead,
    backendHead,
    platform: process.platform,
    moduleRoot,
    scratch,
    records,
    limitation:
      'Source-checkout Electron integration with a disposable published CPU fixture, not a packaged release. Access times are excluded from the filesystem comparison. The Windows allocation oracle assumes a volume without block cloning; successful clone accounting needs separate native evidence.',
  }
  await writeFile(
    join(artifacts, 'electron-space-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app?.close()
  // Teardown follows the final unchanged-state and live-health checks.
  if (fixtureStarted) await command('stop', '--yes')
  console.log(`Disposable fixture retained at ${scratch}`)
}
