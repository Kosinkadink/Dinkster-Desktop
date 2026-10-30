import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, createWriteStream, openSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

const source = process.env.DINKSTER_ENGINE_SOURCE
const commit = process.env.DINKSTER_REF
const directory = process.env.DINKSTER_DESKTOP_VERIFY_ROOT
const nativeDialog = process.env.DINKSTER_DESKTOP_VERIFY_NATIVE_DIALOG === '1'
const networkDirectory = process.env.DINKSTER_DESKTOP_VERIFY_NETWORK_DIRECTORY
assert.ok(
  source && directory,
  'Set DINKSTER_ENGINE_SOURCE and a fresh DINKSTER_DESKTOP_VERIFY_ROOT',
)
if (networkDirectory) {
  assert.ok(nativeDialog, 'Network selection requires actual native dialogs')
  assert.ok(
    isAbsolute(networkDirectory),
    'Use an absolute mounted network path',
  )
  assert.ok(
    (await stat(networkDirectory)).isDirectory(),
    'The network directory must already exist',
  )
}
assert.match(
  commit ?? '',
  /^[a-f0-9]{40}$/,
  'DINKSTER_REF must name the exact backend checkout',
)
assert.equal(
  execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  commit,
)
const root = resolve(directory)
await mkdir(root, { recursive: false })
const data = join(root, 'data')
await mkdir(join(data, 'engine'), { recursive: true })
const mountedDirectory = join(root, 'read only input with spaces')
const mountedPath = join(mountedDirectory, 'native drop with spaces.txt')
const mountedBytes = 'mounted original bytes, not the outside same-name file'
const imagePath = join(mountedDirectory, 'native ingress.png')
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNUqzzzn4GBgQEADlQCbLCpUUgAAAAASUVORK5CYII=',
  'base64',
)
await mkdir(mountedDirectory)
await writeFile(mountedPath, mountedBytes)
await writeFile(imagePath, imageBytes)
if (process.platform !== 'win32') {
  await chmod(mountedPath, 0o444)
  await chmod(imagePath, 0o444)
}
await mkdir(join(data, 'library'), { recursive: true })
await writeFile(
  join(data, 'library', 'mounts.toml'),
  `[mounts.drop-input]\npath = ${JSON.stringify(mountedDirectory)}\n`,
)
// An explicit development source is not the packaged catalog release.
await writeFile(
  join(data, 'engine', 'selection.json'),
  JSON.stringify({ commit, variant: 'cpu' }),
)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|ELECTRON_RUN_AS_NODE|^DINKSTER_|^PYTHON|^VIRTUAL_ENV$/i.test(
        name,
      ),
  ),
)
env.DINKSTER_DESKTOP_DATA = data
env.DINKSTER_ENGINE_SOURCE = resolve(source)
env.DINKSTER_ACCELERATOR = 'cpu'
env.DINKSTER_UV = process.env.DINKSTER_UV ?? 'uv'
// The checkout launcher requires catalogs to be prepared before it starts.
const preparationLog = openSync(join(root, 'catalog-preparation.log'), 'wx')
try {
  execFileSync(
    env.DINKSTER_UV,
    [
      'run',
      '--no-sync',
      'dinkster-pack',
      'prepare-catalogs',
      '--defaults',
      '--library-root',
      join(data, 'library'),
    ],
    {
      cwd: resolve(source),
      env,
      stdio: ['ignore', preparationLog, preparationLog],
    },
  )
} finally {
  closeSync(preparationLog)
}
const stderrLog = createWriteStream(join(root, 'electron-stderr.log'), {
  flags: 'wx',
})
const stdoutLog = createWriteStream(join(root, 'electron-stdout.log'), {
  flags: 'wx',
})
let app
let electronProcess
try {
  app = await electron.launch({
    args: [fileURLToPath(new URL('../../desktop', import.meta.url))],
    chromiumSandbox: true,
    env,
    timeout: 60_000,
  })
  electronProcess = app.process()
  electronProcess.stderr.pipe(stderrLog, { end: false })
  electronProcess.stdout.pipe(stdoutLog, { end: false })
  await writeFile(
    join(root, 'electron-process.json'),
    JSON.stringify({
      launcherPid: electronProcess.pid,
      mainPid: await app.evaluate(() => process.pid),
      appLogDirectory: join(data, 'logs'),
      stdioCaptureStartedAfterLaunch: true,
    }),
  )
  const page = await app.firstWindow()
  const deadline = Date.now() + 600_000
  let status
  do {
    status = await page.evaluate(() => window.dinksterDesktop.status())
    if (status.phase === 'failed')
      throw new Error(status.error ?? status.detail)
    if (status.phase === 'running') break
    await delay(250)
  } while (Date.now() < deadline)
  assert.equal(status.phase, 'running', 'Managed backend did not become ready')
  const health = await page.evaluate(async () =>
    (await fetch('/supervisor/status', { cache: 'no-store' })).json(),
  )
  await writeFile(join(root, 'supervisor-status.json'), JSON.stringify(health))
  assert.equal(health.state, 'ready')
  const local = await page.evaluate(() =>
    window.dinksterDesktop.fileCapabilities(location.origin),
  )
  assert.equal(local.nativeFolderChoice, true)
  const initialLocations = await page.evaluate(async () => {
    const response = await fetch('/api/mounts/locations?project=default')
    if (!response.ok) throw new Error('Initial locations lookup failed')
    const project = await fetch('/api/mounts?project=default')
    if (!project.ok) throw new Error('Initial project folders lookup failed')
    return {
      ...(await response.json()),
      outputMount: (await project.json()).outputMount,
    }
  })
  assert.equal(
    Object.hasOwn(initialLocations, 'importMount'),
    true,
    'The backend must expose output and import defaults',
  )
  const defaultOutput = initialLocations.activeMounts.find(
    (mount) => mount.id === initialLocations.outputMount,
  )
  const imports = initialLocations.activeMounts.find(
    (mount) => mount.id === initialLocations.importMount,
  )
  assert.equal(defaultOutput?.path, join(data, 'library', 'output'))
  assert.equal(defaultOutput.mode, 'readwrite')
  assert.equal((await stat(defaultOutput.path)).isDirectory(), true)
  assert.equal(imports?.path, join(data, 'library', 'imports'))
  assert.equal((await stat(imports.path)).isDirectory(), true)
  const remote = await page.evaluate(() =>
    window.dinksterDesktop.fileCapabilities('https://remote.invalid'),
  )
  assert.deepEqual(remote, {
    nativeFolderChoice: false,
    reveal: false,
    resolvePath: false,
  })
  const refused = await page.evaluate(async () => {
    const bridge = window.dinksterDesktop
    const failures = []
    for (const action of [
      () => bridge.chooseDirectory('https://remote.invalid'),
      () => bridge.revealFile('https://remote.invalid', '/ungranted'),
    ]) {
      try {
        await action()
        failures.push(false)
      } catch {
        failures.push(true)
      }
    }
    return failures
  })
  assert.deepEqual(refused, [true, true])

  assert.deepEqual(
    await page.evaluate(() =>
      window.dinksterDesktop.resolveDroppedFile(
        location.origin,
        new File(['memory'], 'memory.txt'),
      ),
    ),
    { status: 'refused', reason: 'not-native-file' },
  )
  const droppedPath = join(root, 'native drop with spaces.txt')
  await writeFile(droppedPath, 'native file bytes')
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'native-drop-test'
    input.hidden = true
    document.body.append(input)
  })
  await page.locator('#native-drop-test').setInputFiles(droppedPath)
  const droppedFile = await page.evaluate(async () => {
    const file = document.getElementById('native-drop-test').files[0]
    const result = await window.dinksterDesktop.resolveDroppedFile(
      location.origin,
      file,
    )
    let remoteDenied = false
    try {
      await window.dinksterDesktop.resolveDroppedFile(
        'https://remote.invalid',
        file,
      )
    } catch {
      remoteDenied = true
    }
    return { result, remoteDenied, rendererHasPath: 'path' in file }
  })
  assert.equal(droppedFile.result.status, 'refused')
  assert.ok(
    ['not-resolvable', 'unsupported-backend'].includes(
      droppedFile.result.reason,
    ),
  )
  assert.equal(droppedFile.remoteDenied, true)
  assert.equal(droppedFile.rendererHasPath, false)
  assert.equal(JSON.stringify(droppedFile).includes(root), false)
  await writeFile(join(root, 'native-drop.json'), JSON.stringify(droppedFile))
  if (local.resolvePath) {
    assert.deepEqual(droppedFile.result, {
      status: 'refused',
      reason: 'not-resolvable',
    })
    const before = await stat(mountedPath)
    const copiesBefore = {}
    for (const name of ['vault', 'imports']) {
      copiesBefore[name] = await readdir(join(data, 'library', name), {
        recursive: true,
      })
    }
    const expectedDigest = execFileSync(
      process.platform === 'win32'
        ? join(source, '.venv', 'Scripts', 'python.exe')
        : join(source, '.venv', 'bin', 'python'),
      [
        '-c',
        'import blake3,sys; print("blake3:"+blake3.blake3(sys.argv[1].encode()).hexdigest())',
        mountedBytes,
      ],
      { encoding: 'utf8' },
    ).trim()
    const uploads = []
    const recordUpload = (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname.startsWith('/api/assets')
      )
        uploads.push(request.url())
    }
    page.on('request', recordUpload)
    await page.locator('#native-drop-test').setInputFiles(mountedPath)
    const mounted = await page.evaluate(async () => {
      const file = document.getElementById('native-drop-test').files[0]
      return {
        result: await window.dinksterDesktop.resolveDroppedFile(
          location.origin,
          file,
        ),
        rendererHasPath: 'path' in file,
      }
    })
    assert.deepEqual(mounted, {
      result: {
        status: 'resolved',
        asset: {
          digest: expectedDigest,
          name: 'native drop with spaces.txt',
          size: Buffer.byteLength(mountedBytes),
          mediaType: 'text/plain',
          virtualPath: 'mounts/drop-input/native drop with spaces.txt',
        },
      },
      rendererHasPath: false,
    })
    assert.equal(JSON.stringify(mounted).includes(root), false)
    const imageBefore = await stat(imagePath)
    const imageDigest = execFileSync(
      process.platform === 'win32'
        ? join(source, '.venv', 'Scripts', 'python.exe')
        : join(source, '.venv', 'bin', 'python'),
      [
        '-c',
        'import blake3,sys; print("blake3:"+blake3.blake3(open(sys.argv[1],"rb").read()).hexdigest())',
        imagePath,
      ],
      { encoding: 'utf8' },
    ).trim()
    const expectedImage = {
      digest: imageDigest,
      name: 'native ingress.png',
      size: imageBytes.length,
      mediaType: 'image/png',
      virtualPath: 'mounts/drop-input/native ingress.png',
    }
    const preferencesBefore = await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) =>
          /upload|destination/i.test(key),
        ),
      ),
    )
    await page.locator('#native-drop-test').setInputFiles(imagePath)
    const dropOriginalFile = async () => {
      await page.getByTestId('graph-canvas').evaluate((canvas) => {
        const file = document.getElementById('native-drop-test').files[0]
        const transfer = new DataTransfer()
        transfer.items.add(file)
        const bounds = canvas.getBoundingClientRect()
        canvas.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + 180,
            clientY: bounds.top + 140,
            dataTransfer: transfer,
          }),
        )
      })
    }
    await dropOriginalFile()
    const surface = page.getByTestId('canvas-file-drop-surface')
    await expect(surface).toContainText('Using existing file; no copy made.')
    await expect(page.getByTestId('canvas-import-confirm')).toHaveCount(0)
    const insertedImage = await page.evaluate(() => {
      const doc = window.__dinksterTest.app.activeTab().store.doc
      return Object.values(doc.graphs[doc.root].nodes).map(
        (node) => node.values.image,
      )
    })
    assert.deepEqual(insertedImage, [expectedImage])
    assert.equal(JSON.stringify(insertedImage).includes(root), false)
    assert.deepEqual(
      await page.evaluate(() =>
        Object.fromEntries(
          Object.entries(localStorage).filter(([key]) =>
            /upload|destination/i.test(key),
          ),
        ),
      ),
      preferencesBefore,
    )
    await page.screenshot({ path: join(root, 'native-ingress-no-copy.png') })
    const imageAfter = await stat(imagePath)
    assert.equal(imageAfter.ino, imageBefore.ino)
    assert.equal(imageAfter.mtimeMs, imageBefore.mtimeMs)
    assert.deepEqual(await readFile(imagePath), imageBytes)
    await page.locator('#native-drop-test').setInputFiles(mountedPath)
    // Remove project membership, not the input or grant, to prove live scope.
    await page.evaluate(async () => {
      const current = await (await fetch('/api/mounts?project=default')).json()
      const response = await fetch('/api/mounts/projects/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mounts: current.mounts
            .filter((mount) => mount.id !== 'drop-input')
            .map((mount) => mount.id),
          outputMount: current.outputMount ?? null,
        }),
      })
      if (!response.ok) throw new Error('Project exclusion failed')
    })
    const excluded = await page.evaluate(() =>
      window.dinksterDesktop.resolveDroppedFile(
        location.origin,
        document.getElementById('native-drop-test').files[0],
      ),
    )
    assert.deepEqual(excluded, { status: 'refused', reason: 'not-resolvable' })
    page.off('request', recordUpload)
    assert.deepEqual(uploads, [])
    const after = await stat(mountedPath)
    assert.equal(after.ino, before.ino)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(await readFile(mountedPath, 'utf8'), mountedBytes)
    for (const name of ['vault', 'imports']) {
      assert.deepEqual(
        await readdir(join(data, 'library', name), { recursive: true }),
        copiesBefore[name],
      )
    }
    await writeFile(
      join(root, 'mounted-native-drop.json'),
      JSON.stringify(
        {
          backendCommit: commit,
          mounted,
          excluded,
          assetUploadRequests: uploads.length,
          inputUnchanged: true,
          vaultAndImportsUnchanged: true,
        },
        null,
        2,
      ),
    )
    await page.locator('#native-drop-test').setInputFiles(imagePath)
    page.on('request', recordUpload)
    await dropOriginalFile()
    const confirmation = page.getByTestId('canvas-import-confirm')
    await expect(confirmation).toBeVisible()
    assert.deepEqual(uploads, [])
    await page.screenshot({
      path: join(root, 'native-ingress-confirm-copy.png'),
    })
    // Clone the real response before Electron's inspector can evict its body.
    await page.evaluate(() => {
      const originalFetch = window.fetch
      window.__nativeUploadBody = new Promise((resolve, reject) => {
        window.fetch = async (...args) => {
          const response = await originalFetch(...args)
          if (
            new URL(response.url).pathname === '/api/assets/media' &&
            args[1]?.method === 'POST'
          ) {
            window.fetch = originalFetch
            // The caller aborts its signal after consuming the original body.
            // Finish observing the clone before handing the response back.
            try {
              resolve(await response.clone().json())
            } catch (error) {
              reject(error)
            }
          }
          return response
        }
      })
    })
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/assets/media',
    )
    await confirmation.click()
    const uploadResponse = await response
    assert.equal(uploadResponse.status(), 201)
    const { asset: uploadedImage } = await page.evaluate(
      () => window.__nativeUploadBody,
    )
    await expect
      .poll(() =>
        page.evaluate(() => {
          const doc = window.__dinksterTest.app.activeTab().store.doc
          return Object.values(doc.graphs[doc.root].nodes).map(
            (node) => node.values.image,
          )
        }),
      )
      .toEqual([expectedImage, uploadedImage])
    page.off('request', recordUpload)
    assert.equal(uploads.length, 1)
    assert.deepEqual(await readFile(imagePath), imageBytes)
    await writeFile(
      join(root, 'native-ingress.json'),
      JSON.stringify(
        {
          backendCommit: commit,
          resolved: expectedImage,
          grantedUploadRequests: 0,
          excludedConfirmedUploadRequests: uploads.length,
          resolvedPreferencesUnchanged: true,
          originalBytesUnchanged: true,
          rendererDocumentHasNativePath: false,
        },
        null,
        2,
      ),
    )
  }
  await page.evaluate(() =>
    document.getElementById('native-drop-test').remove(),
  )

  const chosen = join(root, 'local folder with spaces')
  await mkdir(chosen)
  if (nativeDialog) {
    console.log(`Select this folder in the native dialog: ${chosen}`)
    assert.equal(
      await page.evaluate(() =>
        window.dinksterDesktop.chooseDirectory(location.origin),
      ),
      chosen,
    )
    console.log('Cancel the next native folder dialog')
    assert.equal(
      await page.evaluate(() =>
        window.dinksterDesktop.chooseDirectory(location.origin),
      ),
      undefined,
    )
    if (networkDirectory) {
      console.log(`Select this existing network folder: ${networkDirectory}`)
      assert.equal(
        await page.evaluate(() =>
          window.dinksterDesktop.chooseDirectory(location.origin),
        ),
        networkDirectory,
      )
    }
  }
  // Script dialog outcomes, not the IPC bridge or backend: cancellation and
  // raw native paths must survive the real renderer/main transport unchanged.
  await app.evaluate(({ dialog }, path) => {
    globalThis.originalOpenDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, chosen)
  await page.getByTestId('desktop-management-button').click()
  const chooser = page.getByRole('button', {
    name: 'Choose folder',
    exact: true,
  })
  const folderSection = page.locator('.desktop-management-section').filter({
    has: page.getByRole('heading', {
      name: 'Existing model folders',
      exact: true,
    }),
  })
  await expect(chooser).toBeEnabled()
  await folderSection.screenshot({
    path: join(root, 'folder-choice-ready.png'),
  })
  await chooser.click()
  await expect(page.locator('.desktop-mount-form code')).toHaveText(chosen)
  await expect(page.locator('#desktop-mount-id')).toHaveValue(
    'local-folder-with-spaces',
  )
  await folderSection.screenshot({
    path: join(root, 'folder-choice-selected.png'),
  })
  const grantsBeforeCancel = await page.evaluate(async () =>
    (await (await fetch('/api/mounts?project=default')).json()).mounts.map(
      (mount) => mount.id,
    ),
  )
  await app.evaluate(({ dialog }) => {
    globalThis.folderDialogCanceled = false
    dialog.showOpenDialog = async () => {
      globalThis.folderDialogCanceled = true
      return { canceled: true, filePaths: [] }
    }
  })
  await chooser.click()
  await expect
    .poll(() => app.evaluate(() => globalThis.folderDialogCanceled))
    .toBe(true)
  await expect(chooser).toBeEnabled()
  assert.deepEqual(
    await page.evaluate(async () =>
      (await (await fetch('/api/mounts?project=default')).json()).mounts.map(
        (mount) => mount.id,
      ),
    ),
    grantsBeforeCancel,
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('Native folder dialog failed')
    }
  })
  await chooser.click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Native folder dialog failed' }),
  ).toBeVisible()
  await folderSection.screenshot({
    path: join(root, 'folder-choice-error.png'),
  })
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.originalOpenDialog
  })
  await page.keyboard.press('Escape')
  await expect(chooser).not.toBeVisible()

  const untrusted = await app.evaluate(
    async ({ BrowserWindow, app }, { origin, path }) => {
      const child = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}/dist/preload.cjs`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      try {
        await child.loadURL(origin)
        await child.webContents.executeJavaScript(`{
          const input = document.createElement('input');
          input.type = 'file'; input.id = 'untrusted-drop-test';
          document.body.append(input);
        }`)
        child.webContents.debugger.attach('1.3')
        const document =
          await child.webContents.debugger.sendCommand('DOM.getDocument')
        const input = await child.webContents.debugger.sendCommand(
          'DOM.querySelector',
          { nodeId: document.root.nodeId, selector: '#untrusted-drop-test' },
        )
        await child.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
          nodeId: input.nodeId,
          files: [path],
        })
        return await child.webContents.executeJavaScript(`(async () => {
          const bridge = window.dinksterDesktop
          const results = []
          for (const action of [
            () => bridge.chooseDirectory(location.origin),
            () => bridge.revealFile(location.origin, '/ungranted'),
            () => bridge.resolveDroppedFile(location.origin, document.getElementById('untrusted-drop-test').files[0]),
          ]) {
            try { await action(); results.push('accepted') }
            catch (error) { results.push(String(error)) }
          }
          return { capabilities: await bridge.fileCapabilities(location.origin), results }
        })()`)
      } finally {
        child.destroy()
      }
    },
    { origin: page.url(), path: droppedPath },
  )
  await writeFile(
    join(root, 'untrusted-sender.json'),
    JSON.stringify(untrusted),
  )
  assert.deepEqual(untrusted.capabilities, {
    nativeFolderChoice: false,
    reveal: false,
    resolvePath: false,
  })
  assert.equal(untrusted.results.length, 3)
  for (const rejection of untrusted.results)
    assert.match(rejection, /untrusted renderer/)

  // Nested frames must not receive their own native-capability bridge.
  const attached = page.waitForEvent('frameattached')
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.id = 'native-capability-frame'
    frame.src = location.origin
    document.body.append(frame)
  })
  const subframe = await attached
  await subframe.waitForLoadState('domcontentloaded')
  assert.equal(
    await subframe.evaluate(() => typeof window.dinksterDesktop),
    'undefined',
  )
  await page.evaluate(() =>
    document.getElementById('native-capability-frame').remove(),
  )

  const configuredOutput = join(root, 'existing custom output')
  await mkdir(configuredOutput)
  await writeFile(join(configuredOutput, 'keep.txt'), 'existing output bytes')
  await page.evaluate(async (path) => {
    const added = await fetch('/api/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-output', path, mode: 'readwrite' }),
    })
    if (!added.ok) throw new Error('Custom output grant failed')
    const selected = await fetch('/api/mounts/output', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom-output' }),
    })
    if (!selected.ok) throw new Error('Custom output selection failed')
    const current = await (await fetch('/api/mounts?project=default')).json()
    const project = await fetch('/api/mounts/projects/default', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mounts: current.mounts.map((mount) => mount.id),
        outputMount: 'custom-output',
      }),
    })
    if (!project.ok) throw new Error('Custom project output selection failed')
  }, configuredOutput)
  // Restart the real backend while the dialog is pending. Cached shell status
  // remains running, but the returned path must lose native authority.
  await app.evaluate(
    ({ dialog }, { origin, path }) => {
      dialog.showOpenDialog = async () => {
        const response = await fetch(`${origin}/supervisor/engine/restart`, {
          method: 'POST',
        })
        const status = await response.json()
        if (!response.ok || status.state !== 'starting') {
          throw new Error('Backend restart did not enter the starting state')
        }
        return { canceled: false, filePaths: [path] }
      }
    },
    { origin: new URL(page.url()).origin, path: chosen },
  )
  const restartRejection = await page.evaluate(async () => {
    try {
      await window.dinksterDesktop.chooseDirectory(location.origin)
      return 'accepted'
    } catch (error) {
      return String(error)
    }
  })
  assert.match(restartRejection, /shell-managed backend changed/)
  assert.equal(
    (await page.evaluate(() => window.dinksterDesktop.status())).phase,
    'running',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.originalOpenDialog
  })
  const restartDeadline = Date.now() + 600_000
  let recovered
  do {
    recovered = await page.evaluate(async () =>
      (await fetch('/supervisor/status', { cache: 'no-store' })).json(),
    )
    if (recovered.state === 'failed') throw new Error(recovered.detail)
    if (recovered.state === 'ready') break
    await delay(250)
  } while (Date.now() < restartDeadline)
  assert.equal(recovered.state, 'ready')
  assert.equal(recovered.instance, health.instance)
  assert.notEqual(recovered.engine.pid, health.engine.pid)
  assert.equal(
    (
      await page.evaluate(() =>
        window.dinksterDesktop.fileCapabilities(location.origin),
      )
    ).nativeFolderChoice,
    true,
  )
  await writeFile(
    join(root, 'restart-during-choice.json'),
    JSON.stringify({ rejection: restartRejection, recovered }),
  )
  const restartedLocations = await page.evaluate(async () => {
    const response = await fetch('/api/mounts/locations?project=default')
    if (!response.ok) throw new Error('Restarted locations lookup failed')
    const project = await fetch('/api/mounts?project=default')
    if (!project.ok) throw new Error('Restarted project folders lookup failed')
    return {
      ...(await response.json()),
      outputMount: (await project.json()).outputMount,
    }
  })
  assert.equal(restartedLocations.outputMount, 'custom-output')
  const output = restartedLocations.activeMounts.find(
    (mount) => mount.id === restartedLocations.outputMount,
  )
  assert.equal(output?.path, configuredOutput)
  assert.equal(
    await readFile(join(configuredOutput, 'keep.txt'), 'utf8'),
    'existing output bytes',
  )
  await writeFile(
    join(root, 'managed-output.json'),
    JSON.stringify(
      {
        backendCommit: commit,
        freshVisibleOutput: true,
        namedImportTargetVerified: true,
        configuredOutputPreserved: true,
        existingBytesPreserved: true,
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(root, 'local-files.json'),
    JSON.stringify(
      {
        backendCommit: commit,
        nativeFolderDialogVerified: nativeDialog,
        ...(nativeDialog ? { nativeFolderPath: chosen } : {}),
        scriptedDialogOutcomes: true,
        nativeNetworkPathsVerified: nativeDialog && Boolean(networkDirectory),
        ...(networkDirectory
          ? { nativeNetworkFolderPath: networkDirectory }
          : {}),
        nativeFolderChoice: true,
        reveal: local.reveal,
        remoteDenied: true,
        cancellation: true,
        errorsVisible: true,
        untrustedSenderDenied: true,
        subframeBridgeAbsent: true,
        restartDuringChoiceDenied: true,
      },
      null,
      2,
    ),
  )
} catch (error) {
  await writeFile(join(root, 'harness-error.txt'), String(error.stack ?? error))
  throw error
} finally {
  try {
    if (app) await app.close()
  } finally {
    electronProcess?.stderr.unpipe(stderrLog)
    electronProcess?.stdout.unpipe(stdoutLog)
    stderrLog.end()
    stdoutLog.end()
    await Promise.all([finished(stderrLog), finished(stdoutLog)])
  }
}
console.log(
  nativeDialog
    ? 'Real managed backend, native folder dialogs and IPC checks passed'
    : 'Real managed backend and native-file IPC checks passed; native dialog outcomes were scripted',
)
