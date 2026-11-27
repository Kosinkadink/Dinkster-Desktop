import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
import { verifyChannel } from '../../desktop/src/channel-signatures.ts'
import { forwardMirror } from './forward-mirror.mjs'

assert.equal(
  process.env.RUNNER_ENVIRONMENT,
  'github-hosted',
  'Fresh install proof requires a disposable hosted runner',
)
assert(process.env.DINKSTER_DESKTOP_EXECUTABLE)
assert(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
const executablePath = resolve(process.env.DINKSTER_DESKTOP_EXECUTABLE)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
const homeUrl = 'http://127.0.0.1:3638'
async function homeStopped() {
  try {
    await fetch(`${homeUrl}/supervisor/status`, {
      signal: AbortSignal.timeout(2000),
    })
    return false
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return true
    if (error.cause?.code === 'ECONNRESET') return false
    throw error
  }
}
assert.equal(
  await homeStopped(),
  true,
  'Leave an existing Home on port 3638 alone',
)
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
const toolsManifest = JSON.parse(toolsBytes)
assert.equal(toolsManifest.commit, manifest.commit)
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
const home = join(root, 'home')
await mkdir(home)
await mkdir(join(root, 'temporary'))
await writeFile(
  join(home, 'model-settings.json'),
  JSON.stringify({ version: 1, downloadLocation: null, locations: [] }),
)
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
  HOME: home,
  USERPROFILE: home,
  DINKSTER_HOME: home,
  DINKSTER_DESKTOP_DATA: join(root, 'desktop'),
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'),
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
const installation = join(root, 'project')
let mirrorChannel = channelText
const mirrorRequests = []
const mirrorFailures = []
const mirror = createServer(async (request, response) => {
  mirrorRequests.push(request.url)
  if (request.url === '/channels/stable.json') {
    response.setHeader('Content-Type', 'application/json')
    response.end(mirrorChannel)
  } else if (request.url === '/tools-manifest.json') response.end(toolsBytes)
  else if (request.url === `/${toolsName}`) response.end(toolsArchive)
  else {
    try {
      await forwardMirror(`${publicRoot}${request.url}`, response)
    } catch (error) {
      mirrorFailures.push(error.diagnostic)
    }
  }
})
await new Promise((done) => mirror.listen(0, '127.0.0.1', done))
const mirrorUrl = `http://127.0.0.1:${mirror.address().port}`
let app
let page
const receipt = { channel, manifest, mirrorUrl, mirrorRequests, mirrorFailures }
async function quit() {
  const closed = app.waitForEvent('close')
  await app
    .evaluate(({ Menu }) => {
      Menu.getApplicationMenu()
        .items[0].submenu.items.find((item) => item.label === 'Quit')
        .click()
    })
    .catch(() => undefined)
  await closed
  app = undefined
  await expect.poll(homeStopped, { timeout: 30_000 }).toBe(true)
}
try {
  app = await electron.launch({
    executablePath,
    args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`],
    env,
    timeout: 60_000,
  })
  app
    .process()
    .stderr?.on('data', (bytes) =>
      appendFileSync(join(root, 'desktop-stderr.log'), bytes),
    )
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  assert.match(
    await app.evaluate(({ app }) => app.getVersion()),
    /^\d+\.\d+\.\d+$/,
  )
  page = await app.firstWindow({ timeout: 180_000 })
  await expect(page).toHaveURL(
    new RegExp(`^${homeUrl.replaceAll('.', '\\.')}[/?]`),
  )
  await expect(page.locator('.dinkster-window-toolbar-host')).toHaveAttribute(
    'data-desktop-chrome',
    '',
  )
  const status = await page.request.get(`${homeUrl}/supervisor/status`)
  assert.equal(status.status(), 200)
  receipt.home = await status.json()
  assert.equal(receipt.home.role, 'home')
  assert.equal(receipt.home.state, 'stopped')

  const tools = await app.evaluate(
    async ({ app }, { root, input, manifest, toolsName, mirrorUrl }) => {
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
      const corrupt = {
        ...input,
        manifest: path.join(directory, 'tools-manifest.json'),
        release: directory,
      }
      const integrity = {}
      const refuse = async (name) => {
        try {
          await acquireEnvironmentTools(corrupt)
          throw new Error(`Accepted corrupt tools: ${name}`)
        } catch (error) {
          if (error.message.startsWith('Accepted corrupt tools:')) throw error
          integrity[name] = error.message
        }
      }
      await fs.writeFile(corrupt.manifest, '{}')
      await refuse('manifest')
      await fs.writeFile(corrupt.manifest, manifest)
      const native = JSON.parse(manifest).artifacts.find(
        (row) => row.name === toolsName,
      )
      const archive = path.join(directory, native.name)
      await fs.writeFile(archive, 'x')
      await refuse('size')
      await fs.truncate(archive, native.size)
      await refuse('digest')
      const original = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        )
        if (url.hostname === 'releases.dinkster.org')
          throw new Error('Official tools origin denied')
        return original(input, options)
      }
      try {
        let refused = false
        try {
          await fetch('https://releases.dinkster.org/tools/denied')
        } catch (error) {
          refused = error.message === 'Official tools origin denied'
        }
        if (!refused) throw new Error('Tools origin was not denied')
        const acquired = await acquireEnvironmentTools({
          ...input,
          mirrorReleases: [mirrorUrl],
          cacheRoot: path.join(root, 'stable-tools'),
        })
        return { ...acquired, integrity, officialOriginDenied: refused }
      } finally {
        globalThis.fetch = original
      }
    },
    {
      root,
      input: channel.tools,
      manifest: toolsBytes.toString('utf8'),
      toolsName,
      mirrorUrl,
    },
  )
  assert.match(tools.integrity.manifest, /checksum mismatch/)
  assert.match(tools.integrity.size, /size mismatch/)
  assert.match(tools.integrity.digest, /checksum mismatch/)
  assert.equal(tools.persistent, true)
  assert(mirrorRequests.includes('/tools-manifest.json'))
  assert(mirrorRequests.includes(`/${toolsName}`))
  receipt.tools = tools
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
  receipt.channelRefusals = {}
  for (const [name, text] of Object.entries({
    ...refusedChannels,
    valid: channelText,
  })) {
    if (name !== 'valid') assert.notEqual(text, channelText)
    mirrorChannel = text
    // The real native CLI must reject metadata before setup can create a root.
    receipt.channelRefusals[name] = await new Promise((resolve, reject) => {
      const child = spawn(
        tools.python,
        [
          '-I',
          '-m',
          'dinkster_supervisor.environment',
          '--root',
          installation,
          'setup',
          '--channel',
          'stable',
          '--mirror',
          mirrorUrl,
          '--variant',
          { win32: 'win-cpu', linux: 'linux-cpu', darwin: 'mac-arm64' }[
            process.platform
          ],
          '--plan',
          '--json',
        ],
        { env, timeout: 120_000 },
      )
      const stdout = []
      const stderr = []
      child.stdout.on('data', (bytes) => stdout.push(bytes))
      child.stderr.on('data', (bytes) => stderr.push(bytes))
      child.once('error', reject)
      child.once('close', (code) => {
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString())
          if (name === 'valid') {
            assert.equal(code, 0, JSON.stringify(result))
            assert.equal(result.status, 'planned')
          } else {
            assert.notEqual(code, 0, `Accepted ${name} channel`)
            assert.match(
              result.error,
              /no mirror supplied a valid trusted channel/,
            )
          }
          resolve({ code, result, stderr: Buffer.concat(stderr).toString() })
        } catch (error) {
          reject(error)
        }
      })
    })
    await assert.rejects(stat(installation), { code: 'ENOENT' })
  }
  const planned = await page.request.get(`${homeUrl}/supervisor/setup`, {
    params: {
      root: installation,
      channel: 'stable',
      variant: { win32: 'win-cpu', linux: 'linux-cpu', darwin: 'mac-arm64' }[
        process.platform
      ],
    },
    timeout: 120_000,
  })
  assert.equal(planned.status(), 200)
  const { plan } = await planned.json()
  assert.equal(plan.refusal, null, JSON.stringify(plan.refusal))
  assert.equal(plan.engineRelease, channel.engine.release)
  receipt.plan = plan
  const started = await page.request.post(`${homeUrl}/supervisor/setup`, {
    data: { planId: plan.id },
  })
  assert.equal(started.status(), 202)
  const job = await started.json()
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `${homeUrl}/supervisor/setup/${job.id}`,
        )
        assert.equal(response.status(), 200)
        receipt.setup = await response.json()
        assert.notEqual(
          receipt.setup.state,
          'failed',
          JSON.stringify(receipt.setup.error),
        )
        return receipt.setup.state
      },
      { timeout: 30 * 60_000 },
    )
    .toBe('completed')
  const number = (await readFile(join(installation, 'current'), 'utf8')).trim()
  assert.match(number, /^[1-9][0-9]*$/)
  const generation = join(installation, 'builds', number)
  const record = JSON.parse(
    await readFile(join(generation, 'build.json'), 'utf8'),
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
      { encoding: 'utf8', env, timeout: 120_000 },
    ),
  )
  assert.equal(installed.packages.dinkster, channel.engine.version)
  assert.equal(installed.packages['dinkster-engine'], channel.engine.version)
  assert.equal(
    installed.packages['dinkster-frontend'],
    (channel.frontend ?? manifest.frontend).version,
  )
  receipt.generation = record
  receipt.installed = installed
  receipt.git = JSON.parse(
    execFileSync(
      tools.python,
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
      { encoding: 'utf8', env, timeout: 120_000 },
    ),
  )
  const installations = await page.request.get(
    `${homeUrl}/supervisor/installations`,
  )
  assert.equal(installations.status(), 200)
  receipt.installations = await installations.json()
  assert(
    receipt.installations.installations.some(
      (row) => row.root === installation,
    ),
  )
  const opened = await page.request.post(`${homeUrl}/supervisor/engine`, {
    data: { root: installation, engine: 'main' },
  })
  assert.equal(opened.status(), 200)
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${homeUrl}/supervisor/status`)
        assert.equal(response.status(), 200)
        receipt.ready = await response.json()
        assert.equal(receipt.ready.open.root, installation)
        assert.notEqual(
          receipt.ready.state,
          'failed',
          JSON.stringify(receipt.ready),
        )
        return receipt.ready.state
      },
      { timeout: 180_000 },
    )
    .toBe('ready')
  assert.equal(typeof receipt.ready.installationFrontend, 'string')
  await page.evaluate((url) => {
    location.href = url
  }, receipt.ready.installationFrontend)
  await expect(page).toHaveURL(new URL(receipt.ready.installationFrontend).href)
  await expect(page.getByTestId('graph-canvas')).toBeVisible({
    timeout: 180_000,
  })
  const health = await page.request.get(new URL('/api/health', page.url()).href)
  assert(health.ok())
  receipt.health = await health.json()
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          new URL('/api/composition', page.url()).href,
        )
        assert(response.ok())
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
  await expect(page.getByText(/loading schemas/i)).toHaveCount(0, {
    timeout: 120_000,
  })
  await page.screenshot({
    path: join(root, 'stable-project.png'),
    fullPage: true,
  })
  const projectUrl = new URL(page.url())
  projectUrl.searchParams.set('dinksterProject', 'default')
  await page.goto(projectUrl.href)
  const backendUrl = projectUrl.origin
  const capabilities = await page.evaluate(
    (url) => window.dinksterDesktop.fileCapabilities(url),
    backendUrl,
  )
  receipt.nativeFiles = { capabilities, dialogs: {} }
  assert.equal(capabilities.nativeFolderChoice, true)
  assert.equal(capabilities.reveal, true)
  const denied = {
    nativeFolderChoice: false,
    reveal: false,
    resolvePath: false,
  }
  receipt.nativeFiles.invalidProjects = []
  await app.evaluate(({ dialog }) => {
    globalThis.originalFolderDialog = dialog.showOpenDialog
    globalThis.invalidFolderRequests = 0
    dialog.showOpenDialog = async () => {
      globalThis.invalidFolderRequests++
      return { canceled: true, filePaths: [] }
    }
  })
  try {
    for (const query of [
      '',
      '?dinksterProject=',
      '?dinksterProject=invalid_project',
      '?dinksterProject=default&dinksterProject=default',
      '?dinksterProject=default&dinksterProject=another-project',
    ]) {
      const invalidUrl = new URL(projectUrl)
      invalidUrl.search = query
      await page.goto(invalidUrl.href)
      const result = await page.evaluate(async (url) => {
        const capabilities = await window.dinksterDesktop.fileCapabilities(url)
        try {
          await window.dinksterDesktop.chooseDirectory(url)
          return { capabilities, accepted: true }
        } catch (error) {
          return { capabilities, error: error.message }
        }
      }, backendUrl)
      assert.deepEqual(result.capabilities, denied)
      assert.equal(result.accepted, undefined)
      assert.equal(typeof result.error, 'string')
      receipt.nativeFiles.invalidProjects.push({ query, ...result })
    }
    assert.equal(await app.evaluate(() => globalThis.invalidFolderRequests), 0)
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.originalFolderDialog
      delete globalThis.originalFolderDialog
      delete globalThis.invalidFolderRequests
    })
  }
  await page.goto(projectUrl.href)
  assert.equal(
    await page.evaluate(
      (url) =>
        window.dinksterDesktop
          .fileCapabilities(url)
          .then((value) => value.nativeFolderChoice),
      backendUrl,
    ),
    true,
  )
  assert.deepEqual(
    await page.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      homeUrl,
    ),
    denied,
  )
  const identity = {
    digest: `blake3:${'a1'.repeat(32)}`,
    scope: 'local',
    project: 'default',
  }
  await assert.rejects(
    page.evaluate(
      ({ url, asset }) => window.dinksterDesktop.revealFile(url, asset),
      { url: backendUrl, asset: identity },
    ),
    /No verified local copy/,
  )
  await assert.rejects(
    page.evaluate(
      ({ url, asset }) => window.dinksterDesktop.revealFile(url, asset),
      { url: backendUrl, asset: { ...identity, project: 'another-project' } },
    ),
    /requesting project/,
  )
  const dropFolder = join(root, 'native-drop')
  const dropPath = join(dropFolder, 'capture.txt')
  const dropContent = 'asymmetric actual native file\n'
  await mkdir(dropFolder)
  await writeFile(dropPath, dropContent)
  const mount = await page.request.post(`${homeUrl}/api/mounts`, {
    data: {
      id: 'native-drop',
      path: dropFolder,
      mode: 'read',
      project: 'default',
      shared: false,
    },
  })
  assert.equal(mount.status(), 200)
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'native-drop'
    document.body.append(input)
  })
  await page.locator('#native-drop').setInputFiles(dropPath)
  const resolveFile = () =>
    page.evaluate(async (url) => {
      try {
        return {
          value: await window.dinksterDesktop.resolveDroppedFile(
            url,
            document.querySelector('#native-drop').files[0],
          ),
        }
      } catch (error) {
        return { error: error.message }
      }
    }, backendUrl)
  const resolved = await resolveFile()
  assert.equal(resolved.value?.status, 'resolved', JSON.stringify(resolved))
  assert.equal(
    resolved.value.asset.digest,
    'blake3:e2c93bfe1d783b866199a510a026b7da32d081996d43207758036de903093992',
  )
  assert.equal(resolved.value.asset.name, 'capture.txt')
  assert.equal(resolved.value.asset.size, Buffer.byteLength(dropContent))
  assert.equal(
    resolved.value.asset.virtualPath,
    'mounts/native-drop/capture.txt',
  )
  const originalExecution = await page.request
    .get(`${homeUrl}/supervisor/status?project=default`)
    .then((response) => {
      assert.equal(response.status(), 200)
      return response.json()
    })
  await app.evaluate(() => {
    globalThis.originalResolverFetch = globalThis.fetch
    globalThis.fetch = async (...args) => {
      if (new URL(String(args[0])).pathname !== '/api/mounts/resolve-path')
        return globalThis.originalResolverFetch(...args)
      globalThis.heldResolverRequest = {
        headers: args[1].headers,
        body: args[1].body,
      }
      await new Promise((done) => {
        globalThis.releaseResolver = done
      })
      const response = await globalThis.originalResolverFetch(...args)
      globalThis.heldResolverResponse = {
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: await response.clone().json(),
      }
      return response
    }
  })
  const heldResolution = resolveFile()
  try {
    await expect
      .poll(() => app.evaluate(() => typeof globalThis.releaseResolver), {
        timeout: 30_000,
      })
      .toBe('function')
    const request = await app.evaluate(() => globalThis.heldResolverRequest)
    assert.deepEqual(
      JSON.parse(request.headers['X-Dinkster-Execution']),
      originalExecution.execution,
    )
    assert.deepEqual(JSON.parse(request.body), {
      path: dropPath,
      project: 'default',
      scope: 'local',
    })
    const changed = await page.request.patch(
      `${homeUrl}/api/projects/default`,
      {
        data: {
          revision: originalExecution.execution.project.revision,
          patch: { name: 'Native file request revision' },
        },
      },
    )
    assert.equal(changed.status(), 200)
    await app.evaluate(() => globalThis.releaseResolver())
    const resolverResult = await heldResolution
    const response = await app.evaluate(() => globalThis.heldResolverResponse)
    assert.equal(response.status, 409)
    assert.equal(response.cacheControl, 'no-store')
    assert.equal(response.body.error, 'execution-binding-mismatch')
    assert.match(
      resolverResult.error,
      /Mounted file resolution failed; no upload fallback was authorized/,
    )
    receipt.nativeFiles.resolver = {
      resolved,
      request,
      response,
      result: resolverResult,
      original: originalExecution.execution,
      changedProject: await changed.json(),
    }
  } finally {
    await app.evaluate(() => {
      globalThis.fetch = globalThis.originalResolverFetch
      globalThis.releaseResolver?.()
    })
    await heldResolution
    await app.evaluate(() => {
      delete globalThis.originalResolverFetch
      delete globalThis.releaseResolver
      delete globalThis.heldResolverRequest
      delete globalThis.heldResolverResponse
    })
  }
  assert.deepEqual(await resolveFile(), resolved)
  for (const change of [
    'none',
    'restart',
    'project',
    'project-return',
    'stop',
  ]) {
    await app.evaluate(({ dialog }) => {
      globalThis.originalFolderDialog = dialog.showOpenDialog
      globalThis.folderDialogEntered = false
      dialog.showOpenDialog = () =>
        new Promise((done) => {
          globalThis.finishFolderDialog = done
          globalThis.folderDialogEntered = true
        })
    })
    const chosen = page.evaluate(async (url) => {
      try {
        return { path: await window.dinksterDesktop.chooseDirectory(url) }
      } catch (error) {
        return { error: error.message }
      }
    }, backendUrl)
    try {
      await expect
        .poll(() => app.evaluate(() => globalThis.folderDialogEntered), {
          timeout: 30_000,
        })
        .toBe(true)
      if (change === 'restart' || change === 'stop') {
        const response = await page.request.post(
          `${homeUrl}/supervisor/engine/${change}`,
          { data: {}, timeout: 300_000 },
        )
        assert.equal(response.status(), 200)
        if (change === 'restart') {
          await expect
            .poll(
              async () => {
                const status = await page.request.get(
                  `${homeUrl}/supervisor/status`,
                )
                assert.equal(status.status(), 200)
                return (await status.json()).state
              },
              { timeout: 180_000 },
            )
            .toBe('ready')
        } else {
          assert.equal((await response.json()).state, 'stopped')
        }
      }
      if (change === 'project' || change === 'project-return') {
        const navigated = page.waitForEvent('framenavigated', {
          timeout: 30_000,
        })
        await page.evaluate(() =>
          history.replaceState(null, '', '?dinksterProject=another-project'),
        )
        await navigated
        if (change === 'project-return') {
          const returned = page.waitForEvent('framenavigated', {
            timeout: 30_000,
          })
          await page.evaluate(
            (url) => history.replaceState(null, '', url),
            projectUrl.href,
          )
          await returned
          assert.equal(page.url(), projectUrl.href)
        }
      }
    } finally {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = globalThis.originalFolderDialog
        globalThis.finishFolderDialog?.({ canceled: false, filePaths: [path] })
        delete globalThis.finishFolderDialog
        delete globalThis.originalFolderDialog
      }, home)
    }
    const result = await chosen
    receipt.nativeFiles.dialogs[change] = result
    if (change === 'none') assert.deepEqual(result, { path: home })
    else {
      assert.equal(result.path, undefined)
      assert.equal(typeof result.error, 'string')
    }
    if (change === 'project')
      await page.evaluate(
        (url) => history.replaceState(null, '', url),
        projectUrl.href,
      )
    if (change !== 'stop')
      assert.equal(
        await page.evaluate(
          (url) =>
            window.dinksterDesktop
              .fileCapabilities(url)
              .then((value) => value.nativeFolderChoice),
          backendUrl,
        ),
        true,
      )
  }
  assert.deepEqual(
    await page.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      backendUrl,
    ),
    denied,
  )
  receipt.url = page.url()
  receipt.stopped = await page.request
    .get(`${homeUrl}/supervisor/status`)
    .then((response) => response.json())
  assert.equal(receipt.stopped.state, 'stopped')
  await quit()
  receipt.ownedShutdown = true
} catch (error) {
  receipt.error = String(error.stack ?? error)
  await page
    ?.screenshot({ path: join(root, 'failed.png'), fullPage: true })
    .catch(() => undefined)
  throw error
} finally {
  if (app)
    await quit().catch((error) => {
      receipt.stopError = String(error)
      process.exitCode = 1
    })
  mirror.closeAllConnections()
  await new Promise((done) => mirror.close(done))
  async function logs(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await logs(path, `${prefix}${entry.name}-`)
      else if (entry.isFile() && entry.name.endsWith('.log'))
        await writeFile(
          join(root, `runtime-${prefix}${entry.name}`),
          await readFile(path),
        )
    }
  }
  await logs(join(installation, 'runtime'))
  await writeFile(
    join(root, 'home.log'),
    await readFile(join(env.DINKSTER_DESKTOP_DATA, 'home.log'), 'utf8').catch(
      () => '',
    ),
  )
  await writeFile(
    join(root, 'installed-generation.json'),
    JSON.stringify(receipt, null, 2),
  )
}
