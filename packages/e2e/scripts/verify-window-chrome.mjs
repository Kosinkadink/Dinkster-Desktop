// Exercise the real process-owned page, native window and tray lifecycle.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect as baseExpect } from '@playwright/test'

const expect = baseExpect.configure({ timeout: 30_000 })
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert(process.env.DINKSTER_DESKTOP_VERIFY_ROOT, 'Set a new evidence directory')
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
const scratch = join(root, 'scratch')
const homeUrl = 'http://127.0.0.1:3638'
try {
  await fetch(`${homeUrl}/supervisor/status`, {
    signal: AbortSignal.timeout(2000),
  })
  throw new Error('Port 3638 is occupied; leave the existing process alone')
} catch (error) {
  if (error.cause?.code !== 'ECONNREFUSED') throw error
}
const chrome = JSON.parse(
  await readFile(
    join(repository, 'packages/app/dist/site/desktop-chrome.json'),
    'utf8',
  ),
)
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
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
  TMPDIR: tmpdir(),
})
await mkdir(env.DINKSTER_HOME, { recursive: true })
await writeFile(
  join(env.DINKSTER_HOME, 'model-settings.json'),
  JSON.stringify({ locations: [] }),
)
const require = createRequire(join(repository, 'packages/desktop/package.json'))
const results = []
let app
let page
const errors = []
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [
      '--no-sandbox',
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      `--user-data-dir=${join(scratch, 'chromium')}`,
      join(repository, 'packages/desktop'),
    ],
    env,
    timeout: 180_000,
  })
  page = await app.firstWindow({ timeout: 180_000 })
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page).toHaveURL(
    new RegExp(`^${homeUrl.replaceAll('.', '\\.')}[/?]`),
  )
  const bar = page.locator('.dinkster-window-toolbar-host')
  await expect(bar).toHaveAttribute('data-desktop-chrome', '')
  await expect(page.locator('button').first()).toBeVisible()
  const bridge = await page.evaluate(async () => ({
    locale: await window.dinksterDesktop.locale(),
    info: await window.dinksterDesktop.info(),
    projects: typeof window.dinksterProjects,
    library: typeof window.dinksterLibrary,
    context: await window.dinksterDesktop.windowContext(),
  }))
  assert(bridge.locale.length > 0)
  assert(bridge.info.appVersion.length > 0)
  assert.equal(bridge.projects, 'undefined')
  assert.equal(bridge.library, 'undefined')
  assert.equal(bridge.context.id, 'primary')
  const status = await fetch(`${homeUrl}/supervisor/status`).then((response) =>
    response.json(),
  )
  assert.equal(status.role, 'home')
  assert.equal(status.frontend, join(repository, 'packages/app/dist'))
  results.push({
    name: 'process-owned-startup',
    bridge,
    status,
    url: page.url(),
  })

  const state = () =>
    app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().startsWith('http://127.0.0.1:3638/'),
      )
      return {
        bounds: window.getBounds(),
        content: window.getContentBounds(),
        focused: window.isFocused(),
        visible: window.isVisible(),
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen(),
        pid: process.pid,
        buttons:
          process.platform === 'darwin'
            ? window.getWindowButtonPosition()
            : null,
        handle:
          process.platform === 'win32'
            ? window.getNativeWindowHandle().readBigUInt64LE().toString()
            : '',
      }
    })
  const setWindow = (action) =>
    app.evaluate(({ BrowserWindow }, action) => {
      const window = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().startsWith('http://127.0.0.1:3638/'),
      )
      if (action === 'maximize') window.maximize()
      if (action === 'restore') window.unmaximize()
      if (action === 'fullscreen') window.setFullScreen(true)
      if (action === 'leave-fullscreen') window.setFullScreen(false)
      if (action === 'size')
        window.setBounds({ x: 100, y: 80, width: 1120, height: 760 })
      window.show()
      window.focus()
    }, action)
  async function capture(name) {
    const png = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: display.size.width * display.scaleFactor,
          height: display.size.height * display.scaleFactor,
        },
      })
      return sources[0].thumbnail.toPNG().toString('base64')
    })
    await writeFile(join(root, `${name}.png`), Buffer.from(png, 'base64'))
  }
  async function check(name, fullscreen = false) {
    await expect
      .poll(() => bar.evaluate((element) => element.dataset.theme))
      .toBe(
        await page.evaluate(
          () => document.documentElement.dataset.theme ?? 'dark',
        ),
      )
    const measured = await bar.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const overlay = navigator.windowControlsOverlay
      const area = overlay?.visible ? overlay.getTitlebarAreaRect() : undefined
      return {
        top: rect.top,
        height: rect.height,
        platform: element.dataset.platform,
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
        overlay: area && { x: area.x, width: area.width, height: area.height },
        innerWidth,
        paddingTop: getComputedStyle(document.body).paddingTop,
        topInBar: element.contains(
          document.elementFromPoint(innerWidth / 2, 1),
        ),
      }
    })
    assert.equal(measured.top, 0)
    assert.equal(measured.height, chrome.native.overlay.dark.height)
    assert.equal(measured.paddingTop, '0px')
    assert.equal(measured.topInBar, true)
    assert.equal(measured.platform, process.platform)
    const window = await state()
    if (process.platform === 'darwin') {
      if (fullscreen) assert.equal(measured.paddingLeft, 12)
      else
        assert(
          measured.paddingLeft >= window.buttons.x + 52 + 12,
          'Content must clear the traffic lights',
        )
    } else if (fullscreen) assert.equal(measured.paddingRight, 12)
    else {
      assert(measured.overlay, 'Native controls must be visible')
      assert.equal(measured.overlay.x, 0)
      assert.equal(measured.overlay.height, chrome.native.overlay.dark.height)
      assert.equal(
        measured.paddingRight,
        measured.innerWidth - measured.overlay.width + 12,
      )
    }
    results.push({ name, measured, window })
    await capture(name)
  }
  await setWindow('size')
  await check('process-owned-dark')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await check('process-owned-light')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await check('process-owned-dark-restored')
  const before = await state()
  const drag = await bar.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    for (let x = 180; x < rect.width - 180; x += 20) {
      const target = document.elementFromPoint(x, rect.height / 2)
      if (
        target &&
        !target.closest('button, input, a, [role="button"]') &&
        getComputedStyle(target).webkitAppRegion === 'drag'
      )
        return { x, y: rect.height / 2 }
    }
    throw new Error('No native drag area in the process page toolbar')
  })
  const x = Math.round(before.content.x + drag.x)
  const y = Math.round(before.content.y + drag.y)
  if (process.platform === 'linux')
    execFileSync('xdotool', [
      'mousemove',
      String(x),
      String(y),
      'mousedown',
      '1',
      'sleep',
      '0.2',
      'mousemove',
      String(x + 90),
      String(y + 80),
      'sleep',
      '0.2',
      'mouseup',
      '1',
    ])
  else if (process.platform === 'win32')
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(dirname(fileURLToPath(import.meta.url)), 'native-window-mouse.ps1'),
      '-Handle',
      before.handle,
      '-ProcessId',
      String(before.pid),
      '-Action',
      'Drag',
      '-X',
      String(x),
      '-Y',
      String(y),
      '-EndX',
      String(x + 90),
      '-EndY',
      String(y + 80),
    ])
  else
    execFileSync('cliclick', [
      `dd:${x},${y}`,
      `dm:${x + 90},${y + 80}`,
      `du:${x + 90},${y + 80}`,
    ])
  await expect
    .poll(async () => {
      const after = await state()
      return (
        after.bounds.x !== before.bounds.x && after.bounds.y !== before.bounds.y
      )
    })
    .toBe(true)
  const after = await state()
  assert.equal(after.bounds.width, before.bounds.width)
  assert.equal(after.bounds.height, before.bounds.height)
  for (const [axis, travel] of [
    ['x', 90],
    ['y', 80],
  ]) {
    const moved = after.bounds[axis] - before.bounds[axis]
    assert(
      moved >= travel * 0.75 && moved <= travel * 1.25,
      `Native drag must move along ${axis}`,
    )
  }
  results.push({ name: 'native-toolbar-drag', before, after })
  await setWindow('maximize')
  await expect.poll(async () => (await state()).maximized).toBe(true)
  await check('maximized')
  await setWindow('restore')
  await expect.poll(async () => (await state()).maximized).toBe(false)
  await check('restored')
  await setWindow('fullscreen')
  await expect.poll(async () => (await state()).fullScreen).toBe(true)
  await check('full-screen', true)
  await setWindow('leave-fullscreen')
  await expect.poll(async () => (await state()).fullScreen).toBe(false)
  await check('left-full-screen')

  await app.evaluate(({ Menu, BrowserWindow }) => {
    const items = Menu.getApplicationMenu().items[0].submenu.items
    const keep = items.find(
      (item) => item.label === 'Keep running when the window closes',
    )
    keep.checked = true
    keep.click()
    BrowserWindow.getAllWindows()
      .find((item) =>
        item.webContents.getURL().startsWith('http://127.0.0.1:3638/'),
      )
      .close()
  })
  await expect.poll(async () => (await state()).visible).toBe(false)
  assert.equal(
    (
      await fetch(`${homeUrl}/supervisor/status`).then((response) =>
        response.json(),
      )
    ).supervisor.pid,
    status.supervisor.pid,
  )
  results.push({ name: 'tray-keeps-owned-process', window: await state() })
  assert.deepEqual(errors, [])
  const closed = app.waitForEvent('close')
  await app
    .evaluate(({ Menu }) => {
      Menu.getApplicationMenu()
        .items[0].submenu.items.find((item) => item.label === 'Quit')
        .click()
    })
    .catch(() => {})
  await closed
  app = undefined
  const deadline = Date.now() + 30_000
  let stopped = false
  while (Date.now() < deadline) {
    try {
      await fetch(`${homeUrl}/supervisor/status`, {
        signal: AbortSignal.timeout(2000),
      })
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') {
        stopped = true
        break
      }
    }
    await setTimeout(50)
  }
  assert(stopped, 'Quit must stop the process Desktop started')
  results.push({ name: 'quit-stopped-owned-process' })
  console.log(
    `Verified process-owned Desktop window, native drag and tray lifecycle on ${process.platform}`,
  )
} finally {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(root, 'final-page.png') })
      .catch(() => {})
  await writeFile(
    join(root, 'window-chrome.json'),
    JSON.stringify({ results, errors }, null, 2),
  )
  await app?.close()
}
