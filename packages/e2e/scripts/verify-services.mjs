import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron, expect } from '@playwright/test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceOnly = process.env.DINKSTER_SERVICES_SOURCE_ONLY === '1'
if (!sourceOnly)
  assert.equal(
    process.env.RUNNER_ENVIRONMENT,
    'github-hosted',
    'Install proof requires a disposable hosted runner',
  )
assert(
  process.env.DINKSTER_DESKTOP_VERIFY_ROOT,
  'Supply a new owned evidence root',
)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
const executablePath = process.env.DINKSTER_DESKTOP_EXECUTABLE
  ? resolve(process.env.DINKSTER_DESKTOP_EXECUTABLE)
  : createRequire(join(repository, 'packages/desktop/package.json'))('electron')
const baseArgs = [
  '--no-sandbox',
  `--user-data-dir=${join(root, 'electron')}`,
  ...(process.env.DINKSTER_DESKTOP_EXECUTABLE
    ? []
    : [join(repository, 'packages/desktop')]),
]
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^UV_|^PYTHON|^VIRTUAL_ENV$|^GIT_/i.test(
        name,
      ),
  ),
)
Object.assign(env, {
  DINKSTER_DESKTOP_DATA: join(root, 'data'),
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
  APPDATA: join(root, 'app-data'),
  LOCALAPPDATA: join(root, 'local-app-data'),
})
const fixture = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end(
    '<!doctype html><title>Remote content title</title><style>body{background:#202020;color:#ededed;font:18px sans-serif;margin:24px}</style><h1>Remote engine fixture</h1>',
  )
})
await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`
const receipt = {
  sourceOnly,
  platform: process.platform,
  launches: [],
  engines: [],
}
let app

async function launch(selection) {
  app = await electron.launch({
    executablePath,
    args: [...baseArgs, ...(selection === 'qa' ? ['--services=qa'] : [])],
    env: {
      ...env,
      DINKSTER_SERVICES: selection === 'qa' ? 'production' : 'qa',
    },
    timeout: 60_000,
  })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), !sourceOnly)
  assert.equal(
    await app.evaluate(() => process.env.DINKSTER_SERVICES),
    selection,
  )
  const manager = await app.firstWindow()
  await manager
    .getByRole('heading', { name: 'Projects', exact: true })
    .waitFor()
  return manager
}

async function mark(page, selection, kind) {
  const title =
    selection === 'qa' ? 'Dinkster Desktop [QA]' : 'Dinkster Desktop'
  await expect
    .poll(async () =>
      (await app.browserWindow(page)).evaluate((window) => window.getTitle()),
    )
    .toBe(
      kind === 'about' && selection === 'production'
        ? 'About Dinkster Desktop'
        : title,
    )
  await expect
    .poll(() =>
      page.evaluate(() => {
        const elements = [
          document.body,
          ...document.querySelectorAll(
            'body > header, .topbar > .topbar-group-left',
          ),
        ]
        return (
          elements.some((element) =>
            ['::before', '::after'].some((pseudo) =>
              getComputedStyle(element, pseudo).content.includes('[QA]'),
            ),
          ) || document.body.textContent.includes('Dinkster Desktop [QA]')
        )
      }),
    )
    .toBe(selection === 'qa')
  await page.screenshot({
    path: join(root, `${selection}-${kind}.png`),
    fullPage: true,
  })
}

async function secondInstance(selection) {
  await app.evaluate(({ dialog }) => {
    globalThis.servicesRefusals = []
    dialog.showErrorBox = (title, message) =>
      globalThis.servicesRefusals.push({ title, message })
  })
  const argumentsForLaunch = [
    ...baseArgs,
    ...(selection === 'production' ? ['--services=qa'] : []),
  ]
  // ShellExecute the shortcut too, so Windows proves the documented target
  // arguments instead of testing only an equivalent direct executable call.
  const shortcut = `
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DINKSTER_SHORTCUT)
    $shortcut.TargetPath = $env:DINKSTER_SHORTCUT_EXECUTABLE
    $shortcut.Arguments = $env:DINKSTER_SHORTCUT_ARGUMENTS
    $shortcut.Save()
    Start-Process -FilePath $env:DINKSTER_SHORTCUT -Wait
  `
  const child = spawn(
    process.platform === 'win32' ? 'powershell.exe' : executablePath,
    process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', shortcut]
      : argumentsForLaunch,
    {
      env: {
        ...env,
        DINKSTER_SHORTCUT: join(root, `${selection}-opposite.lnk`),
        DINKSTER_SHORTCUT_EXECUTABLE: executablePath,
        DINKSTER_SHORTCUT_ARGUMENTS: argumentsForLaunch
          .map((argument) => `"${argument}"`)
          .join(' '),
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  const code = await new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Opposite-service second instance did not exit')),
      30_000,
    )
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      done(code)
    })
  })
  assert.equal(code, 0)
  await expect
    .poll(() => app.evaluate(() => globalThis.servicesRefusals.length))
    .toBe(1)
  const refusal = await app.evaluate(() => globalThis.servicesRefusals[0])
  assert.match(
    refusal.message,
    new RegExp(`running Desktop uses ${selection} services`),
  )
  assert.equal(
    await app.evaluate(() => process.env.DINKSTER_SERVICES),
    selection,
  )
}

async function configuration(directory) {
  const files = {}
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (
        [
          'logs',
          'cache',
          'environment-tools',
          'library',
          'stores',
          'store',
          'python',
          'packs',
          'pack-sources',
          'journal',
        ].includes(entry.name)
      )
        continue
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`)
      else if (/\.(json|toml|lock)$/.test(entry.name)) {
        const bytes = await readFile(join(path, entry.name))
        assert(
          !/DINKSTER_SERVICES|"services"\s*:|\[QA\]/.test(bytes.toString()),
          `Persisted services in ${name}`,
        )
        files[name] = createHash('sha256').update(bytes).digest('hex')
      }
    }
  }
  await visit(directory)
  return files
}

try {
  let savedProjects
  for (const selection of ['production', 'qa', 'production']) {
    const manager = await launch(selection)
    await mark(manager, selection, 'manager')
    assert.equal(
      await manager
        .locator('input, select, button, label')
        .filter({ hasText: /services|QA services/i })
        .count(),
      0,
    )
    if (!savedProjects) {
      await manager.evaluate(
        (url) =>
          window.dinksterProjects.save({
            id: 'remote',
            name: 'Remote fixture',
            channel: 'stable',
            engines: [{ id: 'remote', name: 'Remote', kind: 'remote', url }],
          }),
        fixtureUrl,
      )
      savedProjects = await readFile(
        join(env.DINKSTER_DESKTOP_DATA, 'projects.json'),
        'utf8',
      )
    }
    const opened = app.waitForEvent('window')
    await manager.evaluate(() =>
      window.dinksterProjects.open('remote', 'remote'),
    )
    const remote = await opened
    await remote
      .getByRole('heading', { name: 'Remote engine fixture' })
      .waitFor()
    await mark(remote, selection, 'fallback')
    const aboutOpened = app.waitForEvent('window')
    await app.evaluate(async ({ app }, selection) => {
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(`${app.getAppPath()}/package.json`)
      await require(`${app.getAppPath()}/dist/branding.js`).showAbout(selection)
    }, selection)
    await mark(await aboutOpened, selection, 'about')
    await secondInstance(selection)
    await mark(manager, selection, 'manager')
    assert.equal(
      await readFile(join(env.DINKSTER_DESKTOP_DATA, 'projects.json'), 'utf8'),
      savedProjects,
    )
    await configuration(env.DINKSTER_DESKTOP_DATA)
    receipt.launches.push({
      selection,
      inherited: selection === 'qa' ? 'production' : 'qa',
      oppositeInstanceRefused: true,
    })
    await app.close()
    app = undefined
  }
  // The checkout path creates the managed workspace/window family even when
  // provisioning fails. This checks chrome, not a real checkout engine.
  for (const selection of ['production', 'qa']) {
    app = await electron.launch({
      executablePath,
      args: [...baseArgs, ...(selection === 'qa' ? ['--services=qa'] : [])],
      env: {
        ...env,
        DINKSTER_DESKTOP_DATA: join(root, `managed-${selection}`),
        DINKSTER_ENGINE_SOURCE: join(root, 'unprovisioned-checkout'),
      },
      timeout: 60_000,
    })
    const primary = await app.firstWindow()
    await primary.waitForFunction(
      () => typeof window.dinksterDesktop?.openPanelWindow === 'function',
    )
    await mark(primary, selection, 'workspace')
    for (const [kind, method, args] of [
      ['workflow', 'openWorkflowWindow', ['services-window-check']],
      ['panel', 'openPanelWindow', ['outputs', 'rail']],
      ['additional-workspace', 'openProjectWindow', ['default']],
    ]) {
      const opened = app.waitForEvent('window')
      await primary.evaluate(
        ({ method, args }) => window.dinksterDesktop[method](...args),
        { method, args },
      )
      await mark(await opened, selection, kind)
    }
    await app.close()
    app = undefined
  }
  if (!sourceOnly) {
    for (const channel of ['stable', 'nightly']) {
      const portProbe = createServer()
      await new Promise((done) => portProbe.listen(0, '127.0.0.1', done))
      const port = portProbe.address().port
      await new Promise((done) => portProbe.close(done))
      const manager = await launch('production')
      const project = {
        id: channel,
        name: `${channel} services check`,
        channel,
        root: join(root, channel),
        engines: [{ id: 'main', name: 'main', kind: 'local', gpus: [], port }],
      }
      const request = {
        root: project.root,
        operation: 'setup',
        channel,
        mirrors: ['https://releases.dinkster.org'],
        port,
        variant: process.platform === 'win32' ? 'win-cpu' : 'linux-cpu',
        data: join(root, `${channel}-store`),
        engine: 'main',
        gpus: [],
      }
      const planned = await manager.evaluate(
        ({ project, request }) =>
          window.dinksterProjects.plan(project, request),
        { project, request },
      )
      assert.equal(planned.result.status, 'planned')
      assert.equal(
        (
          await manager.evaluate(
            (token) => window.dinksterProjects.apply(token),
            planned.token,
          )
        ).status,
        'applied',
      )
      await app.close()
      app = undefined
      const baseline = await configuration(project.root)
      const { channelTools } = await import(
        '../../desktop/dist/environment-channel.js'
      )
      const { acquireEnvironmentTools } = await import(
        '../../desktop/dist/environment-tools.js'
      )
      const toolsInput = await channelTools(
        { ...request, operation: 'catalog' },
        JSON.parse(
          await readFile(
            join(repository, 'packages/desktop/package.json'),
            'utf8',
          ),
        ).version,
      )
      assert(toolsInput)
      const tools = await acquireEnvironmentTools({
        ...toolsInput,
        cacheRoot: join(root, 'foreign-tools'),
      })
      let previous
      for (const selection of ['production', 'qa', 'production']) {
        if (previous) {
          const result = await promisify(execFile)(
            tools.python,
            [
              '-I',
              '-m',
              'dinkster_supervisor.environment',
              '--root',
              project.root,
              'start',
              '--engine',
              'main',
              '--port',
              String(port),
              '--json',
              '--yes',
            ],
            {
              env: { ...env, DINKSTER_SERVICES: previous },
              timeout: 120_000,
              maxBuffer: 4 * 1024 * 1024,
            },
          )
          assert.equal(JSON.parse(result.stdout).status, 'applied')
          const foreign = await fetch(
            `http://127.0.0.1:${port}/api/nodes?wire=1`,
          ).then((response) => response.json())
          assert.equal(foreign.dinkster.services.name, previous)
        }
        const manager = await launch(selection)
        const opened = app.waitForEvent('window', { timeout: 120_000 })
        await manager.evaluate(
          (id) => window.dinksterProjects.open(id, 'main'),
          channel,
        )
        const engine = await opened
        await expect(engine.getByTestId('graph-canvas')).toBeVisible({
          timeout: 120_000,
        })
        const header = await engine.request.get(
          new URL('/api/nodes?wire=1', engine.url()).href,
        )
        assert(header.ok())
        assert.equal((await header.json()).dinkster.services.name, selection)
        await mark(engine, selection, `${channel}-engine`)
        receipt.engines.push({
          channel,
          selection,
          reported: selection,
          restartedFrom: previous ?? null,
        })
        previous = selection
        await app.close()
        app = undefined
        assert.deepEqual(
          await configuration(project.root),
          baseline,
          'A services-only restart changed project/generation configuration',
        )
        await configuration(env.DINKSTER_DESKTOP_DATA)
      }
    }
  }
  await writeFile(join(root, 'services.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt))
} finally {
  await app?.close()
  await new Promise((done) => fixture.close(done))
}
