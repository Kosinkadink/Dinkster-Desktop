import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ProjectDialogBridge } from './project-dialog.js'
import type { DesktopProjects } from './projects.js'
import type {
  DesktopBridge,
  DesktopConnectionCredentials,
  DesktopDeepLink,
  DesktopDroppedFileResult,
  DesktopFileCapabilities,
  DesktopInfo,
  DesktopRemoteWorker,
  DesktopRemoteWorkerFileChoice,
  DesktopSystemCheck,
  DesktopWindowContext,
  DesktopWindowLayout,
  LifecycleStatus,
} from './types.js'

const bridge: DesktopBridge = {
  locale: () => ipcRenderer.invoke('desktop:locale') as Promise<string>,
  status: () => ipcRenderer.invoke('desktop:status') as Promise<LifecycleStatus>,
  retry: () => ipcRenderer.invoke('desktop:retry') as Promise<void>,
  info: () => ipcRenderer.invoke('desktop:info') as Promise<DesktopInfo>,
  selectEngine: (commit, variant) => ipcRenderer.invoke('desktop:select-engine', commit, variant) as Promise<void>,
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates') as Promise<void>,
  installUpdate: () => ipcRenderer.invoke('desktop:install-update') as Promise<void>,
  fileCapabilities: (backendUrl) => ipcRenderer.invoke('desktop:file-capabilities', backendUrl) as Promise<DesktopFileCapabilities>,
  chooseDirectory: (backendUrl) => ipcRenderer.invoke('desktop:choose-directory', backendUrl) as Promise<string | undefined>,
  revealFile: (backendUrl, asset) => ipcRenderer.invoke('desktop:reveal-file', backendUrl, asset) as Promise<{ mode: 'selected' | 'folder' }>,
  resolveDroppedFile: async (backendUrl, file) => {
    let path: string
    try { path = webUtils.getPathForFile(file) }
    catch { throw new Error('Native file resolution requires a File') }
    if (!path) return { status: 'refused', reason: 'not-native-file' }
    return ipcRenderer.invoke('desktop:resolve-dropped-file', backendUrl, path) as Promise<DesktopDroppedFileResult>
  },
  exportSnapshot: () => ipcRenderer.invoke('desktop:export-snapshot') as Promise<string | undefined>,
  importSnapshot: () => ipcRenderer.invoke('desktop:import-snapshot') as Promise<unknown | undefined>,
  systemCheck: () => ipcRenderer.invoke('desktop:system-check') as Promise<DesktopSystemCheck>,
  clearCache: () => ipcRenderer.invoke('desktop:clear-cache') as Promise<void>,
  exportSupportReport: () => ipcRenderer.invoke('desktop:export-support-report') as Promise<string | undefined>,
  windowContext: () => ipcRenderer.invoke('desktop:window-context') as Promise<DesktopWindowContext>,
  windowLayout: () => ipcRenderer.invoke('desktop:window-layout') as Promise<DesktopWindowLayout>,
  openWorkflowWindow: (workflowId, x, y) => ipcRenderer.invoke('desktop:open-workflow-window', workflowId, x, y) as Promise<void>,
  openPanelWindow: (panelId, returnPlacement) => ipcRenderer.invoke('desktop:open-panel-window', panelId, returnPlacement) as Promise<void>,
  redockWindow: () => ipcRenderer.invoke('desktop:redock-window') as Promise<void>,
  switchProject: (projectId) => ipcRenderer.invoke('desktop:switch-project', projectId) as Promise<void>,
  openProjectWindow: (projectId) => ipcRenderer.invoke('desktop:open-project-window', projectId) as Promise<void>,
  setConnectionCredential: (profileId, url, secret) => ipcRenderer.invoke('desktop:set-connection-credential', profileId, url, secret) as Promise<void>,
  retireConnectionProfile: (profileId) => ipcRenderer.invoke('desktop:retire-connection-profile', profileId) as Promise<void>,
  connectionCredentials: () => ipcRenderer.invoke('desktop:connection-credentials') as Promise<DesktopConnectionCredentials>,
  remoteWorkers: () => ipcRenderer.invoke('desktop:remote-workers') as Promise<readonly DesktopRemoteWorker[]>,
  saveRemoteWorker: (worker) => ipcRenderer.invoke('desktop:save-remote-worker', worker) as Promise<void>,
  removeRemoteWorker: (name) => ipcRenderer.invoke('desktop:remove-remote-worker', name) as Promise<void>,
  chooseRemoteWorkerFile: (kind) => ipcRenderer.invoke('desktop:choose-remote-worker-file', kind) as Promise<DesktopRemoteWorkerFileChoice | undefined>,
  takeDeepLinks: () => ipcRenderer.invoke('desktop:take-deep-links') as Promise<readonly DesktopDeepLink[]>,
  onStatus: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, status: LifecycleStatus) => listener(status)
    ipcRenderer.on('desktop:status-changed', receive)
    return () => ipcRenderer.removeListener('desktop:status-changed', receive)
  },
  onLog: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, line: string) => listener(line)
    ipcRenderer.on('desktop:log', receive)
    return () => ipcRenderer.removeListener('desktop:log', receive)
  },
  onInfo: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, info: DesktopInfo) => listener(info)
    ipcRenderer.on('desktop:info-changed', receive)
    return () => ipcRenderer.removeListener('desktop:info-changed', receive)
  },
  onWindowLayout: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, layout: DesktopWindowLayout) => listener(layout)
    ipcRenderer.on('desktop:window-layout-changed', receive)
    return () => ipcRenderer.removeListener('desktop:window-layout-changed', receive)
  },
  onDeepLinkPending: (listener) => {
    const receive = () => listener()
    ipcRenderer.on('desktop:deep-link-pending', receive)
    return () => ipcRenderer.removeListener('desktop:deep-link-pending', receive)
  },
}

const localFilesOnly = process.argv.includes('--dinkster-local-files')
contextBridge.exposeInMainWorld('dinksterDesktop', localFilesOnly ? {
  fileCapabilities: bridge.fileCapabilities,
  chooseDirectory: bridge.chooseDirectory,
  revealFile: bridge.revealFile,
  resolveDroppedFile: bridge.resolveDroppedFile,
} : bridge)

const projects: ProjectDialogBridge = {
  list: () => ipcRenderer.invoke('desktop:projects-list') as Promise<DesktopProjects>,
  save: (project) => ipcRenderer.invoke('desktop:projects-save', project) as Promise<void>,
  remove: (projectId) => ipcRenderer.invoke('desktop:projects-remove', projectId) as Promise<void>,
  open: (projectId, engineId) => ipcRenderer.invoke('desktop:projects-open', projectId, engineId) as Promise<void>,
  inspect: (request) => ipcRenderer.invoke('desktop:projects-inspect', request),
  plan: (project, request) => ipcRenderer.invoke('desktop:projects-plan', project, request),
  apply: (token) => ipcRenderer.invoke('desktop:projects-apply', token),
}
if (!localFilesOnly) contextBridge.exposeInMainWorld('dinksterProjects', projects)
