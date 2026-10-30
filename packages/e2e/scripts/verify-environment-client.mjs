import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

// This exercises Electron's client boundary, not generation assembly. The real
// shared-mirror fixture remains the environment command owner's responsibility.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-desktop-client-'))
const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const servers = []
const locationRequests = []
let app
try {
  for (const heading of ['Original supervisor', 'Updated supervisor']) {
    const server = createServer((request, response) => {
      if (request.url.startsWith('/api/mounts/locations')) {
        locationRequests.push(new URL(request.url, 'http://localhost'))
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            vault: scratch,
            locations: [],
            activeMounts: [],
            mounts: [],
            pendingRemovals: [],
            restartRequired: false,
            resolvePath: false,
          }),
        )
        return
      }
      response.setHeader('Content-Type', 'text/html')
      response.end(
        `<!doctype html><title>${heading}</title><style>body{margin:0;background:#171717;color:#ededed;font:14px system-ui}.topbar{display:flex;align-items:center;justify-content:space-between;background:#202020}button{font:inherit;padding:8px 12px;color:inherit;background:#303030;border:1px solid #555;border-radius:6px}main{padding:24px}</style>
        ${heading === 'Updated supervisor' ? '<header class="topbar"><button id="menu" onclick="this.textContent=\'Menu opened\'">Menu</button><span>Dinkster project</span><button id="settings">Settings</button></header>' : ''}
        <main><h1>${heading}</h1></main>`,
      )
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    servers.push(server)
  }
  const urls = servers.map(
    (server) => `http://127.0.0.1:${server.address().port}`,
  )
  const command = join(scratch, 'environment-command.cjs')
  const calls = join(scratch, 'calls.jsonl')
  await writeFile(
    command,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\n');
const root = args[args.indexOf('--root') + 1];
const operation = args[args.indexOf('--root') + 2];
const planned = args.includes('--plan');
const observed = ${JSON.stringify(join(scratch, 'observed.json'))};
if (operation === 'status') {
  const row = JSON.parse(fs.readFileSync(observed, 'utf8'));
  console.log(JSON.stringify({...row, operation, status:'clean'}));
  process.exit(0);
}
if (operation === 'catalog') {
  const base = 'sha256:' + 'a'.repeat(64);
  console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:'clean',root,current:null,plan:[],channel:'stable',
    variants:[{variant:'linux-cpu',base,downloadBytes:123456789,manifest:{format:'dinkster.base/1',id:base,variant:'linux-cpu',
      platform:{os:'linux',arch:'x86_64'},nvidia:null,parts:[]}}]}));
  process.exit(0);
}
const url = ${JSON.stringify(urls)}[operation === 'update' ? 1 : 0];
const row = {format:'dinkster.environment-result/1',operation,
status:planned ? 'planned' : 'applied',root,current:operation === 'update' ? 2 : 1,
plan:['Reuse the shared wheel store', 'Start a healthy supervisor before switching current'],url,
engines:[{name:'main',generation:operation === 'update' ? 2 : 1,state:operation === 'stop' ? 'stopped' : 'ready',url}]};
if (!planned) fs.writeFileSync(observed, JSON.stringify(row));
console.log(JSON.stringify(row));
`,
    { mode: 0o755 },
  )
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'DISPLAY',
      'XAUTHORITY',
      'XDG_RUNTIME_DIR',
      'SystemRoot',
      'TEMP',
      'TMP',
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  )
  env.DINKSTER_DESKTOP_DATA = join(scratch, 'desktop')
  env.DINKSTER_ENV = command
  app = await electron.launch({
    executablePath:
      process.env.DINKSTER_ELECTRON_EXECUTABLE ??
      createRequire(join(root, 'packages/desktop/package.json'))('electron'),
    args: [
      '--no-sandbox',
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(root, 'packages/desktop'),
    ],
    env,
  })
  const manager = await app.firstWindow()
  await manager.getByText('No projects yet.', { exact: false }).waitFor()
  await expect
    .poll(() =>
      manager
        .locator('header')
        .evaluate((bar) =>
          getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
        ),
    )
    .toBe('drag')
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'projects-default.png'),
      fullPage: true,
    })
  await manager
    .getByText('Manage a local installation', { exact: true })
    .click()
  await manager.locator('#local-name').fill('Local studio')
  await manager.locator('#local-root').fill(join(scratch, 'installation'))
  await manager
    .getByRole('button', { name: 'Inspect hardware and variants' })
    .click()
  await expect(
    manager.locator('#local-variant option[value="linux-cpu"]'),
  ).toHaveCount(1)
  await expect(manager.locator('#local-variant')).toHaveValue('')
  await manager.locator('#local-variant').selectOption('linux-cpu')
  await expect(manager.locator('#hardware-reason')).toContainText(
    'Explicit override: CPU',
  )
  await expect(manager.locator('#hardware-reason')).toContainText(
    '123,456,789 bytes',
  )
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'hardware-cpu-choice.png'),
      fullPage: true,
    })
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).waitFor()
  let history = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.equal(history.length, 2)
  assert.equal(history[0][2], 'catalog')
  assert(!history[0].includes('--plan') && !history[0].includes('--yes'))
  assert(history[1].includes('--plan'))
  assert(!history[1].includes('--yes'))
  assert.equal(history[1][history[1].indexOf('--engine') + 1], 'main')
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'local-plan.png'),
      fullPage: true,
    })
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await manager
    .getByRole('button', { name: 'Open main', exact: true })
    .waitFor()
  const opened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open main', exact: true }).click()
  const engine = await opened
  await engine.getByRole('heading', { name: 'Original supervisor' }).waitFor()
  await expect
    .poll(() =>
      engine
        .locator('body')
        .evaluate((body) => getComputedStyle(body, '::before').content),
    )
    .toBe('"Dinkster Desktop"')
  if (artifacts)
    await engine.screenshot({
      path: join(artifacts, 'chrome-remote-fallback.png'),
    })
  assert.equal(
    await engine.evaluate(() => typeof window.dinksterProjects),
    'undefined',
  )
  assert.deepEqual(
    await engine.evaluate(() => Object.keys(window.dinksterDesktop).sort()),
    ['chooseDirectory', 'fileCapabilities', 'resolveDroppedFile', 'revealFile'],
  )
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      urls[0],
    ),
    { nativeFolderChoice: true, reveal: true, resolvePath: false },
  )
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      urls[1],
    ),
    { nativeFolderChoice: false, reveal: false, resolvePath: false },
  )
  // Sharing the trusted origin does not grant an unrelated window file access.
  const untrusted = await app.evaluate(
    async ({ BrowserWindow, app, dialog }, url) => {
      const child = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}/dist/preload.cjs`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        throw new Error('Untrusted request reached the dialog')
      }
      try {
        await child.loadURL(url)
        return await child.webContents.executeJavaScript(`(async () => {
        const bridge = window.dinksterDesktop
        const errors = []
        for (const action of [
          () => bridge.chooseDirectory(location.origin),
          () => bridge.revealFile(location.origin, '/ungranted'),
        ]) {
          try { await action(); errors.push('accepted') }
          catch (error) { errors.push(error.message) }
        }
        return { capabilities: await bridge.fileCapabilities(location.origin), errors }
      })()`)
      } finally {
        dialog.showOpenDialog = original
        child.destroy()
      }
    },
    urls[0],
  )
  assert.deepEqual(untrusted.capabilities, {
    nativeFolderChoice: false,
    reveal: false,
    resolvePath: false,
  })
  assert.equal(untrusted.errors.length, 2)
  for (const error of untrusted.errors)
    assert.match(error, /untrusted renderer/)
  // A cached window binding is insufficient after the environment loses readiness.
  const observedFile = join(scratch, 'observed.json')
  const observed = JSON.parse(await readFile(observedFile, 'utf8'))
  await writeFile(
    observedFile,
    JSON.stringify({
      ...observed,
      engines: [{ ...observed.engines[0], state: 'failed' }],
    }),
  )
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      urls[0],
    ),
    { nativeFolderChoice: false, reveal: false, resolvePath: false },
  )
  await writeFile(observedFile, JSON.stringify(observed))
  const projectsFile = join(env.DINKSTER_DESKTOP_DATA, 'projects.json')
  const savedProjects = await readFile(projectsFile, 'utf8')
  for (const change of ['none', 'generation', 'binding']) {
    await app.evaluate(({ dialog }) => {
      globalThis.originalFolderDialog = dialog.showOpenDialog
      globalThis.folderDialogEntered = false
      dialog.showOpenDialog = () =>
        new Promise((done) => {
          globalThis.finishFolderDialog = done
          globalThis.folderDialogEntered = true
        })
    })
    const chosen = engine.evaluate(async (url) => {
      try {
        return { path: await window.dinksterDesktop.chooseDirectory(url) }
      } catch (error) {
        return { error: error.message }
      }
    }, urls[0])
    await expect
      .poll(() => app.evaluate(() => globalThis.folderDialogEntered))
      .toBe(true)
    // Revoke authority only after the request reaches the asynchronous dialog.
    if (change === 'generation') {
      await writeFile(
        observedFile,
        JSON.stringify({
          ...observed,
          current: 2,
          engines: [{ ...observed.engines[0], generation: 2 }],
        }),
      )
    }
    if (change === 'binding') {
      await writeFile(
        projectsFile,
        JSON.stringify({ version: 1, projects: [] }),
      )
    }
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = globalThis.originalFolderDialog
      globalThis.finishFolderDialog({ canceled: false, filePaths: [path] })
    }, scratch)
    const result = await chosen
    if (change === 'none') assert.deepEqual(result, { path: scratch })
    if (change === 'generation') {
      assert.match(result.error, /no longer the selected ready generation/)
      assert.equal(result.path, undefined)
    }
    if (change === 'binding') {
      assert.match(result.error, /local project binding changed/)
      assert.equal(result.path, undefined)
    }
    await writeFile(observedFile, JSON.stringify(observed))
    await writeFile(projectsFile, savedProjects)
  }
  await engine.goto(`${urls[0]}/?dinksterProject=p-shared`)
  const identity = {
    digest: `blake3:${'a1'.repeat(32)}`,
    scope: 'local',
    project: 'p-shared',
  }
  const deniedReveal = (asset) =>
    engine.evaluate(
      async ({ url, asset }) => {
        try {
          await window.dinksterDesktop.revealFile(url, asset)
          return 'unexpected success'
        } catch (error) {
          return error.message
        }
      },
      { url: urls[0], asset },
    )
  assert.match(await deniedReveal(identity), /No verified local copy/)
  assert.equal(locationRequests.at(-1).searchParams.get('project'), 'p-shared')
  const requests = locationRequests.length
  assert.match(
    await deniedReveal({ ...identity, project: 'default' }),
    /requesting project/,
  )
  assert.equal(locationRequests.length, requests)
  await engine.evaluate(() =>
    history.replaceState(null, '', '?dinksterProject=p-other'),
  )
  assert.match(await deniedReveal(identity), /No verified local copy/)
  assert.equal(locationRequests.at(-1).searchParams.get('project'), 'p-shared')
  assert.match(
    await deniedReveal({ ...identity, project: 'p-other' }),
    /requesting project/,
  )
  await engine.goto(`${urls[0]}/?dinksterProject=invalid_project`)
  assert.deepEqual(
    await engine.evaluate(
      (url) => window.dinksterDesktop.fileCapabilities(url),
      urls[0],
    ),
    { nativeFolderChoice: false, reveal: false, resolvePath: false },
  )
  await engine.goto(urls[0])
  await manager
    .getByRole('button', { name: 'Manage main', exact: true })
    .click()
  await manager.locator('#local-operation').selectOption('update')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await engine.getByRole('heading', { name: 'Updated supervisor' }).waitFor()
  await expect
    .poll(() =>
      engine
        .locator('.topbar')
        .evaluate((bar) =>
          getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
        ),
    )
    .toBe('drag')
  await expect
    .poll(() =>
      engine
        .locator('#menu')
        .evaluate((button) =>
          getComputedStyle(button).getPropertyValue('-webkit-app-region'),
        ),
    )
    .toBe('no-drag')
  await engine.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(engine.locator('#menu')).toHaveText('Menu opened')
  if (artifacts)
    await engine.screenshot({
      path: join(artifacts, 'chrome-engine-topbar.png'),
    })
  assert.equal(new URL(engine.url()).origin, urls[1])
  await manager
    .getByText('Environment operation completed.', { exact: false })
    .waitFor()
  await manager.locator('#local-operation').selectOption('rollback')
  await manager.getByRole('button', { name: 'Review environment plan' }).click()
  await manager.getByRole('button', { name: 'Confirm and apply' }).click()
  await engine.getByRole('heading', { name: 'Original supervisor' }).waitFor()
  assert.equal(new URL(engine.url()).origin, urls[0])
  await manager
    .getByText('Environment operation completed.', { exact: false })
    .waitFor()
  if (artifacts)
    await manager.screenshot({
      path: join(artifacts, 'local-applied.png'),
      fullPage: true,
    })
  await manager.locator('#name').fill('Remote studio')
  await manager.locator('#url').fill(urls[1])
  await manager.getByRole('button', { name: 'Save remote project' }).click()
  await manager.getByRole('button', { name: 'Open Remote engine' }).waitFor()
  const count = (await readFile(calls, 'utf8')).trim().split('\n').length
  const remoteOpened = app.waitForEvent('window')
  await manager.getByRole('button', { name: 'Open Remote engine' }).click()
  const remote = await remoteOpened
  await remote.getByRole('heading', { name: 'Updated supervisor' }).waitFor()
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, count)
  assert.equal(await remote.evaluate(() => typeof window.require), 'undefined')
  assert.equal(
    await remote.evaluate(() => typeof window.dinksterDesktop),
    'undefined',
  )
  const dataFiles = await readdir(env.DINKSTER_DESKTOP_DATA)
  for (const forbidden of ['generations', 'current', 'store', 'journal'])
    assert(!dataFiles.includes(forbidden))
  // Windows detection is mocked here; the UI and variant rule run unchanged.
  for (const driver of ['524.99', '580.10']) {
    await app.evaluate(
      async ({ ipcMain }, input) => {
        const require = process
          .getBuiltinModule('node:module')
          .createRequire(input.module)
        const { planVariant } = require(input.module)
        ipcMain.removeHandler('desktop:projects-inspect')
        ipcMain.handle('desktop:projects-inspect', (_event, request) => {
          const platform = { os: 'windows', arch: 'x86_64' }
          const manifests = [
            {
              variant: 'win-nvidia',
              platform,
              nvidia: {
                minimumDriver: '580',
                minimumComputeCapability: '7.5',
                maximumExclusiveComputeCapability: null,
              },
            },
            {
              variant: 'win-nvidia-cu126',
              platform,
              nvidia: {
                minimumDriver: '525',
                minimumComputeCapability: '5.0',
                maximumExclusiveComputeCapability: '10.0',
              },
            },
            { variant: 'win-cpu', platform, nvidia: null },
          ]
          const hardware = {
            gpus: [
              {
                id: '0',
                name: 'Display GPU',
                driver: input.driver,
                computeCapability: '6.1',
              },
              {
                id: '1',
                name: 'Compute GPU',
                driver: input.driver,
                computeCapability: '8.9',
              },
            ],
          }
          return {
            hardware,
            plan: planVariant(manifests, hardware, request.gpus, 'win32'),
            result: {
              format: 'dinkster.environment-result/1',
              operation: 'catalog',
              status: 'clean',
              root: request.root,
              current: null,
              plan: [],
              variants: manifests.map((manifest) => ({
                variant: manifest.variant,
                downloadBytes: 123456789,
                manifest,
              })),
            },
          }
        })
      },
      {
        driver,
        module: join(root, 'packages/desktop/dist/hardware.js'),
      },
    )
    await manager.locator('#local-gpus').fill('1')
    await manager
      .getByRole('button', { name: 'Inspect hardware and variants' })
      .click()
    if (driver === '524.99') {
      await expect(manager.locator('#local-variant')).toHaveValue('')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'Requires NVIDIA driver 525',
      )
      await expect(
        manager.locator('#local-variant option[value="win-cpu"]'),
      ).toHaveCount(1)
      if (artifacts)
        await manager
          .locator('#local-settings')
          .screenshot({ path: join(artifacts, 'hardware-old-driver.png') })
      await manager.locator('#local-variant').selectOption('win-cpu')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'Explicit override: CPU',
      )
    } else {
      await expect(manager.locator('#local-variant')).toHaveValue('win-nvidia')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'lowest compute capability 8.9',
      )
      if (artifacts)
        await manager
          .locator('#local-settings')
          .screenshot({ path: join(artifacts, 'hardware-assigned-gpu.png') })
      await manager.locator('#local-variant').selectOption('win-nvidia-cu126')
      await expect(manager.locator('#hardware-reason')).toContainText(
        'Explicit override:',
      )
      if (artifacts)
        await manager
          .locator('#local-settings')
          .screenshot({ path: join(artifacts, 'hardware-override.png') })
    }
  }
  await app.evaluate(({ app: instance }) => {
    instance.quit()
  })
  await expect
    .poll(async () => (await readFile(calls, 'utf8')).includes('"stop"'))
    .toBe(true)
  history = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(
    history.filter((args) => args.includes('--yes')).map((args) => args[2]),
    ['setup', 'start', 'update', 'rollback', 'stop'],
  )
  console.log(
    'Electron client boundary passed: plan/confirm, startup, new-port update, rollback, remote-only routing, identity-checked stop delegation.',
  )
} catch (error) {
  const manager = app?.windows()[0]
  if (manager && !manager.isClosed()) {
    console.error(
      'Project manager status:',
      await manager.locator('#message').textContent(),
    )
    if (artifacts)
      await manager.screenshot({
        path: join(artifacts, 'client-failure.png'),
        fullPage: true,
      })
  }
  throw error
} finally {
  if (app) await app.close().catch(() => {})
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  )
  await rm(scratch, { recursive: true, force: true })
}
