import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { importNativeFile } from '../../desktop/dist/local-files.js'
import { isTrustedDesktopIpc } from '../../desktop/dist/ipc-security.js'
import { secureWebPreferences } from '../../desktop/dist/security.js'

const artifacts = process.env.DINKSTER_SMOKE_ARTIFACTS
const backend = process.env.DINKSTER_IMPORT_TEST_BACKEND
const project = process.env.DINKSTER_IMPORT_TEST_PROJECT || 'default'
if (!artifacts || !backend)
  throw new Error('An isolated artifact root and test backend are required')
app.setPath('userData', artifacts)

app.whenReady().then(async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(
      '<!doctype html><title>Native import verification</title><input type="file"><p>Explicit file import through the public Desktop bridge.</p>',
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
  globalThis.nativeImportProof = { requests: 0, bytes: 0 }
  const fetchRequest = globalThis.fetch
  globalThis.fetch = (url, options) => {
    if (new URL(url).pathname === '/api/mounts/import-file') {
      globalThis.nativeImportProof.requests++
      globalThis.nativeImportProof.bytes += Buffer.byteLength(options.body)
    }
    return fetchRequest(url, options)
  }
  ipcMain.handle(
    'desktop:import-file',
    async (event, backendUrl, path, destination) => {
      const frame = event.senderFrame
      const authorize = async () => {
        if (
          backendUrl !== backend ||
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
          throw new Error('Untrusted native import request')
        }
      }
      await authorize()
      return importNativeFile(backend, path, destination, project, authorize)
    },
  )
  await window.loadURL(origin)
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => server.close())
})
