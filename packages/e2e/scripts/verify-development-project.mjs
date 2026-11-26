import assert from 'node:assert/strict'
import { installationManager } from './installation-manager.mjs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron, expect } from '@playwright/test'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const artifacts = process.env.DINKSTER_DEVELOPMENT_ARTIFACTS
if (!artifacts)
  throw new Error(
    'DINKSTER_DEVELOPMENT_ARTIFACTS must name an owned evidence directory',
  )
await mkdir(artifacts, { recursive: true })
const scratch = await mkdtemp(join(resolve(artifacts), 'development-'))
const source = (name) => {
  const value = process.env[name]
  if (!value)
    throw new Error(
      `${name} must name an explicit local folder or HTTPS Git source`,
    )
  return value.startsWith('https://') ? value : resolve(value)
}
const sources = {
  engine: source('DINKSTER_DEVELOPMENT_ENGINE'),
  inference: source('DINKSTER_DEVELOPMENT_INFERENCE'),
  helper: source('DINKSTER_DEVELOPMENT_HELPER'),
  pack: source('DINKSTER_DEVELOPMENT_PACK'),
  frontend: join(root, 'packages/app/dist'),
}
let frontendDev = process.env.DINKSTER_DEVELOPMENT_FRONTEND_DEV
let frontendEdit = process.env.DINKSTER_DEVELOPMENT_FRONTEND_EDIT
const frontendSource = process.env.DINKSTER_DEVELOPMENT_FRONTEND_SOURCE
const frontendGit = process.env.DINKSTER_DEVELOPMENT_FRONTEND_GIT
if ([frontendSource, frontendDev, frontendGit].filter(Boolean).length > 1)
  throw new Error(
    'choose a frontend Git source, owned source or existing dev server',
  )
if (frontendGit && !frontendGit.startsWith('https://'))
  throw new Error('frontend Git selection requires an explicit HTTPS source')
const project = join(scratch, 'project')
const portServer = createServer()
await new Promise((done) => portServer.listen(0, '127.0.0.1', done))
const port = portServer.address().port
await new Promise((done) => portServer.close(done))
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN
env.CUDA_VISIBLE_DEVICES = ''
env.DINKSTER_ACCELERATOR = 'cpu'
env.DINKSTER_DESKTOP_DATA = join(scratch, 'desktop')
env.DINKSTER_HOME = join(scratch, 'home')
await mkdir(env.DINKSTER_HOME)
await writeFile(
  join(env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ version: 1, locations: [], downloadLocation: null }),
)
env.XDG_DATA_HOME = join(scratch, 'user-data')
env.LOCALAPPDATA = join(scratch, 'user-data')
if (process.env.DINKSTER_DEVELOPMENT_TOOLS_PYTHON)
  env.DINKSTER_TOOLS_PYTHON = resolve(
    process.env.DINKSTER_DEVELOPMENT_TOOLS_PYTHON,
  )
let app
let manager
let frontendServer
let originalFrontend
const receipt = {
  platform: process.platform,
  sources,
  project,
  port,
  toolsOverride: env.DINKSTER_TOOLS_PYTHON ?? null,
}
try {
  if (frontendSource) {
    const appRoot = join(resolve(frontendSource), 'packages/app')
    const viteModule = createRequire(join(appRoot, 'package.json')).resolve(
      'vite',
    )
    const { createServer: createViteServer } = await import(
      pathToFileURL(viteModule).href
    )
    process.env.DINKSTER_NATIVE_BACKEND = `http://127.0.0.1:${port}`
    frontendServer = await createViteServer({
      root: appRoot,
      server: { host: '127.0.0.1', port: 0 },
    })
    await frontendServer.listen()
    frontendDev = `http://127.0.0.1:${frontendServer.httpServer.address().port}`
    frontendEdit = join(appRoot, 'index.html')
    receipt.frontendDev = frontendDev
    receipt.frontendSource = resolve(frontendSource)
  }
  app = await electron.launch({
    executablePath:
      process.env.DINKSTER_ELECTRON_EXECUTABLE ??
      createRequire(join(root, 'packages/desktop/package.json'))('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'chromium')}`,
      ...(process.env.DINKSTER_ELECTRON_EXECUTABLE
        ? []
        : [join(root, 'packages/desktop')]),
    ],
    env,
  })
  manager = await installationManager(app)
  await manager.getByText('Advanced settings', { exact: true }).click()
  await manager
    .getByLabel('Environment name', { exact: true })
    .fill('Contributor development')
  await manager.getByLabel('Install location').fill(project)
  await manager
    .getByLabel('Mirrors, in order')
    .fill('https://releases.dinkster.org')
  await manager.getByLabel('Wheel store').fill(join(scratch, 'store'))
  await manager.getByLabel('Supervisor port').fill(String(port))
  await manager.getByLabel('Source kind').selectOption('development')
  for (const [id, value] of Object.entries({
    'development-engine': sources.engine,
    'development-inference': sources.inference,
    'development-helper': sources.helper,
    'development-packs': sources.pack,
    ...(frontendGit
      ? { 'development-frontend-git': frontendGit }
      : frontendDev
        ? { 'development-frontend-dev': frontendDev }
        : { 'development-frontend': sources.frontend }),
  }))
    await manager
      .getByLabel(
        {
          'development-engine': 'Engine source',
          'development-inference': 'dinkster-inference source (optional)',
          'development-helper': 'dinkster-pack-helpers source (optional)',
          'development-packs': 'Pack sources (one per line, optional)',
          'development-frontend': 'Built frontend folder (optional)',
          'development-frontend-git': 'Frontend Git source',
          'development-frontend-dev': 'Frontend dev server',
        }[id],
        { exact: true },
      )
      .fill(value)
  await manager
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  const variant = process.platform === 'win32' ? 'win-cpu' : 'linux-cpu'
  await expect(
    manager
      .getByLabel('Hardware variant')
      .locator(`option[value="${variant}"]`),
  ).toHaveCount(1, { timeout: 120_000 })
  await manager.getByLabel('Hardware variant').selectOption(variant)
  await manager.screenshot({ path: join(scratch, 'development-setup.png') })
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(
    manager.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeVisible({ timeout: 120_000 })
  await manager
    .getByLabel('Reviewed environment details')
    .screenshot({ path: join(scratch, 'development-plan.png') })
  await assert.rejects(readFile(join(project, 'current')), /ENOENT/)
  await manager.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(
    manager.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeHidden()
  await assert.rejects(readFile(join(project, 'current')), /ENOENT/)
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await expect(
    manager.getByRole('button', { name: 'Confirm and apply' }),
  ).toBeVisible({ timeout: 120_000 })
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await manager.waitForFunction(
    () =>
      document
        .querySelector('ul[aria-label="Saved environments"]')
        ?.textContent?.includes('Development - unpublished sources') ||
      document.querySelector('[role="alert"]')?.textContent.trim(),
    null,
    { timeout: 1_200_000 },
  )
  await expect(
    manager
      .getByRole('list', { name: 'Saved environments' })
      .getByText('Development - unpublished sources'),
  ).toBeVisible()
  const generation = join(
    project,
    'builds',
    (await readFile(join(project, 'current'), 'utf8')).trim(),
  )
  receipt.generation = generation
  receipt.selection = JSON.parse(
    await readFile(join(generation, 'development-sources.json'), 'utf8'),
  )
  receipt.selection.sources = receipt.selection.sources.map(
    ({ files, ...row }) => row,
  )
  for (const [kind, value] of [
    ['engine', sources.engine],
    ['library', sources.inference],
    ['library', sources.helper],
    ['pack', sources.pack],
    ...(frontendGit ? [['frontend', frontendGit]] : []),
  ]) {
    if (value.startsWith('https://')) {
      const selected = new URL(value)
      const options = new URLSearchParams(selected.hash.slice(1))
      selected.hash = ''
      assert.equal(selected.search, '')
      const row = receipt.selection.sources.find(
        (entry) =>
          entry.kind === kind &&
          entry.git?.url === selected.href &&
          entry.git.requestedRef === options.get('ref') &&
          entry.git.subdirectory === (options.get('subdirectory') ?? '.'),
      )
      assert(row, `selected Git source missing: ${value}`)
      assert.equal(row.live, false)
      assert.match(row.git.commit, /^[0-9a-f]{40}$/)
      if (/^[0-9a-f]{40}$/.test(options.get('ref') ?? ''))
        assert.equal(row.git.commit, options.get('ref'))
    } else
      assert(
        receipt.selection.sources.some(
          (entry) => entry.kind === kind && resolve(entry.path) === value,
        ),
        `selected local source missing: ${value}`,
      )
  }
  if (frontendDev) assert.equal(receipt.selection.frontendDev, frontendDev)
  else if (!frontendGit)
    assert.equal(resolve(receipt.selection.frontendRoot), sources.frontend)
  const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert(health.ok)
  receipt.health = await health.json()
  assert.equal(receipt.health.ok, true)
  assert.equal(receipt.health.compositionState.failed, 0)
  const nodes = await fetch(`http://127.0.0.1:${port}/api/nodes?wire=1`)
  assert(nodes.ok)
  receipt.services = (await nodes.json()).dinkster?.services
  assert.equal(receipt.services?.name, 'production')
  const python =
    process.platform === 'win32'
      ? join(generation, 'python/python.exe')
      : join(generation, 'python/bin/python3')
  const imported = await execute(
    python,
    [
      '-I',
      '-c',
      'import json,dinkster,dinkster_inference.conds,dinkster_pack_helpers; print(json.dumps({"engine":dinkster.__file__,"inference":dinkster_inference.conds.__file__,"helper":dinkster_pack_helpers.__file__}))',
    ],
    { env },
  )
  receipt.imports = JSON.parse(imported.stdout)
  for (const name of ['engine', 'inference', 'helper']) {
    const expected = sources[name].startsWith('https://')
      ? generation
      : sources[name]
    assert(
      resolve(receipt.imports[name]).startsWith(
        expected + (process.platform === 'win32' ? '\\' : '/'),
      ),
      `${name} did not import from its selected source`,
    )
  }
  const opened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const engine = await opened
  const connected = []
  engine.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string' && payload.includes('"type":"connected"'))
        connected.push(new URL(socket.url()).origin)
    })
  })
  await expect(
    engine.locator(
      '[data-desktop-chrome] .dinkster-window-identity-wide [title="Development project - unpublished sources"]',
    ),
  ).toHaveCount(1, { timeout: 120_000 })
  assert.equal(
    await engine.evaluate(() => typeof window.dinksterProjects),
    'undefined',
  )
  assert.deepEqual(
    await engine.evaluate(() => Object.keys(window.dinksterDesktop).sort()),
    [
      'chooseDirectory',
      'fileCapabilities',
      'importFile',
      'resolveDroppedFile',
      'revealFile',
      'revealModelLocation',
      'saveFile',
    ],
  )
  const nativeSource = process.env.DINKSTER_DEVELOPMENT_IMPORT_SOURCE
  if (nativeSource) {
    const file = resolve(nativeSource)
    const size = (await stat(file)).size
    const mediaType = process.env.DINKSTER_DEVELOPMENT_IMPORT_TYPE
    assert(
      mediaType,
      'DINKSTER_DEVELOPMENT_IMPORT_TYPE is required with a source',
    )
    const address = new URL(engine.url())
    const backend = address.origin
    const libraryProject =
      address.searchParams.get('dinksterProject') ?? 'default'
    const capabilities = await engine.evaluate(
      (backend) => window.dinksterDesktop.fileCapabilities(backend),
      backend,
    )
    assert.equal(capabilities.importFile, true)
    await app.evaluate(() => {
      globalThis.developmentImportProof = { requests: 0, bytes: 0 }
      const original = globalThis.fetch
      globalThis.fetch = (url, options) => {
        if (new URL(url).pathname === '/api/mounts/import-file') {
          globalThis.developmentImportProof.requests += 1
          globalThis.developmentImportProof.bytes += Buffer.byteLength(
            options.body,
          )
        }
        return original(url, options)
      }
    })
    const expected = createHash('sha256')
    for await (const chunk of createReadStream(file)) expected.update(chunk)
    const digest = expected.digest('hex')
    await engine.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'development-native-source'
      input.hidden = true
      document.body.append(input)
      for (const method of ['arrayBuffer', 'text']) {
        const original = Blob.prototype[method]
        Blob.prototype[method] = function (...args) {
          if (this.size > 64 * 1024)
            throw new Error('Whole-file page read is forbidden')
          return original.apply(this, args)
        }
      }
      for (const method of [
        'readAsArrayBuffer',
        'readAsText',
        'readAsDataURL',
        'readAsBinaryString',
      ]) {
        const original = FileReader.prototype[method]
        FileReader.prototype[method] = function (blob, ...args) {
          if (blob.size > 64 * 1024)
            throw new Error('Whole-file page read is forbidden')
          return original.call(this, blob, ...args)
        }
      }
    })
    await engine.locator('#development-native-source').setInputFiles(file)
    const result = await engine.evaluate(
      async ({ backend, mediaType }) => {
        const file = document.querySelector('#development-native-source')
          .files[0]
        return window.dinksterDesktop.importFile(backend, file, {
          name: file.name,
          mediaType,
        })
      },
      { backend, mediaType },
    )
    assert.equal(result.status, 'imported')
    assert.equal(result.asset.size, size)
    assert.equal(result.asset.name, basename(file))
    assert.match(result.asset.virtualPath, /^mounts\//)
    const proof = await app.evaluate(() => globalThis.developmentImportProof)
    assert.equal(proof.requests, 1)
    assert.ok(
      proof.bytes < size,
      'Native import must send path metadata, not source bytes',
    )
    const readbackUrl = new URL(
      `/api/assets/${encodeURIComponent(result.asset.digest)}`,
      backend,
    )
    readbackUrl.search = new URLSearchParams({
      scope: 'local',
      project: libraryProject,
    }).toString()
    const readback = await fetch(readbackUrl, {
      signal: AbortSignal.timeout(180_000),
    })
    assert.equal(readback.status, 200)
    const actual = createHash('sha256')
    let copied = 0
    for await (const chunk of readback.body) {
      actual.update(chunk)
      copied += chunk.length
    }
    assert.equal(copied, size)
    assert.equal(actual.digest('hex'), digest)
    receipt.nativeImport = {
      size,
      copied,
      sha256: digest,
      asset: result.asset,
      capabilities,
      importRequests: proof.requests,
      requestBytes: proof.bytes,
    }
  }
  const served = await fetch(`http://127.0.0.1:${port}/`)
  if (frontendDev) {
    assert((await served.text()).includes('/@vite/client'))
    await expect.poll(() => connected.length).toBeGreaterThan(0)
    const engineOrigin = new URL(engine.url()).origin.replace('http:', 'ws:')
    assert(
      connected.includes(engineOrigin),
      'HMR bypassed the Desktop engine gateway',
    )
    receipt.hmrOrigins = connected
    if (frontendEdit) {
      originalFrontend = await readFile(frontendEdit, 'utf8')
      await writeFile(
        frontendEdit,
        originalFrontend.replace(
          '</body>',
          '<script>document.body.dataset.developmentEdit="received"</script></body>',
        ),
      )
      await engine.waitForFunction(
        () => document.body.dataset.developmentEdit === 'received',
      )
      receipt.liveEdit = 'received without manual reload'
    }
  } else if (frontendGit) {
    const installed = await execute(
      python,
      [
        '-I',
        '-c',
        "import importlib.resources as r; import sys; p=r.files('dinkster_frontend').joinpath('static/index.html'); assert p.is_relative_to(sys.prefix); sys.stdout.buffer.write(p.read_bytes())",
      ],
      { env, maxBuffer: 16 * 1024 * 1024 },
    )
    assert.equal(await served.text(), installed.stdout)
    receipt.frontendGit = frontendGit
    receipt.frontendHtml =
      'served bytes match the installed captured Git frontend'
  } else
    assert.equal(
      await served.text(),
      await readFile(join(sources.frontend, 'index.html'), 'utf8'),
    )
  const connection = engine.getByTestId('status-connection')
  await expect(connection).toHaveAttribute('data-state', 'connected', {
    timeout: 120_000,
  })
  const catalogResponse = await engine.request.get(
    new URL('/api/nodes', engine.url()).href,
  )
  assert(catalogResponse.ok())
  const catalog = await catalogResponse.json()
  assert(catalog.nodes && typeof catalog.nodes === 'object')
  const nodeCount = Object.keys(catalog.nodes).length
  assert(nodeCount > 0, 'The managed engine must provide node types')
  await connection.click()
  await expect(
    engine
      .getByTestId('backends-panel')
      .getByText(new RegExp(`, ${nodeCount} node types?$`)),
  ).toBeVisible({ timeout: 120_000 })
  receipt.nodeTypes = nodeCount
  await manager
    .getByRole('list', { name: 'Saved environments' })
    .screenshot({ path: join(scratch, 'development-project-list.png') })
  await engine.screenshot({ path: join(scratch, 'development-engine.png') })
  receipt.status = 'passed'
  console.log(`Real Desktop development project passed: ${scratch}`)
} catch (error) {
  receipt.status = 'failed'
  receipt.error = String(error)
  if (manager && !manager.isClosed()) {
    receipt.visibleText = await manager
      .locator('body')
      .innerText()
      .catch(() => '')
    receipt.message = await manager
      .getByRole('alert')
      .textContent()
      .catch(() => '')
    await manager
      .screenshot({ path: join(scratch, 'failure.png'), fullPage: true })
      .catch(() => {})
    console.error(receipt.message)
    console.error(receipt.visibleText)
  }
  throw error
} finally {
  const passed = receipt.status === 'passed'
  const cleanup = await Promise.allSettled([
    originalFrontend === undefined
      ? Promise.resolve()
      : writeFile(frontendEdit, originalFrontend),
    app?.close(),
    frontendServer?.close(),
  ])
  const errors = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length) {
    receipt.status = 'failed'
    receipt.cleanupErrors = errors.map(String)
  }
  await writeFile(
    join(scratch, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
  if (passed && errors.length)
    throw new AggregateError(errors, 'development acceptance cleanup failed')
}
