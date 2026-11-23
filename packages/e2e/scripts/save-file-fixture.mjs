import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { saveFile } from '../../desktop/dist/save-file.js'
import { isTrustedDesktopIpc } from '../../desktop/dist/ipc-security.js'
import { secureWebPreferences } from '../../desktop/dist/security.js'

app.setPath('userData', process.env.DINKSTER_SMOKE_ARTIFACTS)
await app.whenReady()
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end(
    '<!doctype html><title>Save bridge verification</title><h1>Save bridge verification</h1><p>Native Save As uses the public editor bridge.</p>',
  )
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const window = new BrowserWindow({
  width: 900,
  height: 600,
  webPreferences: {
    ...secureWebPreferences(
      resolve(import.meta.dirname, '../../desktop/dist/preload.cjs'),
    ),
    additionalArguments: ['--dinkster-local-files'],
  },
})
ipcMain.handle('desktop:save-file', async (event, bytes, name) => {
  const frame = event.senderFrame
  const validate = () => {
    if (
      window.isDestroyed() ||
      event.senderFrame !== frame ||
      !isTrustedDesktopIpc(
        window.webContents,
        window.webContents.mainFrame,
        origin,
        event.sender,
        event.senderFrame,
      )
    ) {
      throw new Error('Untrusted saving window')
    }
  }
  validate()
  return saveFile(bytes, name, window, validate)
})
await window.loadURL(origin)
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => server.close())
