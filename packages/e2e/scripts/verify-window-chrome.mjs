// Opens a real Desktop window on the pinned editor and checks that the
// operating system's window buttons sit in the editor's own top bar: no bar
// above it, the bar drags the window, and its controls still respond. Real
// pointer input comes from xdotool (Linux), cliclick (macOS) or SendInput
// (hosted Windows). Evidence goes to DINKSTER_DESKTOP_VERIFY_ROOT.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect as baseExpect } from '@playwright/test'
import { installationManager } from './installation-manager.mjs'

const expect = baseExpect.configure({ timeout: 30_000 })
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert(
  process.env.DINKSTER_DESKTOP_VERIFY_ROOT,
  'Set DINKSTER_DESKTOP_VERIFY_ROOT to a new evidence directory',
)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
const editor = join(repository, 'packages/app/dist')
const chrome = JSON.parse(
  await readFile(join(editor, 'site/desktop-chrome.json'), 'utf8'),
)
const barHeight = chrome.native.overlay.dark.height
const mac = process.platform === 'darwin'

// The pinned editor stands in for an engine; only its account route answers.
let signedIn = false
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
}
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
  if (path === '/api/account') {
    response.setHeader('Content-Type', 'application/json')
    return response.end(
      JSON.stringify({
        available: true,
        canStartSignIn: true,
        signInUnavailableReason: null,
        signedIn,
        profile: signedIn
          ? { displayName: 'Ada Lovelace', email: 'ada@example.com' }
          : null,
        signIn: { state: 'idle' },
      }),
    )
  }
  if (path.startsWith('/api') || path.startsWith('/ws'))
    return response.writeHead(503).end()
  const file = normalize(join(editor, path))
  for (const candidate of file.startsWith(editor)
    ? [file, join(editor, 'index.html')]
    : [join(editor, 'index.html')]) {
    try {
      const body = await readFile(candidate)
      response.setHeader(
        'Content-Type',
        types[extname(candidate)] ?? 'application/octet-stream',
      )
      return response.end(body)
    } catch {}
  }
  response.writeHead(404).end()
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}`

const scratch = join(root, 'scratch')
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
  XDG_DATA_HOME: join(scratch, 'xdg-data'),
  XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
  LOCALAPPDATA: join(scratch, 'local-app-data'),
  APPDATA: join(scratch, 'app-data'),
  DINKSTER_HOME: join(scratch, 'home'),
  DINKSTER_DESKTOP_DATA: join(scratch, 'desktop'),
  DINKSTER_ENV: join(scratch, 'environment-tools-must-not-run'),
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
  TMPDIR: tmpdir(),
})

const require = createRequire(join(repository, 'packages/desktop/package.json'))
const results = []
let app
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [
      '--no-sandbox',
      ...(mac ? ['--use-mock-keychain'] : []),
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(repository, 'packages/desktop'),
    ],
    env,
    timeout: 60_000,
  })
  const projects = await installationManager(app)
  await projects
    .getByText('Connect a remote environment', { exact: true })
    .click()
  await projects.getByLabel('Remote environment name').fill('Window buttons')
  await projects.getByLabel('Server URL').fill(url)
  await projects.getByRole('button', { name: 'Save remote binding' }).click()
  const opened = app.waitForEvent('window')
  await projects.getByRole('button', { name: 'Open Remote engine' }).click()
  const page = await opened
  const bar = page.locator('.dinkster-window-toolbar-host')
  await expect(bar).toHaveAttribute('data-desktop-chrome', '')
  // Only the editor window stays on screen for captures and pointer input,
  // whole, with room left to drag it.
  await app.evaluate(({ BrowserWindow, screen }, url) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.webContents.getURL().startsWith(url)) window.hide()
    const editor = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith(url),
    )
    const area = screen.getPrimaryDisplay().workArea
    editor.setBounds({
      x: area.x + 40,
      y: area.y + 40,
      width: Math.min(1280, area.width - 140),
      height: Math.min(760, area.height - 120),
    })
    editor.focus()
  }, url)

  const windowState = () =>
    app.evaluate(({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith(url),
      )
      return {
        bounds: window.getBounds(),
        content: window.getContentBounds(),
        handle:
          process.platform === 'win32'
            ? window.getNativeWindowHandle().readBigUInt64LE().toString()
            : '',
        pid: process.pid,
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen(),
        focused: window.isFocused(),
        buttons:
          process.platform === 'darwin'
            ? window.getWindowButtonPosition()
            : null,
      }
    }, url)
  const setWindow = (action) =>
    app.evaluate(
      ({ BrowserWindow }, { url, action }) => {
        const window = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith(url),
        )
        if (action === 'maximize') window.maximize()
        if (action === 'restore') window.unmaximize()
        if (action === 'fullscreen') window.setFullScreen(true)
        if (action === 'leave-fullscreen') window.setFullScreen(false)
        window.show()
        window.focus()
      },
      { url, action },
    )
  const geometry = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.dinkster-window-toolbar-host')
      const rect = bar.getBoundingClientRect()
      const overlay = navigator.windowControlsOverlay
      const area = overlay?.visible ? overlay.getTitlebarAreaRect() : undefined
      const style = getComputedStyle(bar)
      const top = document.elementFromPoint(innerWidth / 2, 1)
      return {
        top: rect.top,
        height: rect.height,
        width: rect.width,
        bodyPaddingTop: getComputedStyle(document.body).paddingTop,
        topElementInBar: bar.contains(top),
        platform: bar.dataset.platform,
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
        background: style.backgroundColor,
        theme: document.documentElement.dataset.theme ?? 'dark',
        barTheme: bar.dataset.theme,
        overlay: area && {
          x: area.x,
          width: area.width,
          height: area.height,
        },
        innerWidth,
      }
    })
  async function capture(name) {
    const shot = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const display = screen.getPrimaryDisplay()
      const [source] = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: display.size.width * display.scaleFactor,
          height: display.size.height * display.scaleFactor,
        },
      })
      return source.thumbnail.toPNG().toString('base64')
    })
    await writeFile(join(root, `${name}.png`), Buffer.from(shot, 'base64'))
  }
  // Checks one state of the window and records it.
  async function check(name, state) {
    await page.waitForTimeout(1500)
    const measured = await geometry()
    const window = await windowState()
    await capture(name)
    results.push({ name, ...measured, window })
    assert.equal(measured.top, 0, `${name}: nothing sits above the bar`)
    assert.equal(measured.bodyPaddingTop, '0px', `${name}: no page offset`)
    assert(measured.topElementInBar, `${name}: the window's top row is the bar`)
    assert.equal(measured.height, barHeight, `${name}: bar height`)
    assert.equal(measured.platform, process.platform, `${name}: platform`)
    assert.equal(measured.barTheme, measured.theme, `${name}: bar theme`)
    const controlsShown = state !== 'fullscreen'
    if (mac) {
      // The three traffic lights span 52pt from their left edge.
      if (controlsShown)
        assert(
          measured.paddingLeft >= window.buttons.x + 52 + 12,
          `${name}: content starts after the traffic lights`,
        )
      else
        assert.equal(
          measured.paddingLeft,
          12,
          `${name}: no traffic-light inset`,
        )
    } else if (controlsShown) {
      assert(measured.overlay, `${name}: window controls overlay shown`)
      assert.equal(measured.overlay.x, 0, `${name}: buttons at the right`)
      assert.equal(measured.overlay.height, barHeight, `${name}: button height`)
      assert.equal(
        measured.paddingRight,
        measured.innerWidth - measured.overlay.width + 12,
        `${name}: content ends before the buttons`,
      )
    } else {
      assert.equal(measured.paddingRight, 12, `${name}: no reserved buttons`)
    }
  }

  async function pointer(action, x, y, endX = x, endY = y) {
    // Windows sends input only to the foreground window, which the editor
    // can lose while other Desktop windows load.
    await setWindow('focus')
    await expect.poll(async () => (await windowState()).focused).toBe(true)
    const window = await windowState()
    if (process.platform === 'linux') {
      const steps = Array.from({ length: 10 }, (_, index) => [
        'mousemove',
        String(Math.round(x + ((endX - x) * (index + 1)) / 10)),
        String(Math.round(y + ((endY - y) * (index + 1)) / 10)),
        'sleep',
        '0.05',
      ]).flat()
      execFileSync('xdotool', [
        'mousemove',
        String(x),
        String(y),
        'sleep',
        '0.2',
        'mousedown',
        '1',
        'sleep',
        '0.2',
        ...steps,
        'sleep',
        '0.2',
        'mouseup',
        '1',
      ])
    } else if (mac) {
      execFileSync('cliclick', [
        '-e',
        '20',
        `m:${x},${y}`,
        `dd:${x},${y}`,
        ...Array.from(
          { length: 10 },
          (_, index) =>
            `dm:${Math.round(x + ((endX - x) * (index + 1)) / 10)},${Math.round(y + ((endY - y) * (index + 1)) / 10)}`,
        ),
        `du:${endX},${endY}`,
      ])
    } else {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(
          dirname(fileURLToPath(import.meta.url)),
          'native-window-mouse.ps1',
        ),
        '-Handle',
        window.handle,
        '-ProcessId',
        String(window.pid),
        '-Action',
        action,
        '-X',
        String(x),
        '-Y',
        String(y),
        '-EndX',
        String(endX),
        '-EndY',
        String(endY),
      ])
    }
    await page.waitForTimeout(1000)
  }
  // Screen points for an element of the bar.
  async function screenPoint(selector, offsetX = 0) {
    const box = await page.locator(selector).first().boundingBox()
    const { content } = await windowState()
    return {
      x: Math.round(content.x + box.x + box.width / 2 + offsetX),
      y: Math.round(content.y + box.y + box.height / 2),
    }
  }
  async function dragFrom(name, start) {
    const before = await windowState()
    await pointer('Drag', start.x, start.y, start.x + 90, start.y + 80)
    const after = await windowState()
    const moved = {
      x: after.bounds.x - before.bounds.x,
      y: after.bounds.y - before.bounds.y,
    }
    const resized =
      after.bounds.width !== before.bounds.width ||
      after.bounds.height !== before.bounds.height
    results.push({ name, start, moved, resized })
    return { moved, resized }
  }

  for (const account of [false, true]) {
    signedIn = account
    await page.reload()
    await expect(bar).toHaveAttribute('data-desktop-chrome', '')
    const accountCell = bar.locator('.dinkster-window-toolbar-account')
    await expect(accountCell.locator('button')).toBeVisible()
    await expect(accountCell.locator('.dinkster-sign-in')).toHaveCount(
      account ? 0 : 1,
    )
    await check(account ? 'signed-in' : 'signed-out')
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await check('light-theme')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await check('dark-theme')

  // The empty space left of the search field drags the window.
  const search = await screenPoint('.dinkster-window-toolbar-search > *')
  const searchBox = await page
    .locator('.dinkster-window-toolbar-search > *')
    .boundingBox()
  const empty = { x: search.x - searchBox.width / 2 - 60, y: search.y }
  const dragged = await dragFrom('drag-empty', empty)
  for (const [axis, travel] of [
    ['x', 90],
    ['y', 80],
  ])
    assert(
      dragged.moved[axis] >= travel * 0.75 &&
        dragged.moved[axis] <= travel * 1.25,
      `dragging the bar's empty space moves the window along ${axis}: ${JSON.stringify(dragged)}`,
    )
  assert(!dragged.resized, 'dragging the bar does not resize the window')
  // A control in the bar takes the press instead of moving the window.
  const pressed = await dragFrom(
    'drag-control',
    await screenPoint('.dinkster-window-toolbar-search > *'),
  )
  assert.deepEqual(pressed.moved, { x: 0, y: 0 }, 'a control does not drag')
  await page.keyboard.press('Escape')
  const layout = await screenPoint('.app-layout-menu button')
  await pointer('Click', layout.x, layout.y)
  await expect(page.getByRole('menu')).toBeVisible()
  await capture('layout-menu')
  await page.keyboard.press('Escape')

  await setWindow('maximize')
  await check('maximized')
  await setWindow('restore')
  await check('restored')
  await setWindow('fullscreen')
  await expect.poll(async () => (await windowState()).fullScreen).toBe(true)
  await check('full-screen', 'fullscreen')
  await setWindow('leave-fullscreen')
  await expect.poll(async () => (await windowState()).fullScreen).toBe(false)
  await check('left-full-screen')

  // The Environments window wears the same single bar.
  await app.evaluate(({ BrowserWindow }, url) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().startsWith(url)) window.hide()
      else if (
        window.webContents.getURL().endsWith('/desktop-environments.html')
      ) {
        window.show()
        window.focus()
      }
    }
  }, url)
  const environments = projects.locator('[data-desktop-chrome]')
  await expect(environments).toHaveCount(1)
  await page.waitForTimeout(1500)
  const environmentsBar = await environments.evaluate((bar) => {
    const rect = bar.getBoundingClientRect()
    return {
      top: rect.top,
      height: rect.height,
      topElementInBar: bar.contains(
        document.elementFromPoint(innerWidth / 2, 1),
      ),
      bodyPaddingTop: getComputedStyle(document.body).paddingTop,
    }
  })
  results.push({ name: 'environments', ...environmentsBar })
  await capture('environments')
  assert.deepEqual(
    environmentsBar,
    { top: 0, height: barHeight, topElementInBar: true, bodyPaddingTop: '0px' },
    'environments: one bar at the top of the window',
  )
  console.log(`Verified window buttons in the top bar on ${process.platform}`)
} finally {
  await writeFile(
    join(root, 'window-chrome.json'),
    JSON.stringify(results, null, 2),
  )
  await app?.close()
  await new Promise((done) => server.close(done))
}
