import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron as electron } from '@playwright/test'
import backend from '../../desktop/src/backend-release.json' with { type: 'json' }
import { ENGINE_RELEASE } from '../../desktop/src/release.ts'
import { DINKSTER_ADVERTISED_WIRE_VERSIONS, parseDinksterNodes } from '../../core/src/schema/dinkster-wire.ts'

const executablePath = process.env.DINKSTER_DESKTOP_EXECUTABLE
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
const variant = process.env.DINKSTER_ACCELERATOR ?? 'cpu'
assert.ok(['cpu', 'cuda'].includes(variant), 'Installed Windows native verification requires DINKSTER_ACCELERATOR=cpu or cuda')
if (!executablePath || !directory) throw new Error('Set DINKSTER_DESKTOP_EXECUTABLE and a new DINKSTER_DESKTOP_VERIFY_ROOT')
const root = resolve(directory)
await mkdir(root, { recursive: false })
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
  value !== undefined && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_|^PATH$/i.test(name),
))
env.DINKSTER_DESKTOP_DATA = join(root, 'data')
env.DINKSTER_ACCELERATOR = variant
env.UV_PYTHON_INSTALL_DIR = join(root, 'python')
env.UV_PYTHON_PREFERENCE = 'only-managed'
env.UV_CACHE_DIR = join(root, 'cache')
env.UV_NO_CONFIG = '1'
env.GIT_CONFIG_GLOBAL = join(root, 'no-git-config')
env.GIT_CONFIG_NOSYSTEM = '1'
env.GIT_TERMINAL_PROMPT = '0'
env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

const execute = promisify(execFile)
const source = join(root, 'data', 'engine', 'releases', `${backend.commit}-${variant}`)
async function inspectNativeEnvironments() {
  const environments = [{ name: 'host', directory: join(source, '.venv') }]
  const packs = join(root, 'data', 'library', 'venvs', variant)
  for (const artifact of await readdir(packs, { withFileTypes: true })) {
    if (!artifact.isDirectory()) continue
    for (const pack of await readdir(join(packs, artifact.name), { withFileTypes: true })) {
      if (pack.isDirectory()) environments.push({ name: pack.name, directory: join(packs, artifact.name, pack.name) })
    }
  }
  assert.ok(environments.length > 1, 'Default packs must retain isolated environments')
  const results = []
  for (const entry of environments) {
    const { stdout } = await execute(join(entry.directory, 'Scripts', 'python.exe'), ['-c', `
import importlib.metadata as metadata
import importlib.util
import json
result = {}
if importlib.util.find_spec('torch'):
    import torch
    result.update(torch=torch.__version__, cuda=torch.version.cuda)
if importlib.util.find_spec('torchvision'):
    import torchvision
    result['torchvision'] = torchvision.__version__
try:
    result['aimdo'] = metadata.version('comfy-aimdo')
except metadata.PackageNotFoundError:
    pass
else:
    import comfy_aimdo.control
    if ${variant === 'cuda' ? 'True' : 'False'}:
        assert comfy_aimdo.control.init('cuda'), 'Aimdo native library did not load'
print(json.dumps(result))
`], { env, cwd: source, windowsHide: true, timeout: 120_000 })
    const versions = JSON.parse(stdout.trim())
    if (entry.name === 'host') {
      assert.ok(versions.torch, 'Host Torch must import')
      assert.equal(versions.aimdo, backend.aimdo.version)
    }
    if (versions.torch) {
      const expected = variant === 'cuda' ? backend.cudaTorch.version
        : `${backend.cudaTorch.version.split('+')[0]}+cpu`
      assert.equal(versions.torch, expected, `${entry.name} Torch`)
      assert.equal(versions.cuda, variant === 'cuda' ? backend.cudaTorch.cudaVersion : null, `${entry.name} CUDA`)
    }
    if (versions.torchvision) assert.equal(versions.torchvision, `${backend.cudaTorch.torchvisionVersion}+${variant === 'cuda' ? backend.cudaTorch.version.split('+')[1] : 'cpu'}`, `${entry.name} torchvision`)
    if (versions.aimdo) assert.equal(versions.aimdo, backend.aimdo.version, `${entry.name} Aimdo`)
    results.push({ name: entry.name, ...versions })
  }
  assert.ok(results.some((entry) => entry.name !== 'host' && entry.torch), 'Isolated worker Torch must import')
  return results
}

let installedMarker
const markerPath = join(source, '.dinkster-desktop-release.json')
for (const launch of ['first-run', 'restart', 'mismatched-profile']) {
  const mismatched = launch === 'mismatched-profile'
    ? JSON.stringify({ ...JSON.parse(installedMarker), nativeProfile: '0'.repeat(64) }) : undefined
  if (mismatched) await writeFile(markerPath, mismatched)
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${join(root, 'electron')}`], env, timeout: 60_000 })
  let page
  try {
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    const deadline = Date.now() + 20 * 60_000
    let status
    let phase
    while (Date.now() < deadline) {
      status = await page.evaluate(() => window.dinksterDesktop?.status())
      if (status?.phase !== phase) {
        phase = status?.phase
        console.log(`${launch}: ${phase}`)
      }
      if (status?.phase === 'running' || status?.phase === 'failed') break
      await delay(1000)
    }
    if (mismatched) {
      assert.equal(status?.phase, 'failed')
      assert.match(status.error, /different native runtime profile/)
      assert.equal(await readFile(markerPath, 'utf8'), mismatched)
      await page.screenshot({ path: join(root, `${launch}.png`), fullPage: true })
      await writeFile(join(root, `${launch}.json`), JSON.stringify({ status }, null, 2))
      console.log('Verified installed Desktop refuses to mutate a mismatched native profile')
      continue
    }
    assert.equal(status?.phase, 'running', JSON.stringify(status))
    const info = await page.evaluate(() => window.dinksterDesktop.info())
    assert.equal(info.engineCommit, backend.commit)
    assert.equal(info.variant, variant)
    assert.equal(status.variant, variant)
    const marker = await readFile(markerPath, 'utf8')
    assert.equal(JSON.parse(marker).nativeProfile, ENGINE_RELEASE.nativeProfile)
    if (installedMarker !== undefined) assert.equal(marker, installedMarker, 'Restart must preserve the installed native profile')
    installedMarker = marker
    const health = await page.evaluate(async () => {
      const response = await fetch('/supervisor/status')
      return response.json()
    })
    assert.equal(health.state, 'ready')
    const catalog = await page.evaluate(async (versions) => {
      const response = await fetch(`/api/nodes?wire=${versions.join(',')}`)
      if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`)
      return response.json()
    }, DINKSTER_ADVERTISED_WIRE_VERSIONS)
    const parsed = parseDinksterNodes(catalog, DINKSTER_ADVERTISED_WIRE_VERSIONS)
    assert.ok(parsed.schemas.size > 0, 'Installed backend must provide usable nodes')
    assert.deepEqual(parsed.diagnostics.filter((entry) => entry.severity === 'error'), [])
    const nativeEnvironments = await inspectNativeEnvironments()
    await page.screenshot({ path: join(root, `${launch}.png`), fullPage: true })
    await writeFile(join(root, `${launch}.json`), JSON.stringify({ status, info, health, nodes: parsed.schemas.size, schemaWire: catalog.dinkster?.schemaWire, nativeEnvironments }, null, 2))
    console.log(`Verified installed Desktop ${launch}: backend ${info.engineCommit}`)
  } catch (error) {
    await page?.screenshot({ path: join(root, `${launch}-failed.png`), fullPage: true }).catch(() => undefined)
    throw error
  } finally {
    await app.close()
    if (mismatched) await writeFile(markerPath, installedMarker)
  }
}
