import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import {
  requireHostedWindows,
  verifyNativeWindow,
} from './verify-native-window.mjs'

const nativeInput = process.env.DINKSTER_NATIVE_WINDOW_INPUT === '1'
if (nativeInput) requireHostedWindows()

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert(
  process.env.DINKSTER_DESKTOP_VERIFY_ROOT,
  'Supply a new owned evidence root',
)
const root = resolve(process.env.DINKSTER_DESKTOP_VERIFY_ROOT)
await mkdir(root)
const require = createRequire(join(repository, 'packages/desktop/package.json'))
const source = pathToFileURL(
  join(repository, 'packages/desktop/dist/window-chrome.js'),
).href
const site = join(repository, 'packages/app/dist/site')
const entry = join(root, 'main.mjs')
await writeFile(
  entry,
  `
import { app, BrowserWindow, nativeTheme } from 'electron'
import { readWindowChrome, windowChromeOptions, installWindowChrome } from ${JSON.stringify(source)}
const chrome = readWindowChrome(${JSON.stringify(site)})
app.on('window-all-closed', () => {})
globalThis.openChrome = async (url, qa, development, width) => {
  const window = new BrowserWindow({ ...windowChromeOptions(chrome, nativeTheme.shouldUseDarkColors),
    width, height: 600, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.on('closed', () => globalThis.nativeBackdrop?.focus())
  installWindowChrome(window, chrome, nativeTheme, () => development, qa ? 'qa' : 'production')
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await window.loadURL(url)
  window.showInactive()
}
`,
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
  CUDA_VISIBLE_DEVICES: '',
  DINKSTER_ACCELERATOR: 'cpu',
  XDG_DATA_HOME: join(root, 'xdg-data'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
})
const policy =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; font-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'"
const font = await readFile(join(site, 'assets/NotoSans-Regular.woff2'))
const requests = []
const server = createServer((request, response) => {
  requests.push(request.url)
  response.setHeader('Content-Security-Policy', policy)
  if (request.url === '/font.woff2') {
    response.setHeader('Content-Type', 'font/woff2')
    response.end(font)
  } else if (request.url === '/page.css') {
    response.setHeader('Content-Type', 'text/css')
    response.end(
      '@font-face{font-family:"Noto Sans";src:url(/font.woff2)}body{margin:0;font-family:"Noto Sans"}main{padding:24px}#toast{position:fixed;right:24px;bottom:24px}',
    )
  } else if (request.url === '/page.js') {
    response.setHeader('Content-Type', 'text/javascript')
    response.end(`document.querySelector('#toast').onclick=e=>e.target.remove();
      document.querySelector('#control')?.addEventListener('click',e=>e.target.textContent='Control works')`)
  } else if (request.url === '/existing' || request.url === '/fallback') {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><meta charset="utf-8"><title>Untrusted page title</title>
      <link rel="stylesheet" href="/page.css">
      ${request.url === '/existing' ? '<header class="topbar"><button id="control">Original control</button></header>' : ''}
      <main><h1>Engine content</h1><p>Original content remains available.</p></main>
      <button id="toast">Saved successfully - dismiss</button><script src="/page.js"></script>`)
  } else {
    response.writeHead(404).end()
  }
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const origin = `http://127.0.0.1:${server.address().port}`
let app
let recorder
let recorderLog
let recorderFinished
const results = []
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', `--user-data-dir=${join(root, 'electron')}`, entry],
    env,
  })
  if (nativeInput) {
    await app.evaluate(async ({ BrowserWindow, screen }) => {
      const backdrop = new BrowserWindow({
        ...screen.getPrimaryDisplay().bounds,
        frame: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: '#202020',
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      await backdrop.loadURL(
        'data:text/html,<title>Native window test backdrop</title>',
      )
      backdrop.showInactive()
      globalThis.nativeBackdrop = backdrop
    })
    recorderLog = createWriteStream(join(root, 'desktop-recording.log'))
    recorder = spawn(
      'ffmpeg',
      [
        '-y',
        '-f',
        'gdigrab',
        '-framerate',
        '10',
        '-draw_mouse',
        '1',
        '-i',
        'desktop',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        join(root, 'desktop-input.mp4'),
      ],
      { windowsHide: true },
    )
    let progress = ''
    let recordingError
    recorder.on('error', (error) => {
      recordingError = error
    })
    recorderFinished = once(recorder, 'close')
    // Handle an early recorder failure while retaining its diagnostic log.
    recorderFinished.catch(() => {})
    recorder.stderr.pipe(recorderLog)
    recorder.stderr.on('data', (data) => {
      progress += data.toString()
    })
    await expect
      .poll(
        () =>
          Boolean(
            recordingError ||
              recorder.exitCode !== null ||
              progress.includes('frame='),
          ),
        { timeout: 15000 },
      )
      .toBe(true)
    if (recordingError) throw recordingError
    assert.equal(
      recorder.exitCode,
      null,
      'Desktop recorder exited before input',
    )
  }
  for (const theme of ['dark', 'light']) {
    await app.evaluate(({ nativeTheme }, theme) => {
      nativeTheme.themeSource = theme
    }, theme)
    for (const existing of [true, false]) {
      const opened = app.waitForEvent('window')
      await app.evaluate(
        async (_, { url, width }) =>
          globalThis.openChrome(url, true, true, width),
        {
          url: `${origin}/${existing ? 'existing' : 'fallback'}`,
          width: 390,
        },
      )
      const page = await opened
      await expect(page.locator('.dinkster-window-identity')).toBeVisible()
      await expect(page.locator('.dinkster-window-identity')).toContainText(
        'QA',
      )
      await expect(page.locator('.dinkster-window-identity')).toContainText(
        'Development',
      )
      await expect(page.locator('[data-desktop-chrome]')).toHaveAttribute(
        'data-theme',
        theme,
      )
      assert.deepEqual(
        await page.evaluate(() => [
          typeof window.require,
          typeof window.process,
          typeof window.dinksterDesktop,
          typeof window.DinksterDesktopChrome,
        ]),
        ['undefined', 'undefined', 'undefined', 'undefined'],
      )
      assert.deepEqual(
        await page.evaluate(async () => {
          const script = document.createElement('script')
          script.textContent = 'globalThis.cspEscaped = true'
          document.head.append(script)
          const connectBlocked = await fetch('/unexpected-connect').then(
            () => false,
            () => true,
          )
          return {
            inlineBlocked: globalThis.cspEscaped === undefined,
            connectBlocked,
          }
        }),
        { inlineBlocked: true, connectBlocked: true },
      )
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.fonts].some(
              (face) =>
                face.family.replaceAll('"', '') === 'Noto Sans' &&
                face.status === 'loaded',
            ),
          ),
        )
        .toBe(true)
      if (!existing) {
        await expect
          .poll(() =>
            page
              .locator('.dinkster-brand-mark')
              .evaluate((image) => image.naturalWidth),
          )
          .toBeGreaterThan(0)
      }
      const geometry = await page.evaluate(() => {
        const bar = document.querySelector('[data-desktop-chrome]')
        const bounds = bar.getBoundingClientRect()
        const identity = document
          .querySelector('.dinkster-window-identity')
          .getBoundingClientRect()
        const toast = document.querySelector('#toast').getBoundingClientRect()
        return {
          height: bounds.height,
          contained:
            identity.top >= bounds.top && identity.bottom <= bounds.bottom,
          clear: identity.bottom < toast.top,
          overflow: document.documentElement.scrollWidth > innerWidth,
          region: getComputedStyle(bar).webkitAppRegion,
          pseudo: getComputedStyle(document.body, '::after').content,
        }
      })
      assert.equal(geometry.height, 56)
      assert.equal(geometry.contained, true)
      assert.equal(geometry.clear, true)
      assert.equal(geometry.overflow, false)
      assert.equal(geometry.region, 'drag')
      assert.equal(geometry.pseudo, 'none')
      if (existing) {
        await page.locator('#control').click()
        await expect(page.locator('#control')).toHaveText('Control works')
      }
      await page.screenshot({
        path: join(
          root,
          `${theme}-${existing ? 'existing' : 'fallback'}-390.png`,
        ),
      })
      await page.locator('#toast').click()
      await expect(page.locator('#toast')).toHaveCount(0)
      const opposite = theme === 'dark' ? 'light' : 'dark'
      await app.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme
      }, opposite)
      await expect(page.locator('[data-desktop-chrome]')).toHaveAttribute(
        'data-theme',
        opposite,
      )
      await expect(page.locator('.dinkster-window-identity')).toHaveCount(1)
      await app.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme
      }, theme)
      const window = await app.browserWindow(page)
      await window.evaluate((window) => window.minimize())
      await expect
        .poll(() => window.evaluate((window) => window.isMinimized()))
        .toBe(true)
      await window.evaluate((window) => window.restore())
      await expect
        .poll(() => window.evaluate((window) => window.isMinimized()))
        .toBe(false)
      await window.evaluate((window) => window.maximize())
      await expect
        .poll(() => window.evaluate((window) => window.isMaximized()))
        .toBe(true)
      await window.evaluate((window) => window.unmaximize())
      await expect
        .poll(() => window.evaluate((window) => window.isMaximized()))
        .toBe(false)
      await window.evaluate((window) => window.setSize(1100, 700))
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1100)
      await page.screenshot({
        path: join(
          root,
          `${theme}-${existing ? 'existing' : 'fallback'}-1100.png`,
        ),
      })
      let nativeMouse
      if (nativeInput) {
        assert.equal(
          recorder.exitCode,
          null,
          'Desktop recorder stopped during validation',
        )
        await window.evaluate((window) =>
          window.setBounds({ x: 100, y: 100, width: 390, height: 600 }),
        )
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390)
        nativeMouse = await verifyNativeWindow(
          app,
          page,
          root,
          `${theme}-${existing ? 'existing' : 'fallback'}`,
        )
      }
      results.push({
        nativeMouse,
        theme,
        existing,
        geometry,
        isolated: true,
        themeChanged: true,
        toastDismissed: true,
        cspEnforced: true,
        nativeWindowStates: true,
      })
      if (!nativeInput) await window.evaluate((window) => window.destroy())
    }
  }
  assert.equal(requests.includes('/unexpected-connect'), false)
  assert(
    requests.every((url) =>
      [
        '/existing',
        '/fallback',
        '/page.css',
        '/page.js',
        '/font.woff2',
        '/favicon.ico',
      ].includes(url),
    ),
  )
  await writeFile(
    join(root, 'results.json'),
    JSON.stringify(
      { platform: process.platform, policy, requests, results },
      null,
      2,
    ),
  )
} finally {
  try {
    try {
      if (recorder?.pid) {
        const endedEarly =
          recorder.exitCode !== null || recorder.signalCode !== null
        if (!endedEarly) recorder.stdin.end('q\n')
        const timeout = setTimeout(() => recorder.kill(), 15000)
        try {
          const [code] = await recorderFinished
          assert.equal(
            endedEarly,
            false,
            'Desktop recording ended before intentional shutdown',
          )
          assert.equal(code, 0, 'Desktop recording must finish successfully')
        } finally {
          clearTimeout(timeout)
        }
      }
    } finally {
      recorderLog?.end()
    }
  } finally {
    try {
      await app?.close()
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }
}
console.log(
  `Shared chrome passed ${results.length} Electron cases${nativeInput ? ' including native mouse input and desktop recording' : ''}`,
)
