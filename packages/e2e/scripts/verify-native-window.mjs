import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFile, writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'

const execute = promisify(execFile)

export function requireHostedWindows() {
  assert.equal(process.platform, 'win32', 'Native input requires Windows')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'Windows')
}

export async function verifyNativeWindow(app, page, root, label) {
  requireHostedWindows()
  const window = await app.browserWindow(page)
  const pid = await app.evaluate(() => process.pid)
  const handle = await window.evaluate((window) => {
    const buffer = window.getNativeWindowHandle()
    return buffer.readBigUInt64LE().toString()
  })
  const scale = await app.evaluate(
    ({ screen }) => screen.getPrimaryDisplay().scaleFactor,
  )
  assert.equal(scale, 1, 'Native coordinate proof requires unit display scale')
  const states = []
  const capture = async (action) => {
    const state = await window.evaluate((window) => ({
      bounds: window.getBounds(),
      minimized: window.isMinimized(),
      maximized: window.isMaximized(),
    }))
    const screenshot = await app.evaluate(
      async ({ desktopCapturer, screen }) => {
        const display = screen.getPrimaryDisplay()
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: display.size,
        })
        const source = sources.find(
          (source) => source.display_id === String(display.id),
        )
        if (!source || source.thumbnail.isEmpty())
          throw new Error('Desktop screenshot missing')
        return source.thumbnail.toPNG().toString('base64')
      },
    )
    await writeFile(
      join(root, `${label}-${action}.png`),
      Buffer.from(screenshot, 'base64'),
    )
    states.push({ action, ...state })
    await writeFile(
      join(root, `${label}-native.json`),
      JSON.stringify(states, null, 2),
    )
    return state
  }
  const mouse = async (action, x, y, endX = x, endY = y) => {
    const { stdout } = await execute(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        fileURLToPath(new URL('./native-window-mouse.ps1', import.meta.url)),
        '-Handle',
        handle,
        '-ProcessId',
        String(pid),
        '-Action',
        action,
        '-X',
        String(Math.round(x)),
        '-Y',
        String(Math.round(y)),
        '-EndX',
        String(Math.round(endX)),
        '-EndY',
        String(Math.round(endY)),
      ],
      { timeout: 15000, windowsHide: true },
    )
    await appendFile(join(root, `${label}-input.log`), `${action}: ${stdout}\n`)
  }
  const points = async () => {
    const content = await window.evaluate((window) => window.getContentBounds())
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(content.width)
    const overlay = await page.evaluate(() => {
      const rect = navigator.windowControlsOverlay.getTitlebarAreaRect()
      return { x: rect.x, width: rect.width, height: rect.height, innerWidth }
    })
    const reserved = overlay.innerWidth - overlay.x - overlay.width
    assert(
      reserved >= 120 && reserved <= 160,
      `Unexpected native overlay width ${reserved}`,
    )
    assert.equal(overlay.height, 56)
    return {
      minimize: content.x + overlay.x + overlay.width + reserved / 6,
      maximize: content.x + overlay.x + overlay.width + reserved / 2,
      close: content.x + overlay.x + overlay.width + (reserved * 5) / 6,
      y: content.y + overlay.height / 2,
      dragX: content.x + overlay.x + overlay.width - 6,
    }
  }
  await window.evaluate((window) => {
    window.show()
    window.focus()
  })
  await expect
    .poll(() => window.evaluate((window) => window.isFocused()))
    .toBe(true)
  await capture('before')
  const control = (await page.locator('#control').count())
    ? await page.locator('#control').boundingBox()
    : null
  if (control) {
    const before = await window.evaluate((window) => window.getBounds())
    const content = await window.evaluate((window) => window.getContentBounds())
    const x = content.x + control.x + control.width / 2
    const y = content.y + control.y + control.height / 2
    await mouse('Drag', x, y, x + 90, y + 80)
    await expect
      .poll(() => window.evaluate((window) => window.getBounds()))
      .toEqual(before)
    await capture('control-not-draggable')
  }
  for (const [dx, dy, label] of [
    [90, 80, 'dragged-down-right'],
    [-70, -100, 'dragged-up-left'],
  ]) {
    const before = await window.evaluate((window) => window.getBounds())
    const point = await points()
    await mouse('Drag', point.dragX, point.y, point.dragX + dx, point.y + dy)
    // Native drag activation consumes cursor travel; window travel is not pixel-identical.
    // Exercise both directions and reject no-op, wrong-axis, overshoot and resize behavior.
    await expect
      .poll(async () => {
        const bounds = await window.evaluate((window) => window.getBounds())
        const x = (bounds.x - before.x) / dx
        const y = (bounds.y - before.y) / dy
        return (
          x >= 0.75 &&
          x <= 1 &&
          y >= 0.75 &&
          y <= 1 &&
          bounds.width === before.width &&
          bounds.height === before.height
        )
      })
      .toBe(true)
    await capture(label)
  }
  let point = await points()
  await mouse('DoubleClick', point.dragX, point.y)
  await expect
    .poll(() => window.evaluate((window) => window.isMaximized()))
    .toBe(true)
  await capture('double-click-maximized')
  point = await points()
  await mouse('DoubleClick', point.dragX, point.y)
  await expect
    .poll(() => window.evaluate((window) => window.isMaximized()))
    .toBe(false)
  point = await points()
  await mouse('Click', point.maximize, point.y)
  await expect
    .poll(() => window.evaluate((window) => window.isMaximized()))
    .toBe(true)
  await capture('button-maximized')
  point = await points()
  await mouse('Click', point.maximize, point.y)
  await expect
    .poll(() => window.evaluate((window) => window.isMaximized()))
    .toBe(false)
  await capture('button-restored')
  point = await points()
  await mouse('Click', point.minimize, point.y)
  await expect
    .poll(() => window.evaluate((window) => window.isMinimized()))
    .toBe(true)
  await capture('button-minimized')
  // Only setup uses the API; every claimed transition above is OS mouse input.
  await window.evaluate((window) => {
    window.restore()
    window.focus()
  })
  await expect
    .poll(() => window.evaluate((window) => window.isFocused()))
    .toBe(true)
  point = await points()
  const closed = page.waitForEvent('close')
  await mouse('Click', point.close, point.y)
  await closed
  states.push({ action: 'button-closed', closed: true })
  await writeFile(
    join(root, `${label}-native.json`),
    JSON.stringify(states, null, 2),
  )
  return states
}
