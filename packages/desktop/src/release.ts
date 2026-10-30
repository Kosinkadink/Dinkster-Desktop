import { createHash } from 'node:crypto'
import type { EngineAccelerator } from './accelerator.js'
import backend from './backend-release.json' with { type: 'json' }

const { aimdo, cudaTorch } = backend.desktopWindowsRuntime

export const ENGINE_RELEASE = {
  commit: backend.commit,
  sourceArchive: backend.archive,
  sourceSha256: backend.sha256,
  workerProtocol: backend.workerProtocol,
  aimdo,
  cudaTorch,
  nativeProfile: createHash('sha256').update(JSON.stringify([
    aimdo.sha256, cudaTorch.sha256, cudaTorch.version,
    cudaTorch.cudaVersion, cudaTorch.torchvisionVersion,
  ])).digest('hex'),
} as const

export function torchBackend(accelerator: EngineAccelerator, platform = process.platform, arch = process.arch): string | undefined {
  if (platform !== 'win32' || arch !== 'x64' || (accelerator !== 'cpu' && accelerator !== 'cuda')) return undefined
  return accelerator === 'cuda' ? ENGINE_RELEASE.cudaTorch.version.split('+')[1]! : 'cpu'
}
