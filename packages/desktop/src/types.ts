import type { DesktopProject, DesktopProjects } from './projects.js'
import type { EnvironmentRequest, EnvironmentResult, SandboxReadiness } from './environment.js'
import type { HardwareDetection, VariantPlan } from './hardware.js'
import type { WslStatus } from './wsl.js'

export interface ProjectDialogBridge {
  wslStatus(): Promise<WslStatus>
  prepareWsl(): Promise<WslStatus>
  wslProjectRoot(id: string): Promise<string>
  copyWslModels(): Promise<string | undefined>
  list(): Promise<DesktopProjects>
  save(project: DesktopProject): Promise<void>
  sandbox(root: string): Promise<SandboxReadiness | undefined>
  remove(projectId: string): Promise<void>
  open(projectId: string, engineId: string): Promise<void>
  inspect(request: EnvironmentRequest): Promise<{ result: EnvironmentResult; hardware: HardwareDetection; plan: VariantPlan }>
  plan(project: DesktopProject, request: EnvironmentRequest): Promise<{ token?: string; result: EnvironmentResult }>
  apply(token: string): Promise<EnvironmentResult>
}

export interface DesktopInfo {
  readonly appVersion: string
  readonly storageBytes: number
  readonly update: { readonly state: 'idle' | 'checking' | 'available' | 'ready' | 'current' | 'installing' | 'failed'; readonly detail: string }
}

export interface DesktopSystemCheck {
  readonly platform: string
  readonly architecture: string
  readonly freeBytes: number
  readonly totalBytes: number
  readonly gpu: { readonly available: boolean; readonly name?: string; readonly driver?: string; readonly memoryMiB?: number }
}

export type DesktopPanelPlacement = 'dock' | 'rail' | 'bottom'

export type DesktopWindowContext =
  | { readonly id: string; readonly kind: 'primary' }
  | { readonly id: string; readonly kind: 'workflow'; readonly workflowId: string }
  | {
      readonly id: string
      readonly kind: 'panel'
      readonly panelId: string
      readonly returnPlacement: DesktopPanelPlacement
    }

export interface DesktopWindowLayout {
  readonly windows: readonly DesktopWindowContext[]
}

/**
 * A validated dinkster:// request: identifiers only, never credentials. The
 * project id is 'default' or a project registry id; the backend URL, when
 * present, names the connection that owns the workflow record.
 */
export interface DesktopDeepLink {
  readonly projectId: string
  readonly workflowId: string
  readonly backendUrl?: string
}

export interface DesktopConnectionCredentials {
  /** Whether OS-keychain-backed encryption is available for storing secrets. */
  readonly custody: boolean
  /** Profile ids that have a stored credential. */
  readonly profiles: readonly string[]
}

export interface DesktopRemoteWorkerMemory {
  readonly device: string
  readonly size: string
}

export interface DesktopRemoteWorker {
  readonly name: string
  readonly endpoint: string
  readonly tokenFile: string
  readonly tlsCaFile?: string
  readonly nodes?: readonly string[]
  readonly memory: readonly DesktopRemoteWorkerMemory[]
}

export interface DesktopRemoteWorkerFileChoice {
  readonly path: string
  readonly grant: string
}

export interface DesktopRemoteWorkerSave extends DesktopRemoteWorker {
  readonly tokenFileGrant?: string
  readonly tlsCaFileGrant?: string
}

export interface DesktopFileCapabilities {
  readonly nativeFolderChoice: boolean
  readonly reveal: boolean
  readonly resolvePath?: boolean
}

export interface DesktopAssetIdentity {
  readonly digest: string
  readonly scope: string
  readonly project: string
}

export type DesktopDroppedFileResult =
  | { readonly status: 'resolved'; readonly asset: {
      readonly digest: string
      readonly name: string
      readonly size: number
      readonly mediaType: string
      readonly virtualPath: string
    } }
  | { readonly status: 'refused'; readonly reason: 'not-resolvable' | 'not-native-file' | 'unsupported-backend' }

export type DesktopSaveResult =
  | { readonly status: 'saved'; readonly name: string }
  | { readonly status: 'closed' }

export interface DesktopBridge {
  saveFile(bytes: Uint8Array, suggestedName: string): Promise<DesktopSaveResult>
  locale(): Promise<string>
  info(): Promise<DesktopInfo>
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
  fileCapabilities(backendUrl: string): Promise<DesktopFileCapabilities>
  chooseDirectory(backendUrl: string): Promise<string | undefined>
  revealFile(backendUrl: string, asset: DesktopAssetIdentity): Promise<{ mode: 'selected' | 'folder' }>
  revealModelLocation(backendUrl: string, location: string): Promise<void>
  resolveDroppedFile(backendUrl: string, file: File): Promise<DesktopDroppedFileResult>
  systemCheck(): Promise<DesktopSystemCheck>
  clearCache(): Promise<void>
  exportSupportReport(): Promise<string | undefined>
  windowContext(): Promise<DesktopWindowContext>
  windowLayout(): Promise<DesktopWindowLayout>
  openWorkflowWindow(workflowId: string, x?: number, y?: number): Promise<void>
  openPanelWindow(panelId: string, returnPlacement: DesktopPanelPlacement): Promise<void>
  redockWindow(): Promise<void>
  switchProject(projectId: string): Promise<void>
  openProjectWindow(projectId: string): Promise<void>
  setConnectionCredential(profileId: string, url: string | undefined, secret: string | null): Promise<void>
  /**
   * Clear a deleted profile's credential and permanently refuse later sets
   * for its id, so an in-flight save from another window cannot recreate an
   * unmanageable credential. Removal only; token clearing uses
   * setConnectionCredential with a null secret.
   */
  retireConnectionProfile(profileId: string): Promise<void>
  connectionCredentials(): Promise<DesktopConnectionCredentials>
  remoteWorkers(): Promise<readonly DesktopRemoteWorker[]>
  saveRemoteWorker(worker: DesktopRemoteWorkerSave): Promise<void>
  removeRemoteWorker(name: string): Promise<void>
  chooseRemoteWorkerFile(kind: 'token' | 'tls-ca'): Promise<DesktopRemoteWorkerFileChoice | undefined>
  takeDeepLinks(): Promise<readonly DesktopDeepLink[]>
  onInfo(listener: (info: DesktopInfo) => void): () => void
  onWindowLayout(listener: (layout: DesktopWindowLayout) => void): () => void
  onDeepLinkPending(listener: () => void): () => void
}
