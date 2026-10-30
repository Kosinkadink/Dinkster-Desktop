import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import { diagnosticCall } from './hang-diagnostic.js'

const directory = app.isPackaged
  ? join(process.resourcesPath, 'branding')
  : join(app.getAppPath(), 'resources', 'branding')
const palette = JSON.parse(readFileSync(join(directory, 'tokens', 'dinkster-colors.json'), 'utf8')) as {
  dark: { bg: { canvas: string }; text: { primary: string; secondary: string } }
  light: { bg: { canvas: string }; text: { primary: string; secondary: string } }
}

export function windowBackground(): string {
  return palette[diagnosticCall('theme-dark-colors', () => nativeTheme.shouldUseDarkColors) ? 'dark' : 'light'].bg.canvas
}

export function applicationIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(join(directory, 'raster', 'color', '256.png'))
}

export function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(directory, 'raster', process.platform === 'darwin' ? 'mono' : 'color', '16.png'))
  image.addRepresentation({
    scaleFactor: 2,
    buffer: readFileSync(join(directory, 'raster', process.platform === 'darwin' ? 'mono' : 'color', '32.png')),
  })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

let about: BrowserWindow | undefined

export async function showAbout(): Promise<void> {
  if (about && !about.isDestroyed()) {
    about.show()
    about.focus()
    return
  }
  const panel = new BrowserWindow({
    width: 520,
    height: 320,
    title: 'About Dinkster Desktop',
    icon: applicationIcon(),
    backgroundColor: windowBackground(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  about = panel
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  panel.webContents.on('will-navigate', (event) => event.preventDefault())
  const refresh = (): void => panel.setBackgroundColor(windowBackground())
  nativeTheme.on('updated', refresh)
  panel.on('closed', () => {
    nativeTheme.removeListener('updated', refresh)
    if (about === panel) about = undefined
  })
  const wordmark = (theme: string): string => readFileSync(join(directory, 'svg', `dinkster-wordmark-color-${theme}.svg`)).toString('base64')
  await panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>About Dinkster Desktop</title>
<style>
body{margin:0;background:${palette.light.bg.canvas};color:${palette.light.text.primary};font:16px system-ui;text-align:center;padding:38px 32px}
img{width:360px;max-width:100%;height:112px;object-fit:contain}p{margin:16px 0 0}small{color:${palette.light.text.secondary}}.dark{display:none}
@media(prefers-color-scheme:dark){body{background:${palette.dark.bg.canvas};color:${palette.dark.text.primary}}small{color:${palette.dark.text.secondary}}.light{display:none}.dark{display:inline}}
</style></head><body><img class="light" alt="Dinkster" src="data:image/svg+xml;base64,${wordmark('light')}"><img class="dark" alt="Dinkster" src="data:image/svg+xml;base64,${wordmark('dark')}"><p>Dinkster Desktop</p><p><small>Version ${app.getVersion().replace(/[^0-9A-Za-z.+-]/g, '')}</small></p></body></html>`)}`)
  panel.show()
}
