import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
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
  installations: [],
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
  app
    .process()
    .stderr?.on('data', (bytes) =>
      appendFileSync(join(root, 'desktop-stderr.log'), bytes),
    )
  app
    .process()
    .once('exit', (code, signal) =>
      appendFileSync(
        join(root, 'desktop-stderr.log'),
        `\nDesktop ${selection} exited: ${code}, signal: ${signal}\n`,
      ),
    )
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
        // Process state and lease owners change on every engine start, but must
        // still pass the persisted-services scan above.
        if (
          !name.startsWith('runtime/') &&
          !name.startsWith('dinkster-library/vault/.leases/')
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
  let invalidStderr = ''
  const invalid = spawn(executablePath, [...baseArgs, '--services=invalid'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false,
  })
  invalid.stderr.on('data', (bytes) => {
    invalidStderr += bytes.toString()
    appendFileSync(join(root, 'desktop-stderr.log'), bytes)
  })
  const invalidExited = new Promise((done, reject) => {
    invalid.once('error', reject)
    invalid.once('exit', done)
  })
  try {
    if (process.platform === 'win32') {
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
          Add-Type -AssemblyName UIAutomationClient
          $condition = New-Object System.Windows.Automation.AndCondition(
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Error')),
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$env:DINKSTER_INVALID_PID))
          )
          $deadline = (Get-Date).AddSeconds(20)
          do {
            $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
            if ($null -eq $dialog) { Start-Sleep -Milliseconds 100 }
          } while ($null -eq $dialog -and (Get-Date) -lt $deadline)
          if ($null -eq $dialog) {
            $pidCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$env:DINKSTER_INVALID_PID)
            $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCondition)
            $names = ($windows | ForEach-Object { $_.Current.Name }) -join ', '
            throw "Invalid services error dialog did not appear; process windows: $names"
          }
          $elements = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
          $text = ($elements | ForEach-Object { $_.Current.Name }) -join ' '
          if ($text -notmatch 'Invalid hosted services') { throw 'Error did not name the invalid services option' }
          if ($text -notmatch 'production or qa') { throw 'Error did not name both allowed values' }
          $dialog.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
        `,
        ],
        {
          env: { ...env, DINKSTER_INVALID_PID: String(invalid.pid) },
          timeout: 30_000,
        },
      )
    }
    assert.equal(
      await Promise.race([
        invalidExited,
        new Promise((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Invalid services launch did not exit')),
            30_000,
          )
          timeout.unref()
        }),
      ]),
      1,
    )
    if (process.platform !== 'win32') {
      assert.match(invalidStderr, /Invalid hosted services/)
      assert.match(invalidStderr, /production or qa/)
    }
    receipt.invalidServicesRefused = true
  } finally {
    appendFileSync(
      join(root, 'desktop-stderr.log'),
      `\nInvalid services process ${invalid.pid}; exit: ${invalid.exitCode}; signal: ${invalid.signalCode}\n`,
    )
    if (invalid.exitCode === null) invalid.kill()
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
        data: join(root, 'store'),
        engine: 'main',
        gpus: [],
      }
      const planned = await manager.evaluate(
        ({ project, request }) =>
          window.dinksterProjects.plan(project, request),
        { project, request },
      )
      assert.equal(planned.result.status, 'planned')
      const applied = await manager.evaluate(
        (token) => window.dinksterProjects.apply(token),
        planned.token,
      )
      assert.equal(applied.status, 'applied')
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
      const status = await promisify(execFile)(
        tools.python,
        [
          '-I',
          '-m',
          'dinkster_supervisor.environment',
          '--root',
          project.root,
          'status',
          '--json',
        ],
        { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      )
      const installed = JSON.parse(status.stdout)
      assert.equal(installed.status, 'clean')
      assert.equal(typeof installed.engine?.version, 'string')
      assert.match(installed.engine.release, /^sha256:[a-f0-9]{64}$/)
      receipt.installations.push({ channel, engine: installed.engine })
      let previous
      for (const selection of ['production', 'qa', 'production']) {
        appendFileSync(
          join(root, 'desktop-stderr.log'),
          `\nStarting ${channel} ${selection}; previous: ${previous ?? 'none'}\n`,
        )
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
        const [, engine] = await Promise.all([
          manager.evaluate(
            (id) => window.dinksterProjects.open(id, 'main'),
            channel,
          ),
          opened,
        ])
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
} catch (error) {
  await writeFile(
    join(root, 'services.json'),
    JSON.stringify({ ...receipt, failure: String(error) }, null, 2),
  )
  throw error
} finally {
  await app?.close()
  await new Promise((done) => fixture.close(done))
}
