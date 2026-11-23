import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ProjectDialogBridge } from './project-dialog.js'
import type { DesktopLibraryBridge } from './library.js'
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
} from './types.js'

const bridge: DesktopBridge = {
  locale: () => ipcRenderer.invoke('desktop:locale') as Promise<string>,
  info: () => ipcRenderer.invoke('desktop:info') as Promise<DesktopInfo>,
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates') as Promise<void>,
  installUpdate: () => ipcRenderer.invoke('desktop:install-update') as Promise<void>,
  fileCapabilities: (backendUrl) => ipcRenderer.invoke('desktop:file-capabilities', backendUrl) as Promise<DesktopFileCapabilities>,
  chooseDirectory: (backendUrl) => ipcRenderer.invoke('desktop:choose-directory', backendUrl) as Promise<string | undefined>,
  revealFile: (backendUrl, asset) => ipcRenderer.invoke('desktop:reveal-file', backendUrl, asset) as Promise<{ mode: 'selected' | 'folder' }>,
  revealModelLocation: (backendUrl, location) => ipcRenderer.invoke('desktop:reveal-model-location', backendUrl, location) as Promise<void>,
  resolveDroppedFile: async (backendUrl, file) => {
    let path: string
    try { path = webUtils.getPathForFile(file) }
    catch { throw new Error('Native file resolution requires a File') }
    if (!path) return { status: 'refused', reason: 'not-native-file' }
    return ipcRenderer.invoke('desktop:resolve-dropped-file', backendUrl, path) as Promise<DesktopDroppedFileResult>
  },
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
const libraryOnly = process.argv.includes('--dinkster-library')
const library: DesktopLibraryBridge = {
  reviewRestore: (installation, project, entry, scope) => ipcRenderer.invoke('desktop:library-restore-review', installation, project, entry, scope),
  applyRestore: (token, alternative) => ipcRenderer.invoke('desktop:library-restore-apply', token, alternative),
  history: (installation, project) => ipcRenderer.invoke('desktop:library-history', installation, project),
  open: (installation, project) => ipcRenderer.invoke('desktop:library-open', installation, project),
  installations: () => ipcRenderer.invoke('desktop:library-installations'),
  projects: (installation, cursor) => ipcRenderer.invoke('desktop:library-projects', installation, cursor),
  workflows: (installation, project, cursor) => ipcRenderer.invoke('desktop:library-workflows', installation, project, cursor),
  assets: (installation, project, cursor) => ipcRenderer.invoke('desktop:library-assets', installation, project, cursor),
}
if (libraryOnly) contextBridge.exposeInMainWorld('dinksterLibrary', library)
if (!libraryOnly) contextBridge.exposeInMainWorld('dinksterDesktop', localFilesOnly ? {
  fileCapabilities: bridge.fileCapabilities,
  chooseDirectory: bridge.chooseDirectory,
  revealFile: bridge.revealFile,
  revealModelLocation: bridge.revealModelLocation,
  resolveDroppedFile: bridge.resolveDroppedFile,
} : bridge)

const projects: ProjectDialogBridge = {
  wslStatus: () => ipcRenderer.invoke('desktop:wsl-status'),
  prepareWsl: () => ipcRenderer.invoke('desktop:wsl-prepare'),
  wslProjectRoot: (id) => ipcRenderer.invoke('desktop:wsl-project-root', id),
  copyWslModels: () => ipcRenderer.invoke('desktop:wsl-copy-models'),
  list: () => ipcRenderer.invoke('desktop:projects-list') as Promise<DesktopProjects>,
  save: (project) => ipcRenderer.invoke('desktop:projects-save', project) as Promise<void>,
  sandbox: (root) => ipcRenderer.invoke('desktop:projects-sandbox', root),
  remove: (projectId) => ipcRenderer.invoke('desktop:projects-remove', projectId) as Promise<void>,
  open: (projectId, engineId) => ipcRenderer.invoke('desktop:projects-open', projectId, engineId) as Promise<void>,
  inspect: (request) => ipcRenderer.invoke('desktop:projects-inspect', request),
  plan: (project, request) => ipcRenderer.invoke('desktop:projects-plan', project, request),
  apply: (token) => ipcRenderer.invoke('desktop:projects-apply', token),
}
if (!localFilesOnly && !libraryOnly) contextBridge.exposeInMainWorld('dinksterProjects', projects)
