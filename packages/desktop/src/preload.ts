import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopBridge,
  DesktopConnectionCredentials,
  DesktopDeepLink,
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
  chooseDirectory: () => ipcRenderer.invoke('desktop:choose-directory') as Promise<string | undefined>,
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

contextBridge.exposeInMainWorld('dinksterDesktop', bridge)
