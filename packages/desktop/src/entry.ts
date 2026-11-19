import { app, dialog } from 'electron'
import { parseDesktopServices } from './services.js'

let validServices = true
try {
  parseDesktopServices(process.argv)
} catch (error) {
  validServices = false
  const detail = error instanceof Error ? error.message : String(error)
  if (process.platform === 'darwin') {
    // A synchronous startup alert blocks macOS accessibility and dismissal.
    void app.whenReady().then(async () => {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Invalid hosted services',
        message: 'Invalid hosted services',
        detail,
        buttons: ['OK'],
      })
      app.exit(1)
    })
  } else {
    dialog.showErrorBox('Invalid hosted services', detail)
    app.exit(1)
  }
}

// Invalid launches must not register protocols or initialize application state.
if (validServices) await import('./main.js')
