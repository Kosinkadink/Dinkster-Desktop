import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import { desktopTitle, type DesktopServices } from './services.js'

const directory = app.isPackaged
  ? join(process.resourcesPath, 'branding')
  : join(app.getAppPath(), 'resources', 'branding')
const palette = JSON.parse(readFileSync(join(directory, 'tokens', 'dinkster-colors.json'), 'utf8')) as {
  dark: { bg: { canvas: string }; text: { primary: string; secondary: string } }
  light: { bg: { canvas: string }; text: { primary: string; secondary: string } }
}

export function windowBackground(): string {
  return palette[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].bg.canvas
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

export async function showAbout(services: DesktopServices = 'production'): Promise<void> {
  if (about && !about.isDestroyed()) {
    about.show()
    about.focus()
    return
  }
  const panel = new BrowserWindow({
    width: 520,
    height: 320,
    title: services === 'qa' ? desktopTitle(services) : 'About Dinkster Desktop',
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
  panel.on('page-title-updated', (event) => event.preventDefault())
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  panel.webContents.on('will-navigate', (event) => event.preventDefault())
  const refresh = (): void => panel.setBackgroundColor(windowBackground())
  nativeTheme.on('updated', refresh)
  panel.on('closed', () => {
    nativeTheme.removeListener('updated', refresh)
    if (about === panel) about = undefined
  })
  const frontend = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(app.getAppPath(), '..', 'app', 'dist')
  await panel.loadFile(join(frontend, 'site', 'about.html'), {
    query: { title: desktopTitle(services), version: app.getVersion() },
  })
  panel.show()
}
