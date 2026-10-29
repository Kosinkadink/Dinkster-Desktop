import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { availableLoopbackPort, EngineRuntime } from '../dist/engine.js'
import backend from '../src/backend-release.json' with { type: 'json' }

const [directory, archive, aimdo, uv] = process.argv.slice(2)
assert.ok(directory && archive && aimdo && uv,
  'Usage: Electron (ELECTRON_RUN_AS_NODE=1) verify-engine-runtime.mjs NEW_ROOT SOURCE_ZIP AIMDO_WHEEL UV')
const root = resolve(directory)
await mkdir(root, { recursive: false })
const port = await availableLoopbackPort()
const dataDirectory = join(root, 'data')
const runtime = new EngineRuntime({
  dataDirectory,
  sourceArchive: resolve(archive),
  aimdoWheel: resolve(aimdo),
  uvExecutable: resolve(uv),
  variant: 'cpu',
  port,
})
const report = { backend: backend.commit, node: process.version, platform: process.platform, events: [] }
runtime.on('status', (status) => {
  report.events.push({ time: new Date().toISOString(), ...status })
  console.log(JSON.stringify(status))
})
const deadline = setTimeout(() => { void runtime.stop() }, 20 * 60_000)
try {
  await runtime.start()
  assert.equal(runtime.status.phase, 'running')
  const response = await fetch(`http://127.0.0.1:${port}/supervisor/status`, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  })
  assert.equal(response.ok, true)
  assert.equal((await response.json()).state, 'ready')
  const source = join(dataDirectory, 'engine', 'releases', `${backend.commit}-cpu`)
  const python = process.platform === 'win32'
    ? join(source, '.venv', 'Scripts', 'python.exe')
    : join(source, '.venv', 'bin', 'python')
  const { stdout } = await promisify(execFile)(python, ['-c', [
    'import importlib.metadata as m, importlib.util as u, json',
    'assert u.find_spec("dinkster_inference") is not None',
    'print(json.dumps({"inference": m.version("dinkster-inference"), "aimdo": m.version("comfy-aimdo")}))',
  ].join('\n')], { timeout: 60_000, windowsHide: true })
  report.installed = JSON.parse(stdout)
  assert.equal(report.installed.aimdo, backend.desktopWindowsRuntime.aimdo.version)
  report.result = 'PASS'
} catch (error) {
  report.result = 'FAIL'
  report.error = error.stack ?? String(error)
  throw error
} finally {
  clearTimeout(deadline)
  await runtime.stop()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
}
