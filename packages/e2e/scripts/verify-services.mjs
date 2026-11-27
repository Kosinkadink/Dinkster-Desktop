import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
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
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  DINKSTER_HOME: join(root, 'home'),
  DINKSTER_DESKTOP_DATA: join(root, 'data'),
  DINKSTER_ACCELERATOR: 'cpu',
  CUDA_VISIBLE_DEVICES: '',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
  APPDATA: join(root, 'app-data'),
  LOCALAPPDATA: join(root, 'local-app-data'),
})
await mkdir(env.DINKSTER_HOME)
await writeFile(
  join(env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ version: 1, downloadLocation: null, locations: [] }),
)
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
  'Leave an existing process on port 3638 alone',
)
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

function progress(stage, channel, selection) {
  appendFileSync(
    join(root, 'services-progress.log'),
    `${new Date().toISOString()} ${channel} ${selection ?? '-'} ${stage}\n`,
  )
}

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
  const page = await app.firstWindow({ timeout: 180_000 })
  await expect(page).toHaveURL(
    new RegExp(`^${homeUrl.replaceAll('.', '\\.')}[/?]`),
  )
  await expect(page.locator('.dinkster-window-toolbar-host')).toHaveAttribute(
    'data-desktop-chrome',
    '',
  )
  const status = await fetch(`${homeUrl}/supervisor/status`).then((response) =>
    response.json(),
  )
  assert.equal(status.role, 'home')
  assert.equal(status.state, 'stopped')
  return page
}

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
        // The shared bar marks QA in its identity; the fallback bar and the
        // About page carry it in their title.
        return (
          [
            ...document.querySelectorAll(
              '[data-desktop-chrome] .dinkster-window-identity-wide',
            ),
          ].some((identity) => identity.textContent.includes('[QA]')) ||
          document.body.textContent.includes('Dinkster Desktop [QA]')
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
          'home-tools',
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
        // Process state, node tables, attachment locks and derived mount indexes
        // change on engine start, but must pass the persisted-services scan above.
        if (
          !name.startsWith('runtime/') &&
          !name.startsWith('node-tables/') &&
          name !== 'dinkster-library/.engine.lock' &&
          !/^dinkster-library\/engine-lifetime-[0-9a-f]{32}-[0-9a-f]{32}\.lock$/.test(
            name,
          ) &&
          !/^engine-state\/[^/]+\/\.working-[0-9a-f]{32}\.lock$/.test(name) &&
          !/^dinkster-library\/helper-[0-9a-f-]{36}\.lock$/.test(name) &&
          name !== 'dinkster-library/worker-state/mounts-snapshot.json' &&
          !/^engine-state\/[^/]+\/working-[0-9a-f]{32}\/worker-state\/mounts-snapshot\.json$/.test(
            name,
          ) &&
          !/^dinkster-library\/worker-state\/asset-indexes\/[^/]+\.json$/.test(
            name,
          ) &&
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
  let desktopBaseline
  for (const selection of ['production', 'qa', 'production']) {
    const home = await launch(selection)
    await mark(home, selection, 'home')
    assert.equal(
      await home
        .locator('input, select, button, label')
        .filter({ hasText: /services|QA services/i })
        .count(),
      0,
    )
    assert.deepEqual(
      await home.evaluate(() => ({
        projects: typeof window.dinksterProjects,
        library: typeof window.dinksterLibrary,
      })),
      { projects: 'undefined', library: 'undefined' },
    )
    await assert.rejects(
      stat(join(env.DINKSTER_DESKTOP_DATA, 'projects.json')),
      { code: 'ENOENT' },
    )
    const opened = app.waitForEvent('window')
    await home.evaluate(() =>
      window.dinksterDesktop.openWorkflowWindow('services-check'),
    )
    const workflow = await opened
    await expect(workflow).toHaveURL(/dinksterWorkflow=services-check/)
    await mark(workflow, selection, 'workflow')
    const aboutOpened = app.waitForEvent('window')
    await app.evaluate(async ({ app }, selection) => {
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(`${app.getAppPath()}/package.json`)
      await require(`${app.getAppPath()}/dist/branding.js`).showAbout(selection)
    }, selection)
    const aboutPage = await aboutOpened
    await expect(
      aboutPage.getByRole('heading', {
        name: `Dinkster Desktop${selection === 'qa' ? ' [QA]' : ''}`,
        exact: true,
      }),
    ).toBeVisible()
    const shellVersion = await app.evaluate(({ app }) => app.getVersion())
    await expect(
      aboutPage.getByText(`Version ${shellVersion}`, { exact: true }),
    ).toBeVisible()
    await aboutPage.evaluate(() => document.fonts.ready)
    assert.match(
      await aboutPage
        .getByRole('heading')
        .evaluate((heading) => getComputedStyle(heading).fontFamily),
      /Noto Sans/,
    )
    await mark(aboutPage, selection, 'about')
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
    await mark(home, selection, 'home')
    const workflowClosed = workflow.waitForEvent('close')
    await workflow
      .evaluate(() => window.dinksterDesktop.redockWindow())
      .catch(() => undefined)
    await workflowClosed
    await assert.rejects(
      stat(join(env.DINKSTER_DESKTOP_DATA, 'projects.json')),
      { code: 'ENOENT' },
    )
    await configuration(env.DINKSTER_DESKTOP_DATA)
    receipt.launches.push({
      selection,
      inherited: selection === 'qa' ? 'production' : 'qa',
      oppositeInstanceRefused: true,
    })
    await quit()
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
            set dialogText to (value of every static text of errorWindow) as text
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
  if (!sourceOnly && wsl) {
    const artifacts = join(root, 'wsl')
    const result = await promisify(execFile)(
      process.execPath,
      [join(repository, 'packages/e2e/scripts/verify-wsl-project.mjs')],
      {
        env: {
          ...env,
          DINKSTER_WSL_ARTIFACTS: artifacts,
          DINKSTER_DESKTOP_EXECUTABLE: executablePath,
        },
        timeout: 35 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    await writeFile(join(root, 'wsl-output.log'), result.stdout + result.stderr)
    const entries = await readdir(artifacts)
    assert.equal(entries.length, 1)
    receipt.wsl = JSON.parse(
      await readFile(join(artifacts, entries[0], 'receipt.json'), 'utf8'),
    )
    assert.equal(receipt.wsl.result, 'pass')
  }
  if (!sourceOnly && !wsl) {
    for (const channel of ['stable', 'nightly']) {
      progress('setup started', channel)
      const home = await launch('production')
      const project = {
        channel,
        root: join(root, channel),
      }
      runtimeRoots.set(channel, join(project.root, 'runtime'))
      const request = {
        root: project.root,
        operation: 'setup',
        channel,
        mirrors: ['https://releases.dinkster.org'],
        variant: { win32: 'win-cpu', linux: 'linux-cpu', darwin: 'mac-arm64' }[
          process.platform
        ],
      }
      const planResponse = await home.request.get(
        `${homeUrl}/supervisor/setup`,
        {
          params: { root: project.root, channel, variant: request.variant },
          timeout: 120_000,
        },
      )
      assert.equal(planResponse.status(), 200)
      const { plan } = await planResponse.json()
      assert.equal(plan.refusal, null)
      const started = await home.request.post(`${homeUrl}/supervisor/setup`, {
        data: { planId: plan.id },
      })
      assert.equal(started.status(), 202)
      const job = await started.json()
      await expect
        .poll(
          async () => {
            const response = await home.request.get(
              `${homeUrl}/supervisor/setup/${job.id}`,
            )
            assert.equal(response.status(), 200)
            const current = await response.json()
            assert.notEqual(
              current.state,
              'failed',
              JSON.stringify(current.error),
            )
            return current.state
          },
          { timeout: 30 * 60_000 },
        )
        .toBe('completed')
      progress('setup applied; closing Desktop', channel)
      await quit()
      progress('Desktop closed; reading baseline', channel)
      const baseline = await configuration(project.root)
      progress('baseline read', channel)
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
      const result = await promisify(execFile)(
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
        {
          env,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
      const installed = JSON.parse(result.stdout)
      assert.equal(installed.status, 'clean')
      assert.equal(typeof installed.engine?.version, 'string')
      assert.match(installed.engine.release, /^sha256:[a-f0-9]{64}$/)
      receipt.installations.push({ channel, engine: installed.engine })
      for (const selection of ['production', 'qa', 'production']) {
        progress('launching Desktop', channel, selection)
        const engine = await launch(selection)
        progress('opening engine', channel, selection)
        const opened = await engine.request.post(
          `${homeUrl}/supervisor/engine`,
          {
            data: { root: project.root, engine: 'main' },
          },
        )
        assert.equal(opened.status(), 200)
        let installationFrontend
        await expect
          .poll(
            async () => {
              const response = await engine.request.get(
                `${homeUrl}/supervisor/status`,
              )
              const status = await response.json()
              assert.equal(status.open.root, project.root)
              assert.notEqual(status.state, 'failed', JSON.stringify(status))
              installationFrontend = status.installationFrontend
              return status.state
            },
            { timeout: 120_000 },
          )
          .toBe('ready')
        assert.equal(typeof installationFrontend, 'string')
        await engine.evaluate((url) => {
          location.href = url
        }, installationFrontend)
        await expect(engine).toHaveURL(new URL(installationFrontend).href)
        progress('engine opened; checking canvas', channel, selection)
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
          announcedPacks: Object.keys(composition.packs).length,
          qaServicesBadge: await badge.isVisible(),
        })
        progress('engine verified; closing Desktop', channel, selection)
        await quit()
        progress(
          'Desktop closed; checking environment configuration',
          channel,
          selection,
        )
        assert.deepEqual(
          await configuration(project.root),
          baseline,
          'A services-only restart changed project/generation configuration',
        )
        progress('checking Desktop configuration', channel, selection)
        await configuration(env.DINKSTER_DESKTOP_DATA)
        progress('transition verified', channel, selection)
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
        const home = browser.contexts()[0].pages()[0]
        await expect(home).toHaveURL(
          new RegExp(`^${homeUrl.replaceAll('.', '\\.')}[/?]`),
        )
        await expect
          .poll(() =>
            home.evaluate(() =>
              [
                ...document.querySelectorAll(
                  '[data-desktop-chrome] .dinkster-window-identity-wide',
                ),
              ].some((identity) => identity.textContent.includes('[QA]')),
            ),
          )
          .toBe(selection === 'qa')
        await home.screenshot({
          path: join(root, `${selection}-shortcut-home.png`),
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
    for (const [channel, directory] of runtimeRoots) {
      await retainRuntimeLogs(directory, join(root, 'runtime-logs', channel))
    }
    await copyFile(
      join(env.DINKSTER_DESKTOP_DATA, 'home.log'),
      join(root, 'home.log'),
    ).catch(() => undefined)
  }
}
