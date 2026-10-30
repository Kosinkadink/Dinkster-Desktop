import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, screen, session, shell, Tray } from 'electron'
import updater from 'electron-updater'
import { applicationIcon, showAbout, trayIcon, windowBackground } from './branding.js'
import {
  clearEngineOperation,
  createInstallSnapshot,
  desktopStorageBytes,
  listEngineReleases,
  readEngineOperation,
  readInstallSnapshot,
  readStoredEngineSelection,
  redactDiagnosticText,
  systemCheck,
  writeEngineOperation,
  writeEngineSelection,
  writeInstallSnapshot,
  type EngineOperation,
  type EngineSelection,
  type SystemCheck,
} from './desktop-manager.js'
import { availableLoopbackPort, EngineRuntime, defaultDataDirectory } from './engine.js'
import { configuredEngineAccelerator, isEngineAccelerator } from './accelerator.js'
import { changeEngineTransaction } from './engine-transaction.js'
import { diagnosticCall, hangDiagnosticEnabled, startHangDiagnostic } from './hang-diagnostic.js'
import { acquireLifecycleLease, type LifecycleLease } from './lifecycle-lease.js'
import { LifecycleQueue } from './lifecycle-queue.js'
import { isTrustedDesktopIpc } from './ipc-security.js'
import { assetLocations, dropResolutionSupported, requireLocalFiles, resolveDroppedPath, revealGrantedFile } from './local-files.js'
import { CredentialStore, credentialOrigin, hasAuthorizationHeader, type CredentialCipher } from './credential-store.js'
import { deepLinkFromArgv, parseDeepLink } from './deep-link.js'
import { RotatingLog } from './rotating-log.js'
import {
  RemoteWorkerFileGrants,
  RemoteWorkerLifecycle,
} from './remote-workers.js'
import { ENGINE_RELEASE } from './release.js'
import { configureUpdateFeed } from './update-feed.js'
import { ShellUpdater } from './shell-updater.js'
import { parseProject, readProjects, saveProject, serverUrl, writeProjects, type DesktopProject } from './projects.js'
import { EnvironmentClient, type EnvironmentRequest, type EnvironmentResult } from './environment.js'
import { detectNvidiaGpus, planVariant } from './hardware.js'
import { createWebHost, type WebHost } from './web-host.js'
import { writeFileAtomic } from './atomic-file.js'
import { denyRendererPermissions, secureWebPreferences } from './security.js'
import { installWindowChrome, windowChromeOptions } from './window-chrome.js'
import {
  addChildWindow,
  addWorkspaceWindow,
  defaultWindowLayout,
  normalizeWindowBounds,
  readWindowLayout,
  removeWindow,
  restoreChildWindows,
  setWorkspaceProject,
  updateWindowPlacement,
  validProjectId,
  writeWindowLayout,
  type ChildWindow,
  type WindowLayout,
  type WorkspaceWindow,
} from './window-layout.js'
import type {
  DesktopDeepLink,
  DesktopInfo,
  DesktopPanelPlacement,
  DesktopWindowContext,
  DesktopWindowLayout,
  LifecycleStatus,
} from './types.js'

const { autoUpdater } = updater
let window: BrowserWindow | undefined
let projectWindow: BrowserWindow | undefined
const remoteWindows = new Map<BrowserWindow, { projectId: string; engineId: string; url: string; folderProject: string | undefined; document: number }>()
const localEngines = new Map<string, { root: string; engine: string }>()
const environmentClient = new EnvironmentClient()
let pendingProjectPlan: { token: string; project: DesktopProject; request: EnvironmentRequest } | undefined
const windows = new Map<string, BrowserWindow>()
const redockingWindows = new Set<string>()
let windowLayout: WindowLayout = defaultWindowLayout()
let layoutWriteTimer: ReturnType<typeof setTimeout> | undefined
let tray: Tray | undefined
let webHost: WebHost | undefined
let credentialStore: CredentialStore | undefined
const pendingDeepLinks = new Map<string, DesktopDeepLink[]>()
const remoteWorkerFileGrants = new RemoteWorkerFileGrants()
let lifecycleLease: LifecycleLease | undefined
let quitting = false
const dataDirectory = process.env['DINKSTER_DESKTOP_DATA'] ?? defaultDataDirectory()
if (hangDiagnosticEnabled) startHangDiagnostic(dataDirectory)
let backendPort = 3639
let selection: EngineSelection | undefined
const updateFeed = configureUpdateFeed(autoUpdater, process.env['DINKSTER_UPDATE_FEED_URL'])
const shellUpdater = new ShellUpdater({ target: autoUpdater, dataDirectory, currentVersion: app.getVersion(), updateFeed, packaged: app.isPackaged })
const lifecycleQueue = new LifecycleQueue()
const windowQueue = new LifecycleQueue()
const layoutPersistenceQueue = new LifecycleQueue()
const executeFile = promisify(execFile)
const engineLog = new RotatingLog(join(dataDirectory, 'logs', 'engine.log'))
const shellLog = new RotatingLog(join(dataDirectory, 'logs', 'desktop.log'))
const configuredAccelerator = configuredEngineAccelerator(
  process.env['DINKSTER_ACCELERATOR'] ?? process.env['DINKSTER_ENGINE_VARIANT'],
)
if (configuredAccelerator.diagnostic) void shellLog.append(configuredAccelerator.diagnostic)

function windowContext(id: string): DesktopWindowContext {
  const workspace = windowLayout.workspaces.find((candidate) => candidate.id === id)
  if (workspace) return { id: workspace.id, kind: 'primary' }
  const child = windowLayout.children.find((candidate) => candidate.id === id)
  if (!child) throw new Error('window is not registered')
  return child.kind === 'workflow'
    ? { id: child.id, kind: 'workflow', workflowId: child.workflowId }
    : {
        id: child.id,
        kind: 'panel',
        panelId: child.panelId,
        returnPlacement: child.returnPlacement,
      }
}

/** The project a window is bound to; undefined = the default project. */
function windowProject(id: string): string | undefined {
  return windowLayout.workspaces.find((workspace) => workspace.id === id)?.projectId
    ?? windowLayout.children.find((child) => child.id === id)?.projectId
}

/** Windows visible to one project: workspaces and tear-outs on other projects are omitted. */
function publicWindowLayout(projectId: string | undefined): DesktopWindowLayout {
  return {
    windows: [
      ...windowLayout.workspaces.filter((workspace) => workspace.projectId === projectId).map((workspace) => workspace.id),
      ...windowLayout.children.filter((child) => child.projectId === projectId).map((child) => child.id),
    ].map(windowContext),
  }
}

function broadcastToWindows(channel: string, value: (id: string) => unknown): void {
  for (const [id, managed] of windows) {
    if (diagnosticCall('window-destroyed', () => managed.isDestroyed()) || diagnosticCall('webcontents-destroyed', () => diagnosticCall('webcontents-get', () => managed.webContents).isDestroyed())) {
      windows.delete(id)
      if (id === 'primary') window = undefined
      continue
    }
    try {
      diagnosticCall('webcontents-send', () => diagnosticCall('webcontents-get', () => managed.webContents).send(channel, value(id)))
    } catch (error) {
      void shellLog.append(redactDiagnosticText(
        `window broadcast ${id}: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  }
}

function sendToWindows(channel: string, value: unknown): void {
  broadcastToWindows(channel, () => value)
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
    void persistWindowLayout().catch((error: unknown) => {
      void shellLog.append(redactDiagnosticText(`window layout: ${error instanceof Error ? error.message : String(error)}`))
    })
  }, 250)
}

async function flushWindowLayout(): Promise<void> {
  if (layoutWriteTimer !== undefined) {
    clearTimeout(layoutWriteTimer)
    layoutWriteTimer = undefined
  }
  await persistWindowLayout()
}

function createRuntime(selected?: EngineSelection): EngineRuntime {
  return new EngineRuntime({
    dataDirectory,
    ...(process.env['DINKSTER_ENGINE_SOURCE'] ? { sourceDirectory: process.env['DINKSTER_ENGINE_SOURCE'] } : {}),
    port: backendPort,
    ...(selected
      ? { variant: selected.variant, releaseCommit: selected.commit }
      : configuredAccelerator.accelerator ? { variant: configuredAccelerator.accelerator } : {}),
  })
}

let runtime = createRuntime()

function attachRuntime(next: EngineRuntime): void {
  let lastVariant: LifecycleStatus['variant']
  next.on('status', (status: LifecycleStatus) => {
    if (next !== runtime) return
    sendToWindows('desktop:status-changed', status)
    if (status.variant && status.variant !== lastVariant) {
      lastVariant = status.variant
      void sendInfo()
    }
  })
  let pendingLog = ''
  next.on('log', (chunk: string) => {
    if (next !== runtime) return
    const lines = `${pendingLog}${chunk}`.split(/\r?\n/)
    pendingLog = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const safeLine = redactDiagnosticText(line.trim())
      void engineLog.append(safeLine)
      sendToWindows('desktop:log', safeLine)
    }
  })
}

attachRuntime(runtime)

async function desktopInfo(): Promise<DesktopInfo> {
  const active = selection ?? {
    commit: ENGINE_RELEASE.commit,
    variant: runtime.status.variant ?? 'cpu',
  }
  return {
    appVersion: app.getVersion(),
    engineCommit: active.commit,
    ...(active.commit === ENGINE_RELEASE.commit ? { remoteWorkerProtocol: ENGINE_RELEASE.workerProtocol } : {}),
    variant: active.variant,
    storageBytes: await desktopStorageBytes(dataDirectory),
    releases: await listEngineReleases(dataDirectory, active),
    update: shellUpdater.status,
  }
}

async function sendInfo(): Promise<void> {
  sendToWindows('desktop:info-changed', await desktopInfo())
}

function serializeLifecycle<T>(action: () => Promise<T>): Promise<T> {
  return lifecycleQueue.run(action)
}

const remoteWorkerLifecycle = new RemoteWorkerLifecycle(
  dataDirectory,
  remoteWorkerFileGrants,
  serializeLifecycle,
  () => {
    if (activeSelection().commit !== ENGINE_RELEASE.commit) {
      throw new Error('Restore the packaged engine before changing remote workers')
    }
  },
  () => runtime.start(),
)

function activeSelection(): EngineSelection {
  return selection ?? { commit: ENGINE_RELEASE.commit, variant: runtime.status.variant ?? 'cpu', followPackaged: true }
}

async function changeEngine(
  target: EngineSelection,
  kind: EngineOperation['kind'],
  expectedDependencies?: readonly { readonly name: string; readonly version: string }[],
): Promise<void> {
  const previous = activeSelection()
  await changeEngineTransaction({
    previous,
    target,
    kind,
    ...(expectedDependencies ? { expectedDependencies } : {}),
    currentRuntime: runtime,
    createRuntime,
    activateRuntime: (next) => {
      runtime = next
      attachRuntime(next)
    },
    writeOperation: (operation) => writeEngineOperation(dataDirectory, operation),
    snapshot: (selected, reason) => createInstallSnapshot(dataDirectory, selected, reason),
    persist: async (selected) => {
      await writeEngineSelection(dataDirectory, selected)
      selection = selected
    },
    clearOperation: () => clearEngineOperation(dataDirectory),
    committed: sendInfo,
  })
}

function trustedIpc(event: Electron.IpcMainInvokeEvent): void {
  const expected = diagnosticCall('webcontents-get', () => [...windows.values()].find((managed) => managed.webContents === event.sender)?.webContents)
  if (!diagnosticCall('trusted-ipc', () => isTrustedDesktopIpc(
    expected,
    diagnosticCall('ipc-main-frame', () => event.sender.mainFrame),
    webHost ? new URL(webHost.url).origin : undefined,
    event.sender,
    diagnosticCall('ipc-sender-frame', () => event.senderFrame),
  ))) {
    throw new Error('desktop capability denied for an untrusted renderer')
  }
}

async function managedFiles(event: Electron.IpcMainInvokeEvent, backendUrl: unknown): Promise<{
  url: string; project: string; revalidate(): Promise<void>
}> {
  if (quitting) throw new Error('Desktop is shutting down')
  const parent = BrowserWindow.fromWebContents(event.sender)
  const binding = parent && remoteWindows.get(parent)
  if (parent && binding) {
    const { projectId, engineId, url, folderProject, document } = binding
    const trusted = (): void => {
      if (quitting || parent.isDestroyed() || remoteWindows.get(parent) !== binding || binding.url !== url
        || binding.document !== document || !folderProject || binding.folderProject !== folderProject
        || !isTrustedDesktopIpc(parent.webContents, parent.webContents.mainFrame, new URL(url).origin, event.sender, event.senderFrame)) {
        throw new Error('Native file access requires the bound local engine window')
      }
    }
    trusted()
    if (!folderProject) throw new Error('Invalid folder-project context')
    requireLocalFiles(backendUrl, url, true)
    const projects = await readProjects(dataDirectory)
    const project = projects.projects.find((entry) => entry.id === projectId)
    const engine = project?.engines.find((entry) => entry.id === engineId)
    if (!project?.root || engine?.kind !== 'local') throw new Error('Native file access requires a local engine')
    const root = project.root
    let generation: number | undefined
    const checkBinding = async (): Promise<void> => {
      const saved = (await readProjects(dataDirectory)).projects.find((entry) => entry.id === projectId)
      if (saved?.root !== root || saved.engines.find((entry) => entry.id === engineId)?.kind !== 'local') {
        throw new Error('The local project binding changed')
      }
      trusted()
    }
    const revalidate = async (): Promise<void> => {
      trusted()
      await checkBinding()
      const status = await environmentClient.run({ root, operation: 'status' })
      const active = status.engines?.find((entry) => entry.name === engineId)
      if (status.status !== 'clean' || status.root !== root || !status.current || active?.state !== 'ready' || active.generation !== status.current
        || active.url !== url || (generation !== undefined && generation !== active.generation)) {
        throw new Error('The local engine is no longer the selected ready generation')
      }
      generation = active.generation
      await checkBinding()
    }
    await revalidate()
    return { url, project: folderProject, revalidate }
  }
  trustedIpc(event)
  const current = runtime
  const project = windowProject(senderWindowId(event)) ?? 'default'
  const url = `http://127.0.0.1:${backendPort}`
  const revalidate = async (): Promise<void> => {
    trustedIpc(event)
    requireLocalFiles(backendUrl, webHost?.url, current.status.phase === 'running')
    if (quitting || runtime !== current || (windowProject(senderWindowId(event)) ?? 'default') !== project
      || !await current.ownsBackend() || runtime !== current) throw new Error('The shell-managed backend changed')
    trustedIpc(event)
  }
  await revalidate()
  return { url, project, revalidate }
}

const projectDialogPath = join(app.getAppPath(), 'resources', 'projects.html')

function trustedProjectIpc(event: Electron.IpcMainInvokeEvent): void {
  if (quitting) throw new Error('Desktop is shutting down')
  if (!projectWindow || event.sender !== projectWindow.webContents
    || event.senderFrame !== projectWindow.webContents.mainFrame
    || event.senderFrame.url !== pathToFileURL(projectDialogPath).href) {
    throw new Error('project capability denied for an untrusted renderer')
  }
}

async function createProjectManager(): Promise<void> {
  if (projectWindow && !projectWindow.isDestroyed()) { projectWindow.show(); return }
  projectWindow = new BrowserWindow({
    ...windowChromeOptions(),
    width: 1040, height: 760, minWidth: 600, minHeight: 500,
    title: 'Dinkster Desktop', icon: applicationIcon(), backgroundColor: windowBackground(),
    webPreferences: secureWebPreferences(join(app.getAppPath(), 'dist', 'preload.cjs')),
  })
  installWindowChrome(projectWindow)
  projectWindow.on('page-title-updated', (event) => event.preventDefault())
  denyRendererPermissions(projectWindow.webContents.session)
  projectWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  projectWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  projectWindow.on('closed', () => { projectWindow = undefined; pendingProjectPlan = undefined })
  await projectWindow.loadFile(projectDialogPath)
}

ipcMain.handle('desktop:projects-list', async (event) => {
  trustedProjectIpc(event)
  return readProjects(dataDirectory)
})
ipcMain.handle('desktop:projects-save', (event, value: unknown) => serializeLifecycle(async () => {
  trustedProjectIpc(event)
  await writeProjects(dataDirectory, saveProject(await readProjects(dataDirectory), value))
}))
ipcMain.handle('desktop:projects-remove', (event, projectId: unknown) => serializeLifecycle(async () => {
  trustedProjectIpc(event)
  if (!validProjectId(projectId)) throw new Error('invalid project id')
  const projects = await readProjects(dataDirectory)
  await writeProjects(dataDirectory, { ...projects, projects: projects.projects.filter((project) => project.id !== projectId) })
}))
ipcMain.handle('desktop:projects-inspect', (event, input: EnvironmentRequest) => serializeLifecycle(async () => {
  trustedProjectIpc(event)
  const request: EnvironmentRequest = { root: input.root, operation: 'catalog',
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.mirrors === undefined ? {} : { mirrors: input.mirrors }) }
  const result = await environmentClient.run(request)
  const hardware = await detectNvidiaGpus()
  const plan = planVariant((result.variants ?? []).map((entry) => entry.manifest), hardware, input.gpus ?? [], process.platform)
  return { result, hardware, plan }
}))

function localEngineUrl(project: DesktopProject, engineId: string, result: EnvironmentResult): string {
  const engine = result.engines?.find((candidate) => candidate.name === engineId)
  const url = engine?.url ?? (project.engines.filter((candidate) => candidate.kind === 'local').length === 1 ? result.url : undefined)
  if (!url || (engine && engine.state !== 'ready')) throw new Error(`dinkster-env did not return a ready URL for ${engineId}`)
  const address = serverUrl(url)
  const parsed = new URL(address)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('local supervisor returned a non-loopback URL')
  return address
}

async function handoffProject(project: DesktopProject, result: EnvironmentResult): Promise<void> {
  for (const [managed, binding] of remoteWindows) {
    if (binding.projectId !== project.id || managed.isDestroyed()) continue
    if (!project.engines.some((engine) => engine.id === binding.engineId && engine.kind === 'local')) continue
    const url = localEngineUrl(project, binding.engineId, result)
    binding.url = url
    await managed.loadURL(url)
  }
}

ipcMain.handle('desktop:projects-plan', (event, value: unknown, input: EnvironmentRequest) => serializeLifecycle(async () => {
  trustedProjectIpc(event)
  pendingProjectPlan = undefined
  const project = parseProject(value)
  if (!project.root || input.root !== project.root
    || !['setup', 'update', 'rollback', 'move', 'doctor', 'gc'].includes(input.operation)) throw new Error('invalid local project operation')
  // Validate the shell binding before asking the environment owner to mutate it.
  saveProject(await readProjects(dataDirectory), project)
  if (input.operation === 'move') saveProject(await readProjects(dataDirectory), { ...project, root: input.destination })
  const engine = project.engines.find((binding) => binding.kind === 'local' && binding.id === input.engine)
  if (input.operation === 'setup' && (!engine || engine.kind !== 'local')) throw new Error('select the local engine binding before setup')
  const request: EnvironmentRequest = { ...input, root: project.root,
    ...(input.operation === 'setup' && engine?.kind === 'local' ? { engine: engine.id, gpus: engine.gpus, port: engine.port } : {}) }
  const result = await environmentClient.run(request)
  if (result.status !== 'planned') return { result }
  const token = randomUUID()
  pendingProjectPlan = { token, project, request }
  return { token, result }
}))
ipcMain.handle('desktop:projects-apply', (event, token: unknown) => serializeLifecycle(async () => {
  trustedProjectIpc(event)
  const planned = pendingProjectPlan
  pendingProjectPlan = undefined
  if (!planned || token !== planned.token) throw new Error('the plan expired; review a new plan before applying')
  saveProject(await readProjects(dataDirectory), planned.project)
  if (planned.request.operation === 'move') saveProject(await readProjects(dataDirectory), { ...planned.project, root: planned.request.destination })
  const result = await environmentClient.run(planned.request, true)
  if (result.status !== 'applied' && result.status !== 'clean') throw new Error('dinkster-env did not apply the confirmed operation')
  const project = parseProject({
    ...planned.project,
    root: result.root,
    ...(planned.request.channel ? { channel: planned.request.channel } : {}),
  })
  await writeProjects(dataDirectory, saveProject(await readProjects(dataDirectory), project))
  for (const engine of result.engines ?? []) {
    if (engine.state === 'ready' && project.engines.some((binding) => binding.kind === 'local' && binding.id === engine.name)) {
      localEngines.set(`${project.id}/${engine.name}`, { root: project.root!, engine: engine.name })
    }
  }
  if (planned.request.operation === 'move') {
    for (const binding of localEngines.values()) if (binding.root === planned.project.root) binding.root = project.root!
  }
  if (['setup', 'update', 'rollback', 'move'].includes(planned.request.operation)) await handoffProject(project, result)
  return result
}))
ipcMain.handle('desktop:projects-open', (event, projectId: unknown, engineId: unknown) => serializeLifecycle(async () => {
  trustedProjectIpc(event)
  if (!validProjectId(projectId) || !validProjectId(engineId)) throw new Error('invalid engine binding')
  const project = (await readProjects(dataDirectory)).projects.find((candidate) => candidate.id === projectId)
  const engine = project?.engines.find((candidate) => candidate.id === engineId)
  if (!engine) throw new Error('engine binding not found')
  let url: string
  if (engine.kind === 'remote') url = engine.url
  else {
    const root = project!.root!
    const result = await environmentClient.run({
      root, operation: 'start', engine: engine.id, gpus: engine.gpus,
      ...(engine.port === undefined ? {} : { port: engine.port }),
    }, true)
    if (result.status !== 'applied') throw new Error('dinkster-env did not start the selected engine')
    localEngines.set(`${projectId}/${engineId}`, { root, engine: engine.id })
    url = localEngineUrl(project!, engine.id, result)
  }
  const existing = [...remoteWindows].find(([managed, binding]) => !managed.isDestroyed() && binding.projectId === projectId && binding.engineId === engineId)
  if (existing) {
    existing[1].url = url
    await existing[0].loadURL(url)
    existing[0].show()
    return
  }
  const remote = new BrowserWindow({
    ...windowChromeOptions(),
    width: 1440, height: 900, title: 'Dinkster Desktop',
    icon: applicationIcon(), backgroundColor: windowBackground(),
    webPreferences: engine.kind === 'local'
      ? { ...secureWebPreferences(join(app.getAppPath(), 'dist', 'preload.cjs')), additionalArguments: ['--dinkster-local-files'] }
      : { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  installWindowChrome(remote)
  remote.on('page-title-updated', (event) => event.preventDefault())
  const binding = { projectId, engineId, url, folderProject: undefined as string | undefined, document: 0 }
  remoteWindows.set(remote, binding)
  remote.webContents.on('did-navigate', (_event, address) => {
    // Match the frontend's immutable document scope, not later history.replaceState edits.
    const project = new URL(address).searchParams.get('dinksterProject') ?? 'default'
    binding.folderProject = validProjectId(project) ? project : undefined
    binding.document++
  })
  denyRendererPermissions(remote.webContents.session)
  remote.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  remote.webContents.on('will-navigate', (navigation, url) => {
    if (new URL(url).origin !== new URL(binding.url).origin) navigation.preventDefault()
  })
  remote.on('closed', () => remoteWindows.delete(remote))
  try { await remote.loadURL(url) }
  catch (error) { remote.destroy(); throw error }
}))

async function gpuCheck(): Promise<SystemCheck['gpu']> {
  try {
    const { stdout } = await executeFile('nvidia-smi', [
      '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits',
    ], { windowsHide: true, timeout: 5000 })
    const [name, driver, memory] = stdout.trim().split(',').map((part) => part.trim())
    if (!name) return { available: false }
    const memoryMiB = Number(memory)
    return { available: true, name, ...(driver ? { driver } : {}), ...(Number.isFinite(memoryMiB) ? { memoryMiB } : {}) }
  } catch {
    return { available: false }
  }
}

async function shutdown(): Promise<void> {
  if (quitting) return
  quitting = true
  await windowQueue.run(async () => {})
  const stopped = await Promise.allSettled([
    runtime.stop(),
    ...[...localEngines.values()].map(({ root, engine }) => environmentClient.run({ root, operation: 'stop', engine }, true)),
    Promise.resolve().then(() => webHost?.close()),
  ])
  try {
    if (stopped.every((result) => result.status === 'fulfilled')) await environmentClient.dispose()
    else await shellLog.append('Retaining environment tools because shutdown did not stop every local service.')
    window = undefined
    await flushWindowLayout()
    projectWindow?.destroy()
    for (const managed of remoteWindows.keys()) managed.destroy()
    remoteWindows.clear()
    for (const managed of windows.values()) managed.destroy()
    windows.clear()
    tray?.destroy()
  } finally {
    await lifecycleLease?.release()
    lifecycleLease = undefined
    app.exit(0)
  }
}

function displayWorkAreas(): readonly { x: number; y: number; width: number; height: number; primary?: boolean }[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display) => ({
    ...display.workArea,
    ...(display.id === primaryId ? { primary: true } : {}),
  }))
}

function placementFor(id: string): WorkspaceWindow | ChildWindow {
  const found = windowLayout.workspaces.find((candidate) => candidate.id === id)
    ?? windowLayout.children.find((candidate) => candidate.id === id)
  if (!found) throw new Error('window placement is not registered')
  return found
}

function queryFor(id: string): string {
  const context = windowContext(id)
  const params = new URLSearchParams({ dinksterWindow: context.id, dinksterWindowKind: context.kind })
  if (context.kind === 'workflow') params.set('dinksterWorkflow', context.workflowId)
  if (context.kind === 'panel') params.set('dinksterPanel', context.panelId)
  // The window loads into its own project's scope; windows sharing a project
  // share one storage scope and tab authority. Default project = no param.
  const project = windowProject(id)
  if (project) params.set('dinksterProject', project)
  return params.toString()
}

async function createManagedWindow(id: string): Promise<BrowserWindow> {
  if (!webHost) throw new Error('web host is not ready')
  const placement = placementFor(id)
  const bounds = normalizeWindowBounds(placement.bounds, displayWorkAreas())
  windowLayout = updateWindowPlacement(windowLayout, id, { bounds })
  const managed = new BrowserWindow({
    ...windowChromeOptions(),
    ...bounds,
    minWidth: Math.min(900, bounds.width),
    minHeight: Math.min(640, bounds.height),
    show: false,
    title: 'Dinkster Desktop',
    icon: applicationIcon(),
    backgroundColor: windowBackground(),
    webPreferences: secureWebPreferences(join(app.getAppPath(), 'dist', 'preload.cjs')),
  })
  installWindowChrome(managed)
  managed.on('page-title-updated', (event) => event.preventDefault())
  windows.set(id, managed)
  if (id === 'primary') window = managed
  denyRendererPermissions(managed.webContents.session)
  managed.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  managed.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(webHost!.url).origin) event.preventDefault()
  })
  managed.once('ready-to-show', () => {
    if (placement.maximized) managed.maximize()
    managed.show()
  })
  const recordPlacement = (): void => {
    if (diagnosticCall('window-destroyed', () => managed.isDestroyed()) || diagnosticCall('window-maximized', () => managed.isMaximized())) return
    windowLayout = updateWindowPlacement(windowLayout, id, { bounds: diagnosticCall('window-bounds', () => managed.getBounds()) })
    scheduleWindowLayoutWrite()
  }
  managed.on('move', recordPlacement)
  managed.on('resize', recordPlacement)
  managed.on('maximize', () => {
    windowLayout = updateWindowPlacement(windowLayout, id, { maximized: true })
    scheduleWindowLayoutWrite()
  })
  managed.on('unmaximize', () => {
    windowLayout = updateWindowPlacement(windowLayout, id, { maximized: false, bounds: diagnosticCall('window-bounds', () => managed.getBounds()) })
    scheduleWindowLayoutWrite()
  })
  managed.on('close', (event) => {
    if (quitting) return
    if (id === 'primary') {
      event.preventDefault()
      setImmediate(() => { void serializeLifecycle(shutdown) })
      return
    }
    remoteWorkerFileGrants.revokeWindow(id)
    if (redockingWindows.delete(id)) return
    windows.delete(id)
    pendingDeepLinks.delete(id)
    windowLayout = removeWindow(windowLayout, id)
    scheduleWindowLayoutWrite()
    queueMicrotask(sendWindowLayout)
  })
  const url = new URL(webHost.url)
  url.search = queryFor(id)
  try {
    await managed.loadURL(url.toString())
  } catch (error) {
    windows.delete(id)
    if (id === 'primary') window = undefined
    managed.destroy()
    throw error
  }
  return managed
}

/**
 * The web-host port is part of the renderer origin and so keys all renderer
 * localStorage; it must survive restarts or every launch would present an
 * empty app. Stored beside the other per-install state in dataDirectory.
 */
async function readPersistedWebHostPort(): Promise<number | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dataDirectory, 'web-host.json'), 'utf8'))
    const port = (parsed as { port?: unknown } | null)?.port
    return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
  } catch {
    return undefined
  }
}

async function createWindow(): Promise<void> {
  const appDirectory = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(app.getAppPath(), '..', 'app', 'dist')
  webHost = await createWebHost(appDirectory, backendPort, await readPersistedWebHostPort())
  try {
    await writeFileAtomic(join(dataDirectory, 'web-host.json'), `${JSON.stringify({ port: Number(new URL(webHost.url).port) })}\n`)
  } catch (error) {
    void shellLog.append(redactDiagnosticText(`web host port: ${error instanceof Error ? error.message : String(error)}`))
  }
  const primary = screen.getPrimaryDisplay().workArea
  windowLayout = await readWindowLayout(dataDirectory, defaultWindowLayout({
    x: primary.x + Math.max(0, Math.floor((primary.width - 1440) / 2)),
    y: primary.y + Math.max(0, Math.floor((primary.height - 900) / 2)),
    width: Math.min(1440, primary.width),
    height: Math.min(900, primary.height),
  }))
  await createManagedWindow('primary')
  let restoreFailed = false
  for (const workspace of windowLayout.workspaces) {
    if (workspace.id === 'primary') continue
    try {
      await createManagedWindow(workspace.id)
    } catch (error) {
      windowLayout = removeWindow(windowLayout, workspace.id)
      restoreFailed = true
      await shellLog.append(redactDiagnosticText(
        `window restore ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  }
  const restored = await restoreChildWindows(windowLayout, (child) => createManagedWindow(child.id).then(() => undefined))
  windowLayout = restored.layout
  for (const failure of restored.failures) {
    restoreFailed = true
    await shellLog.append(redactDiagnosticText(
      `window restore ${failure.child.id}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
    ))
  }
  if (restoreFailed) await persistWindowLayout()
  sendWindowLayout()
}

function senderWindowId(event: Electron.IpcMainInvokeEvent): string {
  const entry = [...windows].find(([, managed]) => managed.webContents === event.sender)
  if (!entry) throw new Error('window is not registered')
  return entry[0]
}

function validAssignmentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

async function openChildWindow(child: ChildWindow): Promise<void> {
  windowLayout = addChildWindow(windowLayout, child)
  try {
    await persistWindowLayout()
    await createManagedWindow(child.id)
  } catch (error) {
    windowLayout = removeWindow(windowLayout, child.id)
    await persistWindowLayout().catch(() => {})
    throw error
  }
  sendWindowLayout()
}

/** Open an additional workspace window bound to a project (undefined = default). */
async function openWorkspaceWindow(
  projectId: string | undefined,
  base: { x: number; y: number; width: number; height: number },
): Promise<WorkspaceWindow> {
  const workspace: WorkspaceWindow = {
    id: `workspace-${randomUUID()}`,
    bounds: normalizeWindowBounds(
      { x: base.x + 48, y: base.y + 48, width: base.width, height: base.height },
      displayWorkAreas(),
    ),
    maximized: false,
    ...(projectId ? { projectId } : {}),
  }
  windowLayout = addWorkspaceWindow(windowLayout, workspace)
  try {
    await persistWindowLayout()
    await createManagedWindow(workspace.id)
  } catch (error) {
    windowLayout = removeWindow(windowLayout, workspace.id)
    await persistWindowLayout().catch(() => {})
    throw error
  }
  sendWindowLayout()
  return workspace
}

function desktopCredentialCipher(): CredentialCipher {
  return {
    available: () => diagnosticCall('credential-available', () => safeStorage.isEncryptionAvailable()),
    encrypt: (plain) => diagnosticCall('credential-encrypt', () => safeStorage.encryptString(plain)),
    decrypt: (blob) => diagnosticCall('credential-decrypt', () => safeStorage.decryptString(blob)),
  }
}

/** The http(s) origin a request authenticates against; ws(s) maps to http(s). */
function requestOrigin(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const protocol = parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol
  if (protocol !== 'http:' && protocol !== 'https:') return undefined
  return `${protocol}//${parsed.host}`
}

/**
 * Inject stored credentials as Authorization headers in the main process,
 * scoped to the exact origins that have one. The renderer never handles the
 * secret; fetch and WebSocket requests both pass through the session. An
 * Authorization header the renderer set itself is never overwritten.
 */
function applyCredentialHeaders(): void {
  const origins = credentialStore?.origins() ?? []
  if (origins.length === 0) {
    session.defaultSession.webRequest.onBeforeSendHeaders(null)
    return
  }
  const patterns = origins.flatMap((origin) => {
    const url = new URL(origin)
    const wsScheme = url.protocol === 'https:' ? 'wss' : 'ws'
    return [`${origin}/*`, `${wsScheme}://${url.host}/*`]
  })
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: patterns }, (details, callback) => {
    const origin = requestOrigin(details.url)
    const secret = origin !== undefined ? credentialStore?.secretFor(origin) : undefined
    if (secret !== undefined && !hasAuthorizationHeader(details.requestHeaders)) {
      details.requestHeaders['Authorization'] = `Bearer ${secret}`
    }
    diagnosticCall('credential-request-callback', () => callback({ requestHeaders: details.requestHeaders }))
  })
}

/**
 * Route a validated deep link to the workspace window bound to its project,
 * opening one when none exists. The payload is queued per window and the
 * renderer drains the queue over IPC, so a link arriving while the window
 * is still loading is delivered once the renderer is ready. Links arriving
 * before the first window exists (macOS open-url fires before ready; a
 * second instance can race startup) are staged and routed after it does.
 */
let windowsReady = false
const preReadyLinks: DesktopDeepLink[] = []

function routeDeepLink(link: DesktopDeepLink): Promise<void> {
  if (!windowsReady) {
    preReadyLinks.push(link)
    return Promise.resolve()
  }
  return windowQueue.run(async () => {
    const project = link.projectId === 'default' ? undefined : link.projectId
    let target = windowLayout.workspaces.find((workspace) =>
      workspace.projectId === project && windows.has(workspace.id))
    if (!target) {
      const base = window && !window.isDestroyed()
        ? window.getBounds()
        : { x: 80, y: 80, width: 1280, height: 800 }
      target = await openWorkspaceWindow(project, base)
    }
    const queue = pendingDeepLinks.get(target.id) ?? []
    queue.push(link)
    pendingDeepLinks.set(target.id, queue)
    const managed = windows.get(target.id)
    if (managed && !managed.isDestroyed()) {
      managed.show()
      managed.focus()
      managed.webContents.send('desktop:deep-link-pending')
    }
  }).catch((error: unknown) => {
    void shellLog.append(redactDiagnosticText(
      `deep link: ${error instanceof Error ? error.message : String(error)}`,
    ))
  })
}

ipcMain.handle('desktop:locale', (event) => { trustedIpc(event); return app.getLocale() })
ipcMain.handle('desktop:status', (event) => { trustedIpc(event); return runtime.status })
ipcMain.handle('desktop:retry', (event) => { trustedIpc(event); return serializeLifecycle(async () => runtime.start()) })
ipcMain.handle('desktop:info', (event) => { trustedIpc(event); return desktopInfo() })
ipcMain.handle('desktop:window-context', (event) => {
  trustedIpc(event)
  return windowContext(senderWindowId(event))
})
ipcMain.handle('desktop:window-layout', (event) => {
  trustedIpc(event)
  return publicWindowLayout(windowProject(senderWindowId(event)))
})
ipcMain.handle('desktop:open-workflow-window', (event, workflowId: unknown, x: unknown, y: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  if (!validAssignmentId(workflowId)) throw new Error('invalid workflow id')
  const senderId = senderWindowId(event)
  const project = windowProject(senderId)
  const existing = windowLayout.children.find((child) =>
    child.kind === 'workflow' && child.workflowId === workflowId && child.projectId === project)
  if (existing) {
    windows.get(existing.id)?.show()
    windows.get(existing.id)?.focus()
    return
  }
  const owner = windows.get(senderId)!
  const current = owner.getBounds()
  const left = typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : current.x + 48
  const top = typeof y === 'number' && Number.isFinite(y) ? Math.round(y) : current.y + 48
  await openChildWindow({
    id: `workflow-${randomUUID()}`,
    kind: 'workflow',
    workflowId,
    bounds: normalizeWindowBounds({ x: left, y: top, width: current.width, height: current.height }, displayWorkAreas()),
    maximized: false,
    ...(project ? { projectId: project } : {}),
  })
}))
ipcMain.handle('desktop:open-panel-window', (event, panelId: unknown, returnPlacement: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  if (!validAssignmentId(panelId) || (returnPlacement !== 'dock' && returnPlacement !== 'rail' && returnPlacement !== 'bottom')) {
    throw new Error('invalid panel window request')
  }
  const senderId = senderWindowId(event)
  const project = windowProject(senderId)
  const existing = windowLayout.children.find((child) =>
    child.kind === 'panel' && child.panelId === panelId && child.projectId === project)
  if (existing) {
    windows.get(existing.id)?.show()
    windows.get(existing.id)?.focus()
    return
  }
  const current = windows.get(senderId)!.getBounds()
  await openChildWindow({
    id: `panel-${randomUUID()}`,
    kind: 'panel',
    panelId,
    returnPlacement: returnPlacement as DesktopPanelPlacement,
    bounds: normalizeWindowBounds({
      x: current.x + 64,
      y: current.y + 64,
      width: Math.min(900, current.width),
      height: Math.min(700, current.height),
    }, displayWorkAreas()),
    maximized: false,
    ...(project ? { projectId: project } : {}),
  })
}))
ipcMain.handle('desktop:redock-window', (event) => windowQueue.run(async () => {
  trustedIpc(event)
  const id = senderWindowId(event)
  if (windowLayout.workspaces.some((workspace) => workspace.id === id)) return
  const managed = windows.get(id)
  redockingWindows.add(id)
  windows.delete(id)
  windowLayout = removeWindow(windowLayout, id)
  try {
    await persistWindowLayout()
  } catch (error) {
    scheduleWindowLayoutWrite()
    throw error
  } finally {
    if (managed && !managed.isDestroyed()) managed.close()
    redockingWindows.delete(id)
    sendWindowLayout()
  }
}))
ipcMain.handle('desktop:switch-project', (event, projectId: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  const id = senderWindowId(event)
  if (!windowLayout.workspaces.some((workspace) => workspace.id === id)) {
    throw new Error('projects are switched from a workspace window')
  }
  if (!validProjectId(projectId)) throw new Error('invalid project id')
  const next = projectId === 'default' ? undefined : projectId
  if (windowProject(id) === next) return
  // Tear-out children stay bound to their own project and keep working;
  // only this workspace window reloads into the new scope.
  const previousProject = windowProject(id)
  windowLayout = setWorkspaceProject(windowLayout, id, next)
  try {
    await persistWindowLayout()
    const managed = windows.get(id)
    if (managed && webHost) {
      const url = new URL(webHost.url)
      url.search = queryFor(id)
      await managed.loadURL(url.toString())
    }
  } catch (error) {
    // Restore only this window's binding, on the current layout, so main
    // never routes new pop-outs to a renderer still running the previous
    // project. Concurrent close/move/resize changes stay intact; a window
    // closed mid-switch stays closed.
    if (windowLayout.workspaces.some((workspace) => workspace.id === id)) {
      windowLayout = setWorkspaceProject(windowLayout, id, previousProject)
      await persistWindowLayout().catch(() => {})
      const managed = windows.get(id)
      if (managed && webHost && !managed.isDestroyed()) {
        const url = new URL(webHost.url)
        url.search = queryFor(id)
        await managed.loadURL(url.toString()).catch(() => {})
      }
    }
    throw error
  }
  sendWindowLayout()
}))
ipcMain.handle('desktop:open-project-window', (event, projectId: unknown) => windowQueue.run(async () => {
  trustedIpc(event)
  if (!validProjectId(projectId)) throw new Error('invalid project id')
  const next = projectId === 'default' ? undefined : projectId
  await openWorkspaceWindow(next, windows.get(senderWindowId(event))!.getBounds())
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
  return {
    custody: credentialStore !== undefined && diagnosticCall('credential-available', () => safeStorage.isEncryptionAvailable()),
    profiles: credentialStore?.list().map((entry) => entry.profileId) ?? [],
  }
})
const CONNECTION_PROFILE_ID = /^cp-[a-z0-9-]{1,64}$/
ipcMain.handle('desktop:set-connection-credential', async (event, profileId: unknown, url: unknown, secret: unknown) => {
  trustedIpc(event)
  if (typeof profileId !== 'string' || !CONNECTION_PROFILE_ID.test(profileId)) throw new Error('invalid connection profile id')
  if (!credentialStore) throw new Error('the credential store is not ready')
  if (secret === null) {
    await credentialStore.remove(profileId)
    applyCredentialHeaders()
    return
  }
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
ipcMain.handle('desktop:remote-workers', (event) => {
  trustedIpc(event)
  return remoteWorkerLifecycle.list()
})
ipcMain.handle('desktop:save-remote-worker', (event, worker: unknown) => {
  trustedIpc(event)
  const windowId = senderWindowId(event)
  return remoteWorkerLifecycle.save(windowId, worker)
})
ipcMain.handle('desktop:remove-remote-worker', (event, name: unknown) => {
  trustedIpc(event)
  return remoteWorkerLifecycle.remove(name)
})
ipcMain.handle('desktop:choose-remote-worker-file', async (event, kind: unknown) => {
  trustedIpc(event)
  if (kind !== 'token' && kind !== 'tls-ca') throw new Error('invalid remote-worker file kind')
  const windowId = senderWindowId(event)
  const result = await dialog.showOpenDialog(windows.get(windowId)!, {
    title: kind === 'token' ? 'Choose the worker token file' : 'Choose the worker TLS certificate or CA file',
    properties: ['openFile'],
    ...(kind === 'tls-ca'
      ? { filters: [{ name: 'TLS certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }] }
      : {}),
  })
  const path = result.canceled ? undefined : result.filePaths[0]
  return path === undefined ? undefined : remoteWorkerFileGrants.issue(windowId, kind, path)
})
ipcMain.handle('desktop:select-engine', (event, commit: unknown, variant: unknown) => serializeLifecycle(async () => {
  trustedIpc(event)
  if (typeof commit !== 'string' || !isEngineAccelerator(variant)) throw new Error('invalid engine selection')
  const active = activeSelection()
  const installed = await listEngineReleases(dataDirectory, active)
  if (commit !== ENGINE_RELEASE.commit && !installed.some((release) => release.commit === commit && release.variant === variant)) {
    throw new Error('the requested engine release is not installed')
  }
  const nextSelection: EngineSelection = {
    commit,
    variant,
    ...(commit === ENGINE_RELEASE.commit ? { followPackaged: true } : {}),
  }
  await changeEngine(nextSelection, 'environment-change')
}))
ipcMain.handle('desktop:check-for-updates', async (event) => {
  trustedIpc(event)
  await sendInfo()
  return shellUpdater.manualStatus()
})
ipcMain.handle('desktop:install-update', async (event) => {
  trustedIpc(event)
  return shellUpdater.manualStatus()
})
ipcMain.handle('desktop:file-capabilities', async (event, backendUrl: unknown) => {
  let context: Awaited<ReturnType<typeof managedFiles>>
  try { context = await managedFiles(event, backendUrl) }
  catch { return { nativeFolderChoice: false, reveal: false, resolvePath: false } }
  const { url, project, revalidate } = context
  const resolvePath = await dropResolutionSupported(url)
  let exact = false
  try {
    await assetLocations(url, { digest: `blake3:${'0'.repeat(64)}`, scope: 'local', project }, project)
    exact = true
  } catch { /* Folder choice does not depend on exact-file lookup support. */ }
  await revalidate()
  return { nativeFolderChoice: true, reveal: exact, resolvePath }
})
ipcMain.handle('desktop:choose-directory', async (event, backendUrl: unknown) => {
  const context = await managedFiles(event, backendUrl)
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (!parent) throw new Error('The requesting window is no longer available')
  const result = await dialog.showOpenDialog(parent, { title: 'Choose an existing asset folder', properties: ['openDirectory'] })
  await context.revalidate()
  return result.canceled ? undefined : result.filePaths[0]
})
ipcMain.handle('desktop:resolve-dropped-file', async (event, backendUrl: unknown, path: unknown) => {
  const context = await managedFiles(event, backendUrl)
  return resolveDroppedPath(context.url, path, context.project, context.revalidate)
})
ipcMain.handle('desktop:reveal-file', async (event, backendUrl: unknown, asset: unknown) => {
  const context = await managedFiles(event, backendUrl)
  const locations = await assetLocations(context.url, asset, context.project)
  const location = locations[0]
  if (!location) throw new Error('No verified local copy exists in this project; copy the server path instead')
  return revealGrantedFile(location.path, [location.root], shell, async () => {
    await context.revalidate()
    const active = await assetLocations(context.url, asset, context.project)
    if (!active.some((item) => item.path === location.path && item.root === location.root)) {
      throw new Error('The local asset location is no longer authorized')
    }
    await context.revalidate()
  })
})
ipcMain.handle('desktop:export-snapshot', (event) => serializeLifecycle(async () => {
  trustedIpc(event)
  const snapshot = await createInstallSnapshot(dataDirectory, activeSelection(), 'manual')
  const result = await dialog.showSaveDialog(window!, {
    title: 'Export Dinkster install snapshot',
    defaultPath: `dinkster-install-${snapshot.selection.commit.slice(0, 12)}.json`,
    filters: [{ name: 'Dinkster install snapshot', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return undefined
  await writeInstallSnapshot(result.filePath, snapshot)
  return result.filePath
}))
ipcMain.handle('desktop:import-snapshot', (event) => serializeLifecycle(async () => {
  trustedIpc(event)
  const result = await dialog.showOpenDialog(window!, {
    title: 'Restore Dinkster install snapshot', properties: ['openFile'],
    filters: [{ name: 'Dinkster install snapshot', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePaths[0]) return undefined
  const snapshot = await readInstallSnapshot(result.filePaths[0])
  const installed = await listEngineReleases(dataDirectory, activeSelection())
  if (snapshot.selection.commit !== ENGINE_RELEASE.commit && !installed.some((release) =>
    release.commit === snapshot.selection.commit && release.variant === snapshot.selection.variant)) {
    throw new Error(`snapshot release ${snapshot.selection.commit.slice(0, 12)} is not installed by this desktop`)
  }
  await changeEngine({ ...snapshot.selection, followPackaged: false }, 'snapshot-restore', snapshot.dependencies)
  return snapshot
}))
ipcMain.handle('desktop:system-check', async (event) => {
  trustedIpc(event)
  return systemCheck(dataDirectory, activeSelection(), await gpuCheck())
})
ipcMain.handle('desktop:clear-cache', (event) => serializeLifecycle(async () => {
  trustedIpc(event)
  await rm(join(dataDirectory, 'cache', 'uv'), { recursive: true, force: true })
  await sendInfo()
}))
ipcMain.handle('desktop:export-support-report', (event) => serializeLifecycle(async () => {
  trustedIpc(event)
  const result = await dialog.showSaveDialog(window!, {
    title: 'Export Dinkster support report',
    defaultPath: `dinkster-support-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return undefined
  const report = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    lifecycle: runtime.status,
    desktop: await desktopInfo(),
    system: await systemCheck(dataDirectory, activeSelection(), await gpuCheck()),
    snapshot: await createInstallSnapshot(dataDirectory, activeSelection(), 'manual'),
    logs: {
      engine: await engineLog.readTail(),
      desktop: await shellLog.readTail(),
    },
  }, null, 2)}\n`
  await writeFile(result.filePath, redactDiagnosticText(report))
  return result.filePath
}))

autoUpdater.on('error', () => {
  void shellLog.append('Desktop updater reported an error; startup update status contains the result.')
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  setImmediate(() => { void serializeLifecycle(shutdown) })
})

// dinkster:// launches. In dev (process.defaultApp) the OS must invoke the
// electron binary with the app path, or the registration would point at a
// bare electron that cannot find the app.
if (process.defaultApp) {
  if (process.argv.length >= 2 && process.argv[1]) {
    app.setAsDefaultProtocolClient('dinkster', process.execPath, [resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('dinkster')
}

const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', (_event, argv) => {
  const link = deepLinkFromArgv(argv)
  if (link) {
    void routeDeepLink(link)
    return
  }
  window?.show()
  window?.focus()
})
// macOS delivers protocol launches as open-url instead of argv.
app.on('open-url', (event, url) => {
  event.preventDefault()
  const link = parseDeepLink(url)
  if (link) void routeDeepLink(link)
})

if (primaryInstance) app.whenReady().then(async () => {
  lifecycleLease = await acquireLifecycleLease(dataDirectory)
  const shellUpdate = await shellUpdater.start()
  if (shellUpdate.state === 'installing') return
  nativeTheme.on('updated', () => {
    for (const managed of windows.values()) diagnosticCall('window-background', () => managed.setBackgroundColor(windowBackground()))
    if (projectWindow && !diagnosticCall('window-destroyed', () => projectWindow!.isDestroyed())) diagnosticCall('window-background', () => projectWindow!.setBackgroundColor(windowBackground()))
    for (const remote of remoteWindows.keys()) diagnosticCall('window-background', () => remote.setBackgroundColor(windowBackground()))
  })
  if (!process.env['DINKSTER_ENGINE_SOURCE']) {
    credentialStore = await CredentialStore.open(join(dataDirectory, 'credentials.json'), desktopCredentialCipher())
    applyCredentialHeaders()
    await createProjectManager()
    tray = new Tray(trayIcon())
    tray.setToolTip('Dinkster Desktop')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Projects', click: () => { void createProjectManager() } },
      { label: 'About Dinkster Desktop', click: () => { void showAbout() } },
      { type: 'separator' },
      { label: 'Quit', click: () => { void serializeLifecycle(shutdown) } },
    ]))
    tray.on('double-click', () => { void createProjectManager() })
    return
  }
  backendPort = await availableLoopbackPort()
  const persistedDiagnostic = (message: string): void => { void shellLog.append(message) }
  const interrupted = await readEngineOperation(dataDirectory, persistedDiagnostic)
  selection = interrupted?.previous ?? await readStoredEngineSelection(dataDirectory, persistedDiagnostic)
  runtime = createRuntime(selection)
  attachRuntime(runtime)
  credentialStore = await CredentialStore.open(join(dataDirectory, 'credentials.json'), desktopCredentialCipher())
  applyCredentialHeaders()
  await windowQueue.run(createWindow)
  const launchLink = deepLinkFromArgv(process.argv.slice(1))
  if (launchLink) preReadyLinks.unshift(launchLink) // launch argv precedes any staged open-url
  windowsReady = true
  for (const link of preReadyLinks.splice(0)) void routeDeepLink(link)
  tray = new Tray(trayIcon())
  tray.setToolTip('Dinkster Desktop')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Dinkster', click: () => window?.show() },
    { label: 'About Dinkster Desktop', click: () => { void showAbout() } },
    { type: 'separator' },
    { label: 'Quit', click: () => { void serializeLifecycle(shutdown) } },
  ]))
  tray.on('double-click', () => window?.show())
  void serializeLifecycle(async () => {
    if (interrupted) {
      await runtime.start()
      await writeEngineSelection(dataDirectory, interrupted.previous)
      selection = interrupted.previous
      await clearEngineOperation(dataDirectory)
      return
    }
    if (selection?.followPackaged && selection.commit !== ENGINE_RELEASE.commit) {
      await changeEngine({ ...selection, commit: ENGINE_RELEASE.commit }, 'packaged-update')
      return
    }
    await runtime.start()
    if (!selection) {
      selection = { commit: ENGINE_RELEASE.commit, variant: runtime.status.variant ?? 'cpu', followPackaged: true }
      await writeEngineSelection(dataDirectory, selection)
    }
  }).catch(() => undefined)
}).catch((error: unknown) => {
  console.error(error)
  void shellLog.append(redactDiagnosticText(error instanceof Error ? error.stack ?? error.message : String(error)))
  app.quit()
})

app.on('window-all-closed', () => { void serializeLifecycle(shutdown) })
