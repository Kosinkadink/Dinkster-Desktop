import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron, chromium, expect } from '@playwright/test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceOnly = process.env.DINKSTER_SERVICES_SOURCE_ONLY === '1'
const wsl = process.env.DINKSTER_SERVICES_HOST === 'wsl2'
if (wsl) assert.equal(process.platform, 'win32')
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
  host: wsl ? 'wsl2' : 'native',
  launches: [],
  installations: [],
  engines: [],
}
let app
const runtimeRoots = new Map()

async function retainRuntimeLogs(directory, destination) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const source = join(directory, entry.name)
    const target = join(destination, entry.name)
    if (entry.isDirectory()) await retainRuntimeLogs(source, target)
    else if (entry.isFile() && entry.name.endsWith('.log')) {
      await mkdir(destination, { recursive: true })
      await copyFile(source, target)
    }
  }
}

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
      // The supervisor's .lock is an OS coordination handle, not configuration.
      else if (
        entry.name !== '.lock' &&
        /\.(json|toml|lock)$/.test(entry.name)
      ) {
        const bytes = await readFile(join(path, entry.name))
        assert(
          !/DINKSTER_SERVICES|"services"\s*:|\[QA\]/.test(bytes.toString()),
          `Persisted services in ${name}`,
        )
        // Process state, the engine lock owner and lease owners change on every
        // engine start, but must still pass the persisted-services scan above.
        if (
          !name.startsWith('runtime/') &&
          name !== 'dinkster-library/.engine.lock' &&
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
  let desktopBaseline
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
    for (const [index, page] of app.windows().entries()) {
      const title = await (
        await app.browserWindow(page)
      ).evaluate((window) => window.getTitle())
      await mark(
        page,
        selection,
        title === 'About Dinkster Desktop' ? 'about' : `window-${index}`,
      )
    }
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
    const saved = await configuration(env.DINKSTER_DESKTOP_DATA)
    if (desktopBaseline) {
      assert.deepEqual(
        saved,
        desktopBaseline,
        'A services-only restart changed Desktop configuration',
      )
    } else desktopBaseline = saved
  }
  receipt.desktopConfigurationUnchanged = true
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
    if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)(
        'osascript',
        [
          '-e',
          `
          set invalidPid to (system attribute "DINKSTER_INVALID_PID") as integer
          set screenshotPath to system attribute "DINKSTER_INVALID_SCREENSHOT"
          set deadline to (current date) + 20
          tell application "System Events"
            repeat
              set candidates to application processes whose unix id is invalidPid
              if (count of candidates) is 1 then
                set invalidApp to item 1 of candidates
                if (count of windows of invalidApp) > 0 then exit repeat
              end if
              if (current date) > deadline then error "Invalid services error dialog did not appear"
              delay 0.1
            end repeat
            set errorWindow to window 1 of invalidApp
            set dialogText to ""
            repeat with dialogItem in (entire contents of errorWindow)
              try
                set dialogText to dialogText & " " & (value of dialogItem as text)
              end try
            end repeat
            if dialogText does not contain "Invalid hosted services" then error "Error did not name the invalid services option"
            if dialogText does not contain "production or qa" then error "Error did not name both allowed values"
          end tell
          do shell script "/usr/sbin/screencapture -x " & quoted form of screenshotPath
          tell application "System Events"
            click button "OK" of errorWindow
            return dialogText
          end tell
          `,
        ],
        {
          env: {
            ...env,
            DINKSTER_INVALID_PID: String(invalid.pid),
            DINKSTER_INVALID_SCREENSHOT: join(root, 'invalid-services.png'),
          },
          timeout: 30_000,
        },
      )
      assert.match(stdout, /Invalid hosted services/)
      assert.match(stdout, /production or qa/)
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
    if (process.platform === 'linux') {
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
      let guest
      if (wsl) {
        await manager.evaluate(async () => {
          const status = await window.dinksterProjects.prepareWsl()
          if (!status.ready) throw new Error(status.detail)
        })
        const { WslHost } = await import('../../desktop/dist/wsl.js')
        const pin = JSON.parse(
          await readFile(
            join(
              repository,
              'packages/desktop/src/environment-tools-release.json',
            ),
            'utf8',
          ),
        )
        guest = new WslHost(env.DINKSTER_DESKTOP_DATA, {
          manifest: `https://releases.dinkster.org/tools/${pin.label}/tools-manifest.json`,
          release: `https://releases.dinkster.org/tools/${pin.label}`,
          sha256: pin.manifest.sha256,
        })
        receipt.distribution = guest.distribution
      }
      const project = {
        id: channel,
        name: `${channel} services check`,
        channel,
        root: guest ? guest.projectRoot(channel) : join(root, channel),
        engines: [{ id: 'main', name: 'main', kind: 'local', gpus: [], port }],
      }
      runtimeRoots.set(channel, join(project.root, 'runtime'))
      const request = {
        root: project.root,
        operation: 'setup',
        channel,
        mirrors: ['https://releases.dinkster.org'],
        port,
        variant: wsl
          ? 'linux-cpu'
          : { win32: 'win-cpu', linux: 'linux-cpu', darwin: 'mac-arm64' }[
              process.platform
            ],
        data: guest ? guest.projectRoot('store') : join(root, 'store'),
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
      const tools = guest
        ? undefined
        : await acquireEnvironmentTools({
            ...toolsInput,
            cacheRoot: join(root, 'foreign-tools'),
          })
      async function runTools(args, services = 'production') {
        if (guest) {
          const { wslLinuxPath } = await import('../../desktop/dist/wsl.js')
          return JSON.parse(
            await guest.run(
              [
                '--root',
                wslLinuxPath(guest.distribution, project.root),
                ...args,
              ],
              toolsInput,
              services,
            ),
          )
        }
        const result = await promisify(execFile)(
          tools.python,
          [
            '-I',
            '-m',
            'dinkster_supervisor.environment',
            '--root',
            project.root,
            ...args,
          ],
          {
            env: { ...env, DINKSTER_SERVICES: services },
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        )
        return JSON.parse(result.stdout)
      }
      const installed = await runTools(['status', '--json'])
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
          const result = await runTools(
            [
              'start',
              '--engine',
              'main',
              '--port',
              String(port),
              '--json',
              '--yes',
            ],
            previous,
          )
          assert.equal(result.status, 'applied')
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
        let composition
        await expect
          .poll(
            async () => {
              const response = await engine.request.get(
                new URL('/api/composition', engine.url()).href,
              )
              assert(response.ok())
              composition = await response.json()
              return (
                composition.composing === undefined &&
                Object.keys(composition.packs).length > 0 &&
                Object.values(composition.packs).every(
                  (pack) => pack.state === 'announced',
                )
              )
            },
            { timeout: 120_000 },
          )
          .toBe(true)
        await expect(
          engine.getByText(/loading schemas|composing packs/i),
        ).toHaveCount(0, {
          timeout: 120_000,
        })
        const badge = engine.getByText('QA services', { exact: true })
        if (channel === 'nightly' && selection === 'qa') {
          await expect(badge).toBeVisible()
        } else if (selection === 'production') {
          await expect(badge).toHaveCount(0)
          await expect(
            engine.getByText('Custom services', { exact: true }),
          ).toHaveCount(0)
        }
        await mark(engine, selection, `${channel}-engine`)
        receipt.engines.push({
          channel,
          selection,
          reported: selection,
          restartedFrom: previous ?? null,
          announcedPacks: Object.keys(composition.packs).length,
          qaServicesBadge: await badge.isVisible(),
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
  if (process.platform === 'win32' && !sourceOnly) {
    receipt.primaryShortcuts = []
    for (const selection of ['production', 'qa', 'production']) {
      const probe = createServer()
      await new Promise((done) => probe.listen(0, '127.0.0.1', done))
      const port = probe.address().port
      await new Promise((done) => probe.close(done))
      const argumentsForLaunch = [
        ...baseArgs,
        `--remote-debugging-port=${port}`,
        ...(selection === 'qa' ? ['--services=qa'] : []),
      ]
      const shortcutRun = promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
          $ErrorActionPreference = 'Stop'
          $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DINKSTER_SHORTCUT)
          $shortcut.TargetPath = $env:DINKSTER_SHORTCUT_EXECUTABLE
          $shortcut.Arguments = $env:DINKSTER_SHORTCUT_ARGUMENTS
          $shortcut.Save()
          $process = Start-Process -FilePath $env:DINKSTER_SHORTCUT -PassThru
          $deadline = [DateTime]::UtcNow.AddSeconds(60)
          do {
            $process.Refresh()
            if ($process.HasExited) { throw 'Shortcut launch exited before opening a window' }
            $title = $process.MainWindowTitle
            if ($title) { break }
            Start-Sleep -Milliseconds 100
          } while ([DateTime]::UtcNow -lt $deadline)
          if (-not $title) { throw 'Shortcut launch did not open a titled window' }
          if (-not $process.WaitForExit(120000)) { throw 'Shortcut launch did not shut down' }
          @{ title = $title; exitCode = $process.ExitCode } | ConvertTo-Json -Compress
        `,
        ],
        {
          env: {
            ...env,
            DINKSTER_SERVICES: selection === 'qa' ? 'production' : 'qa',
            DINKSTER_SHORTCUT: join(root, `${selection}-primary.lnk`),
            DINKSTER_SHORTCUT_EXECUTABLE: executablePath,
            DINKSTER_SHORTCUT_ARGUMENTS: argumentsForLaunch
              .map((argument) => `"${argument}"`)
              .join(' '),
          },
          timeout: 180_000,
        },
      ).then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
      let browser
      try {
        await expect
          .poll(
            async () => {
              try {
                return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
              } catch {
                return false
              }
            },
            { timeout: 60_000 },
          )
          .toBe(true)
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        await expect
          .poll(() => browser.contexts()[0]?.pages().length ?? 0)
          .toBeGreaterThan(0)
        const manager = browser.contexts()[0].pages()[0]
        await manager
          .getByRole('heading', { name: 'Projects', exact: true })
          .waitFor()
        await expect
          .poll(() =>
            manager.evaluate(() =>
              getComputedStyle(
                document.querySelector('body > header'),
                '::after',
              ).content.includes('[QA]'),
            ),
          )
          .toBe(selection === 'qa')
        await manager.screenshot({
          path: join(root, `${selection}-shortcut-manager.png`),
          fullPage: true,
        })
      } finally {
        if (browser) {
          for (const page of browser.contexts()[0].pages()) await page.close()
          await browser.close()
        }
      }
      const completed = await shortcutRun
      if (completed.error) throw completed.error
      const observed = JSON.parse(completed.result.stdout)
      assert.equal(observed.exitCode, 0)
      assert.equal(
        observed.title,
        selection === 'qa' ? 'Dinkster Desktop [QA]' : 'Dinkster Desktop',
      )
      receipt.primaryShortcuts.push({ selection, ...observed })
      await configuration(env.DINKSTER_DESKTOP_DATA)
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
  try {
    await app?.close()
  } finally {
    try {
      for (const [channel, directory] of runtimeRoots) {
        await retainRuntimeLogs(directory, join(root, 'runtime-logs', channel))
      }
    } finally {
      await new Promise((done) => fixture.close(done))
    }
  }
}
