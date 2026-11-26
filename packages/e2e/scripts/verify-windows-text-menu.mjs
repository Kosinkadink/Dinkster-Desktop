import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { installationManager } from './installation-manager.mjs'

assert.equal(process.platform, 'win32')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert(
  process.env.DINKSTER_TEXT_MENU_ROOT,
  'Set DINKSTER_TEXT_MENU_ROOT to the retained lane root',
)
const root = resolve(process.env.DINKSTER_TEXT_MENU_ROOT)
assert.equal(
  dirname(repository),
  root,
  'The checkout must be the lane root desktop child',
)
const run = join(root, process.env.DINKSTER_TEXT_MENU_RUN ?? 'run-01')
await mkdir(run)
const scratch = join(run, 'state')
await mkdir(scratch)
const editor = join(repository, 'packages/app/dist')
const requests = []
const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'windows-text-menu-fixture', schemaWire: 1 },
  packs: {},
  nodes: {
    'fixture.text': {
      schemaVersion: 1,
      nodeType: 'fixture.text',
      version: 1,
      displayName: 'Text menu fixture',
      category: 'Fixture',
      idempotent: true,
      interface: [
        {
          role: 'input',
          id: 'text',
          required: true,
          type: { kind: 'concrete', types: ['STRING'] },
          default: 'Windows text menu sample',
          widget: { type: 'STRING', multiline: true },
        },
      ],
    },
  },
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(
    new URL(request.url, 'http://localhost').pathname,
  )
  requests.push({ method: request.method, path })
  if (path === '/api/nodes') {
    response.setHeader('Content-Type', 'application/json')
    return response.end(JSON.stringify(catalog))
  }
  if (path === '/api/account') {
    response.setHeader('Content-Type', 'application/json')
    return response.end(
      JSON.stringify({
        available: false,
        canStartSignIn: false,
        signedIn: false,
        profile: null,
        signIn: { state: 'idle' },
      }),
    )
  }
  if (path.startsWith('/api') || path.startsWith('/ws'))
    return response.writeHead(503).end()
  const file = resolve(editor, `.${path}`)
  for (const candidate of file.startsWith(editor + '/') ||
  file.startsWith(editor + '\\')
    ? [file, join(editor, 'index.html')]
    : [join(editor, 'index.html')]) {
    try {
      const bytes = await readFile(candidate)
      response.setHeader(
        'Content-Type',
        types[extname(candidate)] ?? 'application/octet-stream',
      )
      return response.end(bytes)
    } catch {}
  }
  response.writeHead(404).end()
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}`
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
  HOME: join(scratch, 'home'),
  USERPROFILE: join(scratch, 'home'),
  XDG_DATA_HOME: join(scratch, 'xdg'),
  LOCALAPPDATA: join(scratch, 'local'),
  APPDATA: join(scratch, 'roaming'),
  DINKSTER_HOME: join(scratch, 'home'),
  DINKSTER_DESKTOP_DATA: join(scratch, 'desktop'),
  DINKSTER_ENV: join(scratch, 'no-engine-tools'),
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
  TEMP: join(root, 'tmp'),
  TMP: join(root, 'tmp'),
  TMPDIR: join(root, 'tmp'),
})
await mkdir(env.DINKSTER_HOME)
await writeFile(
  join(env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ locations: [] }),
)
const require = createRequire(join(repository, 'packages/desktop/package.json'))
let app
const results = []
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(repository, 'packages/desktop'),
    ],
    env,
    timeout: 60_000,
  })
  results.push({
    name: 'runtime',
    ...(await app.evaluate(() => ({
      electron: process.versions.electron,
      platform: process.platform,
      pid: process.pid,
    }))),
  })
  const projects = await installationManager(app)
  await projects
    .getByText('Connect a remote environment', { exact: true })
    .click()
  await projects
    .getByLabel('Remote environment name')
    .fill('Windows text menu evidence fixture')
  await projects.getByLabel('Server URL').fill(url)
  await projects.getByRole('button', { name: 'Save remote binding' }).click()
  const opened = app.waitForEvent('window')
  await projects.getByRole('button', { name: 'Open Remote engine' }).click()
  const page = await opened
  await expect(page.locator('.dinkster-window-toolbar-host')).toBeVisible()
  await app.evaluate(({ BrowserWindow, screen }, url) => {
    const editor = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith(url),
    )
    for (const w of BrowserWindow.getAllWindows()) if (w !== editor) w.hide()
    const area = screen.getPrimaryDisplay().workArea
    editor.setBounds({
      x: area.x + 20,
      y: area.y + 20,
      width: Math.min(1280, area.width - 40),
      height: Math.min(850, area.height - 40),
    })
    editor.show()
    editor.focus()
  }, url)
  await page.waitForTimeout(2500)
  const state = () =>
    app.evaluate(({ BrowserWindow }, url) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith(url),
      )
      return {
        handle: w.getNativeWindowHandle().readBigUInt64LE().toString(),
        pid: process.pid,
        bounds: w.getBounds(),
        focused: w.isFocused(),
      }
    }, url)
  const menu = async (
    action = 'Guard',
    index = -1,
    point = { x: -1, y: -1 },
  ) => {
    const w = await state()
    return JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(repository, 'packages/e2e/scripts/native-text-menu.ps1'),
          '-Handle',
          w.handle,
          '-ProcessId',
          String(w.pid),
          '-Action',
          action,
          '-Index',
          String(index),
          '-X',
          String(point.x),
          '-Y',
          String(point.y),
        ],
        { encoding: 'utf8', env },
      ).trim(),
    )
  }
  const capture = async (name) => {
    await menu()
    const png = await app.evaluate(
      async ({ desktopCapturer, screen }, bounds) => {
        const display = screen.getDisplayMatching(bounds)
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: display.size.width * display.scaleFactor,
            height: display.size.height * display.scaleFactor,
          },
        })
        const source = sources.find((s) => s.display_id === String(display.id))
        const scale = display.scaleFactor
        return source.thumbnail
          .crop({
            x: Math.round((bounds.x - display.bounds.x) * scale),
            y: Math.round((bounds.y - display.bounds.y) * scale),
            width: Math.round(bounds.width * scale),
            height: Math.round(bounds.height * scale),
          })
          .toPNG()
          .toString('base64')
      },
      (await state()).bounds,
    )
    await writeFile(join(run, `${name}.png`), Buffer.from(png, 'base64'))
  }
  await menu('Focus')
  await page.waitForTimeout(500)
  await capture('initial')
  await writeFile(join(run, 'dom.html'), await page.content())
  await page.getByTestId('topbar-search').click()
  const search = page.getByTestId('universal-search-input')
  await search.fill('mispeling')
  results.push({
    name: 'search-spellcheck',
    spellcheck: await search.getAttribute('spellcheck'),
  })
  const box = await search.boundingBox()
  await menu('RightClick', -1, {
    x: Math.round(box.x + 50),
    y: Math.round(box.y + box.height / 2),
  })
  await page.waitForTimeout(1000)
  results.push({
    name: 'search-native-menu',
    capture: 'search-native-menu.png',
    inspectionRequired: true,
  })
  await capture('search-native-menu')
  await page.screenshot({ path: join(run, 'search-page-not-native.png') })
  await writeFile(join(run, 'search-dom.html'), await page.content())
  await menu('Key', 27)
  await search.fill('Windows text menu sample')
  await search.press('Control+a')
  const rightClick = async (locator) => {
    const box = await locator.boundingBox()
    await menu('RightClick', -1, {
      x: Math.round(box.x + Math.min(50, box.width / 2)),
      y: Math.round(box.y + box.height / 2),
    })
    await page.waitForTimeout(400)
  }
  const choose = async (downs) => {
    for (let i = 0; i < downs; i++) await menu('Key', 40)
    await menu('Key', 13)
  }
  const clearClipboard = () =>
    app.evaluate(({ clipboard }) =>
      clipboard.writeText('text-menu-packet-sentinel'),
    )
  await clearClipboard()
  await rightClick(search)
  await capture('search-selected')
  await choose(2)
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('Windows text menu sample')
  results.push({ name: 'search-copy', passed: true })
  await clearClipboard()
  await rightClick(search)
  await choose(1)
  await expect(search).toHaveValue('')
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('Windows text menu sample')
  results.push({ name: 'search-cut', passed: true })
  await rightClick(search)
  await capture('search-empty-disabled')
  await choose(3)
  await expect(search).toHaveValue('Windows text menu sample')
  results.push({ name: 'search-paste', passed: true })
  await search.press('ArrowRight')
  await rightClick(search)
  await choose(4)
  const selection = await search.evaluate((el) => ({
    start: el.selectionStart,
    end: el.selectionEnd,
    length: el.value.length,
  }))
  assert.deepEqual(selection, {
    start: 0,
    end: selection.length,
    length: selection.length,
  })
  results.push({ name: 'search-select-all', passed: true })
  await page.keyboard.press('Escape')
  const canvas = page.getByTestId('graph-canvas')
  await rightClick(canvas)
  await expect(page.getByRole('menu')).toBeVisible()
  await capture('canvas-app-menu')
  results.push({
    name: 'canvas-app-menu',
    labels: await page.getByRole('menu').innerText(),
  })
  await page.keyboard.press('Escape')
  await page.getByTestId('bottom-panel-toggle').click()
  await writeFile(join(run, 'log-dom.html'), await page.content())
  await capture('log-panel')
  const logMessage = page.locator('.activity-log-message').first()
  const logText = await logMessage.innerText()
  await logMessage.dblclick({ position: { x: 15, y: 10 } })
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe(logText)
  await clearClipboard()
  await rightClick(logMessage)
  await capture('selected-log-copy-only')
  await choose(1)
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(logText)
  results.push({ name: 'selected-log-copy', text: logText, passed: true })
  await page.getByTestId('bottom-panel-toggle').click()
  await canvas.dblclick({ position: { x: 300, y: 200 } })
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await page.getByTestId('palette-search').fill('Text menu fixture')
  await page.locator('[data-node-type="fixture.text"]').click()
  await canvas.click({ position: { x: 400, y: 300 } })
  await page.waitForTimeout(1000)
  await capture('node-added')
  await writeFile(join(run, 'node-dom.html'), await page.content())
  await canvas.click({ position: { x: 400, y: 345 } })
  const text = page.getByTestId('widget-editor').locator('textarea, input')
  await expect(text).toBeVisible()
  await text.fill('Windows node text sample')
  await text.press('Control+a')
  await clearClipboard()
  await rightClick(text)
  await capture('node-text-native-menu')
  await choose(2)
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('Windows node text sample')
  results.push({ name: 'node-text-copy', passed: true })
  await text.press('Escape')
  await page.evaluate(() => getSelection()?.removeAllRanges())
  await menu('RightClick', -1, { x: 1100, y: 400 })
  await page.waitForTimeout(400)
  await capture('blank-space-no-menu')
  assert.equal(await page.getByRole('menu').count(), 0)
  results.push({
    name: 'blank-space',
    appMenuCount: await page.getByRole('menu').count(),
  })
  console.log(JSON.stringify(results))
} catch (error) {
  results.push({ error: String(error), stack: error.stack })
  throw error
} finally {
  await writeFile(
    join(run, 'results.json'),
    JSON.stringify(
      {
        historicalProductHead: '5e11f842925a1f95e713589f1e24b9f8b53c6d6c',
        fixture:
          'HTTP schema catalog; real product widgets and real product connection-status logs; no engine or debug bridge',
        nativeScreenInspectionRequired: true,
        results,
        requests,
      },
      null,
      2,
    ),
  )
  await app?.close()
  await new Promise((done) => server.close(done))
}
