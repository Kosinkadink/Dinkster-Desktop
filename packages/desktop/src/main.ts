import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, screen, session, shell, Tray } from 'electron'
import updater from 'electron-updater'
import { applicationIcon, showAbout, trayIcon, windowBackground } from './branding.js'
import { defaultDataDirectory, desktopStorageBytes, redactDiagnosticText, systemCheck } from './desktop-manager.js'
import { acquireLifecycleLease, type LifecycleLease } from './lifecycle-lease.js'
import { LifecycleQueue } from './lifecycle-queue.js'
import { HomeProcess, type HomeStatus } from './home-process.js'
import { isTrustedDesktopIpc } from './ipc-security.js'
import { assetLocations, chooseDirectory, dropResolutionSupported, requireLocalFiles, resolveDroppedPath, revealGrantedFile, revealModelLocation } from './local-files.js'
import { saveFile } from './save-file.js'
import { CredentialStore, credentialOrigin, hasAuthorizationHeader, type CredentialCipher } from './credential-store.js'
import { deepLinkFromArgv, parseDeepLink } from './deep-link.js'
import { RotatingLog } from './rotating-log.js'
import { RemoteWorkerFileGrants, RemoteWorkerLifecycle } from './remote-workers.js'
import { desktopTitle, parseDesktopServices } from './services.js'
import { ShellUpdater } from './shell-updater.js'
import { EnvironmentClient } from './environment.js'
import { WslHost, wslLinuxPath } from './wsl.js'
import toolsRelease from './environment-tools-release.json' with { type: 'json' }
import { denyRendererPermissions, secureWebPreferences } from './security.js'
import { installWindowChrome, readWindowChrome, windowChromeOptions } from './window-chrome.js'
import {
  addChildWindow, addWorkspaceWindow, defaultWindowLayout, normalizeWindowBounds,
  readWindowLayout, removeWindow, restoreChildWindows, setWorkspaceProject,
  updateWindowPlacement, validProjectId, writeWindowLayout,
  type ChildWindow, type WindowLayout, type WorkspaceWindow,
} from './window-layout.js'
import type { DesktopDeepLink, DesktopInfo, DesktopPanelPlacement, DesktopWindowContext, DesktopWindowLayout } from './types.js'

const { autoUpdater } = updater
const services = parseDesktopServices(process.argv)
process.env['DINKSTER_SERVICES'] = services
const dataDirectory = process.env['DINKSTER_DESKTOP_DATA'] ?? defaultDataDirectory()
const appDirectory = app.isPackaged ? join(process.resourcesPath, 'app') : join(app.getAppPath(), '..', 'app', 'dist')
const tools = app.isPackaged ? {
  manifest: join(process.resourcesPath, 'tools', toolsRelease.manifest.name),
  sha256: toolsRelease.manifest.sha256,
  release: join(process.resourcesPath, 'tools'),
} : {
  label: toolsRelease.label,
  manifest: `https://releases.dinkster.org/tools/${toolsRelease.label}/tools-manifest.json`,
  sha256: toolsRelease.manifest.sha256,
  release: `https://releases.dinkster.org/tools/${toolsRelease.label}`,
}
const home = new HomeProcess({ frontend: appDirectory, dataDirectory, tools })
let homeIdentity: HomeStatus | undefined
const wslHost = new WslHost(dataDirectory, tools)
if (app.isPackaged && process.platform === 'win32') {
  process.env['DINKSTER_MXC_EXECUTABLE'] = join(process.resourcesPath, 'sandbox', 'wxc-exec.exe')
}
const environmentClient = new EnvironmentClient(undefined, undefined, undefined, {
  ...tools, cacheRoot: join(app.getPath('userData'), 'environment-tools'),
}, app.isPackaged ? app.getVersion() : undefined, wslHost)
const chrome = readWindowChrome(join(appDirectory, 'site'))
const windows = new Map<string, BrowserWindow>()
const documents = new Map<string, { origin: string }>()
const frontendOrigins = new Set([new URL(home.url).origin])
const redockingWindows = new Set<string>()
const pendingDeepLinks = new Map<string, DesktopDeepLink[]>()
const preReadyLinks: DesktopDeepLink[] = []
const remoteWorkerFileGrants = new RemoteWorkerFileGrants()
const lifecycleQueue = new LifecycleQueue()
const windowQueue = new LifecycleQueue()
const layoutPersistenceQueue = new LifecycleQueue()
const shellLog = new RotatingLog(join(dataDirectory, 'logs', 'desktop.log'))
const shellUpdater = new ShellUpdater({
  target: autoUpdater, dataDirectory, currentVersion: app.getVersion(),
  updateFeed: process.env['DINKSTER_UPDATE_FEED_URL'], packaged: app.isPackaged,
  diagnostic: (message) => { void shellLog.append(message) },
})
const remoteWorkerLifecycle = new RemoteWorkerLifecycle(
  dataDirectory, remoteWorkerFileGrants, serializeLifecycle,
  () => { throw new Error('Remote engines are not yet connected to project engines') },
  async () => { throw new Error('Remote engines are not yet connected to project engines') },
)
let windowLayout: WindowLayout = defaultWindowLayout()
let layoutWriteTimer: ReturnType<typeof setTimeout> | undefined
let lifecycleLease: LifecycleLease | undefined
let credentialStore: CredentialStore | undefined
let tray: Tray | undefined
let quitting = false
let windowsReady = false
let keepRunning = false

function serializeLifecycle<T>(action: () => Promise<T>): Promise<T> {
  return lifecycleQueue.run(action)
}

function senderWindowId(event: Electron.IpcMainInvokeEvent): string {
  const entry = [...windows].find(([, managed]) => managed.webContents === event.sender)
  if (!entry) throw new Error('window is not registered')
  return entry[0]
}

function trustedIpc(event: Electron.IpcMainInvokeEvent): void {
  const id = senderWindowId(event)
  const managed = windows.get(id)!
  if (quitting || !isTrustedDesktopIpc(managed.webContents, managed.webContents.mainFrame,
    documents.get(id)?.origin, event.sender, event.senderFrame)) {
    throw new Error('desktop capability denied for an untrusted renderer')
  }
}

async function currentHome(): Promise<HomeStatus> {
  const status = await home.status()
  if (!status || !homeIdentity || status.supervisor.pid !== homeIdentity.supervisor.pid || status.instance !== homeIdentity.instance) {
    throw new Error('The Dinkster process changed; reopen Desktop')
  }
  return status
}

async function managedFiles(event: Electron.IpcMainInvokeEvent, backendUrl: unknown): Promise<{
  url: string; project: string; distribution?: string; revalidate(): Promise<void>
}> {
  trustedIpc(event)
  const href = event.senderFrame!.url
  const project = new URL(href).searchParams.get('dinksterProject')
  if (!validProjectId(project)) throw new Error('Invalid folder-project context')
  requireLocalFiles(backendUrl, href, true)
  await home.ownedStatus(project)
  // Root, engine and loopback identity do not establish filesystem authority.
  throw new Error('Native file access requires authoritative execution-host and filesystem provenance')
}

function windowContext(id: string): DesktopWindowContext {
  const workspace = windowLayout.workspaces.find((candidate) => candidate.id === id)
  if (workspace) return { id: workspace.id, kind: 'primary' }
  const child = windowLayout.children.find((candidate) => candidate.id === id)
  if (!child) throw new Error('window is not registered')
  return child.kind === 'workflow' ? { id: child.id, kind: 'workflow', workflowId: child.workflowId }
    : { id: child.id, kind: 'panel', panelId: child.panelId, returnPlacement: child.returnPlacement }
}

function windowProject(id: string): string | undefined {
  return windowLayout.workspaces.find((workspace) => workspace.id === id)?.projectId
    ?? windowLayout.children.find((child) => child.id === id)?.projectId
}

function publicWindowLayout(projectId: string | undefined): DesktopWindowLayout {
  return { windows: [
    ...windowLayout.workspaces.filter((workspace) => workspace.projectId === projectId).map((workspace) => workspace.id),
    ...windowLayout.children.filter((child) => child.projectId === projectId).map((child) => child.id),
  ].map(windowContext) }
}

function broadcastToWindows(channel: string, value: (id: string) => unknown): void {
  for (const [id, managed] of windows) {
    if (!managed.isDestroyed() && !managed.webContents.isDestroyed()) managed.webContents.send(channel, value(id))
  }
}

function sendWindowLayout(): void {
  broadcastToWindows('desktop:window-layout-changed', (id) => publicWindowLayout(windowProject(id)))
}

function persistWindowLayout(): Promise<void> {
  return layoutPersistenceQueue.run(() => writeWindowLayout(dataDirectory, windowLayout))
}

function scheduleWindowLayoutWrite(): void {
  if (layoutWriteTimer !== undefined) clearTimeout(layoutWriteTimer)
  layoutWriteTimer = setTimeout(() => {
    layoutWriteTimer = undefined
    void persistWindowLayout().catch(logFailure)
  }, 250)
}

function logFailure(error: unknown): void {
  void shellLog.append(redactDiagnosticText(error instanceof Error ? error.stack ?? error.message : String(error)))
}

async function desktopInfo(): Promise<DesktopInfo> {
  return { appVersion: app.getVersion(), storageBytes: await desktopStorageBytes(dataDirectory), update: shellUpdater.status }
}

async function sendInfo(): Promise<void> {
  const info = await desktopInfo()
  broadcastToWindows('desktop:info-changed', () => info)
}

async function shutdown(): Promise<void> {
  if (quitting) return
  quitting = true
  await windowQueue.run(async () => {})
  try {
    await home.stop()
    await environmentClient.dispose()
    if (layoutWriteTimer !== undefined) clearTimeout(layoutWriteTimer)
    await persistWindowLayout()
    for (const managed of windows.values()) managed.destroy()
    windows.clear()
    documents.clear()
    tray?.destroy()
    await lifecycleLease?.release()
    lifecycleLease = undefined
    app.exit(0)
  } catch (error) {
    quitting = false
    logFailure(error)
    await dialog.showMessageBox({ type: 'error', title: 'Dinkster could not quit',
      message: 'Dinkster could not stop every process it started.', detail: 'Desktop is still running. Inspect its support report before trying Quit again.' })
  }
}

function displayWorkAreas(): readonly { x: number; y: number; width: number; height: number; primary?: boolean }[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display) => ({ ...display.workArea, ...(display.id === primaryId ? { primary: true } : {}) }))
}

function placementFor(id: string): WorkspaceWindow | ChildWindow {
  const found = windowLayout.workspaces.find((candidate) => candidate.id === id) ?? windowLayout.children.find((candidate) => candidate.id === id)
  if (!found) throw new Error('window placement is not registered')
  return found
}

function queryFor(id: string): string {
  const context = windowContext(id)
  const params = new URLSearchParams({ dinksterWindow: context.id, dinksterWindowKind: context.kind })
  if (context.kind === 'workflow') params.set('dinksterWorkflow', context.workflowId)
  if (context.kind === 'panel') params.set('dinksterPanel', context.panelId)
  const project = windowProject(id)
  if (project) params.set('dinksterProject', project)
  return params.toString()
}

async function createManagedWindow(id: string): Promise<BrowserWindow> {
  const placement = placementFor(id)
  const bounds = normalizeWindowBounds(placement.bounds, displayWorkAreas())
  windowLayout = updateWindowPlacement(windowLayout, id, { bounds })
  const managed = new BrowserWindow({
    ...windowChromeOptions(chrome), ...bounds, minWidth: Math.min(900, bounds.width), minHeight: Math.min(640, bounds.height),
    show: false, title: desktopTitle(services), icon: applicationIcon(), backgroundColor: windowBackground(),
    webPreferences: secureWebPreferences(join(app.getAppPath(), 'dist', 'preload.cjs')),
  })
  installWindowChrome(managed, chrome, undefined, services)
  managed.on('page-title-updated', (event) => event.preventDefault())
  windows.set(id, managed)
  documents.set(id, { origin: new URL(home.url).origin })
  denyRendererPermissions(managed.webContents.session)
  managed.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const bindDocument = (address: string): void => {
    const origin = new URL(address).origin
    if (!frontendOrigins.has(origin)) return
    documents.set(id, { origin })
    if (windowLayout.workspaces.some((workspace) => workspace.id === id)) {
      const project = new URL(address).searchParams.get('dinksterProject') ?? undefined
      if (project === undefined || validProjectId(project)) {
        windowLayout = setWorkspaceProject(windowLayout, id, project)
        scheduleWindowLayoutWrite()
        sendWindowLayout()
      }
    }
  }
  managed.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) documents.delete(id)
  })
  managed.webContents.on('did-navigate', (_event, address) => bindDocument(address))
  managed.webContents.on('did-navigate-in-page', (_event, address, mainFrame) => { if (mainFrame) bindDocument(address) })
  managed.webContents.on('will-navigate', (event, address) => {
    if (new URL(address).origin === new URL(home.url).origin) return
    event.preventDefault()
    void currentHome().then(async (status) => {
      const selected = status.installationFrontend && new URL(status.installationFrontend)
      const target = new URL(address)
      if (!selected || selected.protocol !== 'http:' || selected.hostname !== '127.0.0.1'
        || target.username || target.password || target.origin !== selected.origin || managed.isDestroyed()) return
      frontendOrigins.add(selected.origin)
      await managed.loadURL(address)
    }).catch(logFailure)
  })
  managed.webContents.on('will-redirect', (event, address) => {
    if (new URL(address).origin !== documents.get(id)?.origin) event.preventDefault()
  })
  managed.once('ready-to-show', () => {
    if (placement.maximized) managed.maximize()
    managed.show()
  })
  const recordPlacement = (): void => {
    if (managed.isDestroyed() || managed.isMaximized()) return
    windowLayout = updateWindowPlacement(windowLayout, id, { bounds: managed.getBounds() })
    scheduleWindowLayoutWrite()
  }
  managed.on('move', recordPlacement)
  managed.on('resize', recordPlacement)
  managed.on('maximize', () => { windowLayout = updateWindowPlacement(windowLayout, id, { maximized: true }); scheduleWindowLayoutWrite() })
  managed.on('unmaximize', () => { windowLayout = updateWindowPlacement(windowLayout, id, { maximized: false, bounds: managed.getBounds() }); scheduleWindowLayoutWrite() })
  managed.on('close', (event) => {
    if (quitting) return
    if (id === 'primary') {
      event.preventDefault()
      if (keepRunning) managed.hide()
      else setImmediate(() => { void serializeLifecycle(shutdown) })
      return
    }
    remoteWorkerFileGrants.revokeWindow(id)
    if (redockingWindows.delete(id)) return
    windows.delete(id)
    documents.delete(id)
    pendingDeepLinks.delete(id)
    windowLayout = removeWindow(windowLayout, id)
    scheduleWindowLayoutWrite()
    queueMicrotask(sendWindowLayout)
  })
  const url = new URL(home.url)
  url.search = queryFor(id)
  try { await managed.loadURL(url.toString()) }
  catch (error) { windows.delete(id); documents.delete(id); managed.destroy(); throw error }
  return managed
}

async function createWindows(): Promise<void> {
  homeIdentity = await home.start()
  const primary = screen.getPrimaryDisplay().workArea
  windowLayout = await readWindowLayout(dataDirectory, defaultWindowLayout({
    x: primary.x + Math.max(0, Math.floor((primary.width - 1440) / 2)),
    y: primary.y + Math.max(0, Math.floor((primary.height - 900) / 2)),
    width: Math.min(1440, primary.width), height: Math.min(900, primary.height),
  }))
  await createManagedWindow('primary')
  let restoreFailed = false
  for (const workspace of windowLayout.workspaces) {
    if (workspace.id === 'primary') continue
    try { await createManagedWindow(workspace.id) }
    catch (error) { windowLayout = removeWindow(windowLayout, workspace.id); restoreFailed = true; logFailure(error) }
  }
  const restored = await restoreChildWindows(windowLayout, (child) => createManagedWindow(child.id).then(() => undefined))
  windowLayout = restored.layout
  for (const failure of restored.failures) { restoreFailed = true; logFailure(failure.error) }
  if (restoreFailed) await persistWindowLayout()
  windowsReady = true
  sendWindowLayout()
  const initial = deepLinkFromArgv(process.argv)
  if (initial) preReadyLinks.push(initial)
  for (const link of preReadyLinks.splice(0)) await routeDeepLink(link)
  if (homeIdentity.frontend !== appDirectory) {
    void dialog.showMessageBox({ type: 'info', title: 'Using the running Dinkster frontend',
      message: 'Dinkster is already running with a different frontend.',
      detail: 'Desktop is showing the running process\'s frontend, not replacing it with its bundled frontend.' })
  }
}

function validAssignmentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

async function openChildWindow(child: ChildWindow): Promise<void> {
  windowLayout = addChildWindow(windowLayout, child)
  try { await persistWindowLayout(); await createManagedWindow(child.id) }
  catch (error) { windowLayout = removeWindow(windowLayout, child.id); await persistWindowLayout().catch(() => {}); throw error }
  sendWindowLayout()
}

async function openWorkspaceWindow(projectId: string | undefined, base: { x: number; y: number; width: number; height: number }): Promise<WorkspaceWindow> {
  const workspace: WorkspaceWindow = {
    id: `workspace-${randomUUID()}`,
    bounds: normalizeWindowBounds({ x: base.x + 48, y: base.y + 48, width: base.width, height: base.height }, displayWorkAreas()),
    maximized: false, ...(projectId ? { projectId } : {}),
  }
  windowLayout = addWorkspaceWindow(windowLayout, workspace)
  try { await persistWindowLayout(); await createManagedWindow(workspace.id) }
  catch (error) { windowLayout = removeWindow(windowLayout, workspace.id); await persistWindowLayout().catch(() => {}); throw error }
  sendWindowLayout()
  return workspace
}

function desktopCredentialCipher(): CredentialCipher {
  return { available: () => safeStorage.isEncryptionAvailable(), encrypt: (plain) => safeStorage.encryptString(plain), decrypt: (blob) => safeStorage.decryptString(blob) }
}

function requestOrigin(url: string): string | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  const protocol = parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol
  return protocol === 'http:' || protocol === 'https:' ? `${protocol}//${parsed.host}` : undefined
}

function applyCredentialHeaders(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const origin = requestOrigin(details.url)
    const secret = origin !== undefined ? credentialStore?.secretFor(origin) : undefined
    if (secret !== undefined && !hasAuthorizationHeader(details.requestHeaders)) details.requestHeaders['Authorization'] = `Bearer ${secret}`
    callback({ requestHeaders: details.requestHeaders })
  })
}

function routeDeepLink(link: DesktopDeepLink): Promise<void> {
  if (!windowsReady) { preReadyLinks.push(link); return Promise.resolve() }
  return windowQueue.run(async () => {
    const project = link.projectId
    let target = windowLayout.workspaces.find((workspace) => workspace.projectId === project && windows.has(workspace.id))
    if (!target) target = await openWorkspaceWindow(project, windows.get('primary')?.getBounds() ?? { x: 80, y: 80, width: 1280, height: 800 })
    const queue = pendingDeepLinks.get(target.id) ?? []
    queue.push(link)
    pendingDeepLinks.set(target.id, queue)
    const managed = windows.get(target.id)
    if (managed && !managed.isDestroyed()) { managed.show(); managed.focus(); managed.webContents.send('desktop:deep-link-pending') }
  }).catch(logFailure)
}

ipcMain.handle('desktop:locale', (event) => { trustedIpc(event); return app.getLocale() })
ipcMain.handle('desktop:info', (event) => { trustedIpc(event); return desktopInfo() })
ipcMain.handle('desktop:window-context', (event) => { trustedIpc(event); return windowContext(senderWindowId(event)) })
ipcMain.handle('desktop:window-layout', (event) => { trustedIpc(event); return publicWindowLayout(windowProject(senderWindowId(event))) })
ipcMain.handle('desktop:open-workflow-window', (event, workflowId: unknown, x: unknown, y: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  if (!validAssignmentId(workflowId)) throw new Error('invalid workflow id')
  const senderId = senderWindowId(event)
  const project = windowProject(senderId)
  const existing = windowLayout.children.find((child) => child.kind === 'workflow' && child.workflowId === workflowId && child.projectId === project)
  if (existing) { windows.get(existing.id)?.show(); windows.get(existing.id)?.focus(); return }
  const current = windows.get(senderId)!.getBounds()
  const left = typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : current.x + 48
  const top = typeof y === 'number' && Number.isFinite(y) ? Math.round(y) : current.y + 48
  await openChildWindow({ id: `workflow-${randomUUID()}`, kind: 'workflow', workflowId,
    bounds: normalizeWindowBounds({ x: left, y: top, width: current.width, height: current.height }, displayWorkAreas()),
    maximized: false, ...(project ? { projectId: project } : {}) })
}))
ipcMain.handle('desktop:open-panel-window', (event, panelId: unknown, returnPlacement: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  if (!validAssignmentId(panelId) || (returnPlacement !== 'dock' && returnPlacement !== 'rail' && returnPlacement !== 'bottom')) throw new Error('invalid panel window request')
  const senderId = senderWindowId(event)
  const project = windowProject(senderId)
  const existing = windowLayout.children.find((child) => child.kind === 'panel' && child.panelId === panelId && child.projectId === project)
  if (existing) { windows.get(existing.id)?.show(); windows.get(existing.id)?.focus(); return }
  const current = windows.get(senderId)!.getBounds()
  await openChildWindow({ id: `panel-${randomUUID()}`, kind: 'panel', panelId, returnPlacement: returnPlacement as DesktopPanelPlacement,
    bounds: normalizeWindowBounds({ x: current.x + 64, y: current.y + 64, width: Math.min(900, current.width), height: Math.min(700, current.height) }, displayWorkAreas()),
    maximized: false, ...(project ? { projectId: project } : {}) })
}))
ipcMain.handle('desktop:redock-window', (event) => windowQueue.run(async () => {
  trustedIpc(event)
  const id = senderWindowId(event)
  if (windowLayout.workspaces.some((workspace) => workspace.id === id)) return
  const managed = windows.get(id)
  redockingWindows.add(id)
  windows.delete(id)
  documents.delete(id)
  windowLayout = removeWindow(windowLayout, id)
  try { await persistWindowLayout() }
  catch (error) { scheduleWindowLayoutWrite(); throw error }
  finally { if (managed && !managed.isDestroyed()) managed.close(); redockingWindows.delete(id); sendWindowLayout() }
}))
ipcMain.handle('desktop:switch-project', (event, projectId: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  const id = senderWindowId(event)
  if (!windowLayout.workspaces.some((workspace) => workspace.id === id)) throw new Error('projects are switched from a workspace window')
  if (!validProjectId(projectId)) throw new Error('invalid project id')
  const next = projectId
  if (windowProject(id) === next) return
  const previousProject = windowProject(id)
  windowLayout = setWorkspaceProject(windowLayout, id, next)
  try {
    await persistWindowLayout()
    const url = new URL(home.url)
    url.search = queryFor(id)
    await windows.get(id)?.loadURL(url.toString())
  } catch (error) {
    if (windowLayout.workspaces.some((workspace) => workspace.id === id)) {
      windowLayout = setWorkspaceProject(windowLayout, id, previousProject)
      await persistWindowLayout().catch(() => {})
      const url = new URL(home.url)
      url.search = queryFor(id)
      await windows.get(id)?.loadURL(url.toString()).catch(() => {})
    }
    throw error
  }
  sendWindowLayout()
}))
ipcMain.handle('desktop:open-project-window', (event, projectId: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  if (!validProjectId(projectId)) throw new Error('invalid project id')
  await openWorkspaceWindow(projectId, windows.get(senderWindowId(event))!.getBounds())
}))
ipcMain.handle('desktop:take-deep-links', (event) => {
  trustedIpc(event)
  const id = senderWindowId(event)
  const links = pendingDeepLinks.get(id) ?? []
  pendingDeepLinks.delete(id)
  return links
})
ipcMain.handle('desktop:connection-credentials', (event) => {
  trustedIpc(event)
  return { custody: credentialStore !== undefined && safeStorage.isEncryptionAvailable(), profiles: credentialStore?.list().map((entry) => entry.profileId) ?? [] }
})
const CONNECTION_PROFILE_ID = /^cp-[a-z0-9-]{1,64}$/
ipcMain.handle('desktop:set-connection-credential', async (event, profileId: unknown, url: unknown, secret: unknown) => {
  trustedIpc(event)
  if (typeof profileId !== 'string' || !CONNECTION_PROFILE_ID.test(profileId)) throw new Error('invalid connection profile id')
  if (!credentialStore) throw new Error('the credential store is not ready')
  if (secret === null) { await credentialStore.remove(profileId); applyCredentialHeaders(); return }
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > 4096) throw new Error('invalid credential')
  const origin = credentialOrigin(url)
  if (origin === undefined) throw new Error('credentials require an http(s) server address')
  await credentialStore.set(profileId, origin, secret)
  applyCredentialHeaders()
})
ipcMain.handle('desktop:retire-connection-profile', async (event, profileId: unknown) => {
  trustedIpc(event)
  if (typeof profileId !== 'string' || !CONNECTION_PROFILE_ID.test(profileId)) throw new Error('invalid connection profile id')
  if (!credentialStore) throw new Error('the credential store is not ready')
  await credentialStore.retire(profileId)
  applyCredentialHeaders()
})
ipcMain.handle('desktop:remote-workers', (event) => { trustedIpc(event); return remoteWorkerLifecycle.list() })
ipcMain.handle('desktop:save-remote-worker', (event, worker: unknown) => { trustedIpc(event); return remoteWorkerLifecycle.save(senderWindowId(event), worker) })
ipcMain.handle('desktop:remove-remote-worker', (event, name: unknown) => { trustedIpc(event); return remoteWorkerLifecycle.remove(name) })
ipcMain.handle('desktop:choose-remote-worker-file', async (event, kind: unknown) => {
  trustedIpc(event)
  if (kind !== 'token' && kind !== 'tls-ca') throw new Error('invalid remote-worker file kind')
  const windowId = senderWindowId(event)
  const result = await dialog.showOpenDialog(windows.get(windowId)!, {
    title: kind === 'token' ? 'Choose the worker token file' : 'Choose the worker TLS certificate or CA file', properties: ['openFile'],
    ...(kind === 'tls-ca' ? { filters: [{ name: 'TLS certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }] } : {}),
  })
  trustedIpc(event)
  const path = result.canceled ? undefined : result.filePaths[0]
  return path === undefined ? undefined : remoteWorkerFileGrants.issue(windowId, kind, path)
})
ipcMain.handle('desktop:check-for-updates', async (event) => { trustedIpc(event); await sendInfo(); return shellUpdater.manualStatus() })
ipcMain.handle('desktop:install-update', (event) => { trustedIpc(event); return shellUpdater.manualStatus() })
ipcMain.handle('desktop:wsl-status', (event) => { trustedIpc(event); return wslHost.status() })
ipcMain.handle('desktop:wsl-prepare', (event) => serializeLifecycle(async () => { trustedIpc(event); return wslHost.prepare() }))
ipcMain.handle('desktop:wsl-project-root', async (event, id: unknown) => {
  trustedIpc(event)
  if (!validProjectId(id)) throw new Error('Invalid WSL project id')
  const status = await wslHost.status()
  if (!status.ready) throw new Error(status.detail)
  return wslHost.projectRoot(id)
})
ipcMain.handle('desktop:wsl-copy-models', (event) => serializeLifecycle(async () => {
  trustedIpc(event)
  const result = await dialog.showOpenDialog(windows.get(senderWindowId(event))!, { title: 'Copy a Windows model folder to the private WSL disk', properties: ['openDirectory'] })
  trustedIpc(event)
  const path = result.filePaths[0]
  return result.canceled || !path ? undefined : wslHost.copyModels(path)
}))
ipcMain.handle('desktop:file-capabilities', async (event, backendUrl: unknown) => {
  let context: Awaited<ReturnType<typeof managedFiles>>
  try { context = await managedFiles(event, backendUrl) }
  catch { return { nativeFolderChoice: false, reveal: false, resolvePath: false } }
  const { url, project, revalidate, distribution } = context
  const resolvePath = await dropResolutionSupported(url)
  let exact = false
  try { await assetLocations(url, { digest: `blake3:${'0'.repeat(64)}`, scope: 'local', project }, project, distribution); exact = true }
  catch { /* Folder choice does not depend on exact-file lookup support. */ }
  await revalidate()
  return { nativeFolderChoice: true, reveal: exact, resolvePath }
})
ipcMain.handle('desktop:choose-directory', async (event, backendUrl: unknown) => {
  const context = await managedFiles(event, backendUrl)
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (!parent) throw new Error('The requesting window is no longer available')
  const result = await chooseDirectory(app.isPackaged, () => dialog.showOpenDialog(parent, { title: 'Choose an existing asset folder', properties: ['openDirectory'] }))
  await context.revalidate()
  const path = result.filePaths[0]
  return result.canceled || !path ? undefined : context.distribution ? wslLinuxPath(context.distribution, path) : path
})
ipcMain.handle('desktop:reveal-model-location', async (event, backendUrl: unknown, location: unknown) => {
  const context = await managedFiles(event, backendUrl)
  await revealModelLocation(context.url, location, context.project, shell, context.revalidate, context.distribution)
})
ipcMain.handle('desktop:resolve-dropped-file', async (event, backendUrl: unknown, path: unknown) => {
  const context = await managedFiles(event, backendUrl)
  return resolveDroppedPath(context.url, path, context.project, context.revalidate, context.distribution)
})
ipcMain.handle('desktop:reveal-file', async (event, backendUrl: unknown, asset: unknown) => {
  const context = await managedFiles(event, backendUrl)
  const location = (await assetLocations(context.url, asset, context.project, context.distribution))[0]
  if (!location) throw new Error('No verified local copy exists in this project; copy the server path instead')
  return revealGrantedFile(location.path, [location.root], shell, async () => {
    await context.revalidate()
    const active = await assetLocations(context.url, asset, context.project, context.distribution)
    if (!active.some((item) => item.path === location.path && item.root === location.root)) throw new Error('The local asset location is no longer authorized')
    await context.revalidate()
  })
})
ipcMain.handle('desktop:save-file', async (event, bytes: unknown, suggestedName: unknown) => {
  trustedIpc(event)
  const id = senderWindowId(event)
  const document = documents.get(id)
  const parent = windows.get(id)!
  const revalidate = (): void => {
    trustedIpc(event)
    if (parent.isDestroyed() || documents.get(id) !== document) throw new Error('The saving window changed')
  }
  return saveFile(bytes, suggestedName, parent, revalidate)
})
ipcMain.handle('desktop:system-check', (event) => { trustedIpc(event); return systemCheck(dataDirectory, environmentClient) })
ipcMain.handle('desktop:clear-cache', (event) => serializeLifecycle(async () => {
  trustedIpc(event)
  await rm(join(dataDirectory, 'cache', 'uv'), { recursive: true, force: true })
  await sendInfo()
}))
ipcMain.handle('desktop:export-support-report', (event) => serializeLifecycle(async () => {
  trustedIpc(event)
  const result = await dialog.showSaveDialog(windows.get(senderWindowId(event))!, {
    title: 'Export Dinkster support report', defaultPath: `dinkster-support-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return undefined
  const report = `${JSON.stringify({ createdAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    desktop: await desktopInfo(), system: await systemCheck(dataDirectory, environmentClient), logs: { desktop: await shellLog.readTail() },
  }, null, 2)}\n`
  await writeFile(result.filePath, redactDiagnosticText(report))
  return result.filePath
}))

autoUpdater.on('error', () => { void shellLog.append('Desktop updater reported an error; startup update status contains the result.') })
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  setImmediate(() => { void serializeLifecycle(shutdown) })
})
if (process.defaultApp) {
  if (process.argv.length >= 2 && process.argv[1]) app.setAsDefaultProtocolClient('dinkster', process.execPath, [resolve(process.argv[1])])
} else app.setAsDefaultProtocolClient('dinkster')
const primaryInstance = app.requestSingleInstanceLock({ services })
if (!primaryInstance) app.quit()
app.on('second-instance', (_event, argv, _directory, additionalData) => {
  const incoming = (additionalData as { services?: unknown } | undefined)?.services
  if (incoming !== services) { dialog.showErrorBox('Hosted services do not match', `The running Desktop uses ${services} services. Close it before launching with different services.`); return }
  const link = deepLinkFromArgv(argv)
  if (link) { void routeDeepLink(link); return }
  const primary = windows.get('primary')
  if (primary) { primary.show(); primary.focus() }
})
app.on('open-url', (event, url) => { event.preventDefault(); const link = parseDeepLink(url); if (link) void routeDeepLink(link) })
app.on('activate', () => { const primary = windows.get('primary'); if (primary) { primary.show(); primary.focus() } })
if (primaryInstance) app.whenReady().then(async () => {
  lifecycleLease = await acquireLifecycleLease(dataDirectory)
  await shellLog.append(JSON.stringify({ event: 'desktop-startup', version: app.getVersion(), pid: process.pid }))
  const shellUpdate = process.platform === 'darwin' ? undefined : await shellUpdater.start()
  if (shellUpdate?.state === 'installing') return
  nativeTheme.on('updated', () => { for (const managed of windows.values()) managed.setBackgroundColor(windowBackground()) })
  credentialStore = await CredentialStore.open(join(dataDirectory, 'credentials.json'), desktopCredentialCipher())
  applyCredentialHeaders()
  await createWindows()
  tray = new Tray(trayIcon())
  tray.setToolTip(desktopTitle(services))
  const navigation: Electron.MenuItemConstructorOptions[] = [
    { id: 'desktop-projects', label: 'Projects', click: () => {
      const primary = windows.get('primary')
      if (primary) { void primary.loadURL(home.url).catch(logFailure); primary.show(); primary.focus() }
    } },
    { label: 'Keep running when the window closes', type: 'checkbox', checked: keepRunning, click: (item) => { keepRunning = item.checked } },
    { label: 'About Dinkster Desktop', click: () => { void showAbout(services) } },
    { type: 'separator' },
    { label: 'Quit', click: () => { void serializeLifecycle(shutdown) } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(navigation))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: desktopTitle(services), submenu: navigation }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  tray.on('double-click', () => { const primary = windows.get('primary'); if (primary) { primary.show(); primary.focus() } })
}).catch((error: unknown) => { logFailure(error); app.quit() })
app.on('window-all-closed', () => { if (!keepRunning) void serializeLifecycle(shutdown) })
