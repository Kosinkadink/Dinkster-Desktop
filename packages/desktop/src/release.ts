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
  uvVersion: '0.12.5',
  uv: {
    'win32-x64': {
      archive: 'uv-x86_64-pc-windows-msvc.zip',
      sha256: '4c4d49d8738847d9b71ba319e49a5688c93eac0fe6204b1df24e98528dddf39a',
      executable: 'uv.exe',
      executableSha256: '8da6cedef60c27ac997ebf400fbfc6d373c5b0a7ae6a299b9d52be7fe63723fb',
    },
    'linux-x64': {
      archive: 'uv-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2',
      executable: 'uv-x86_64-unknown-linux-gnu/uv',
      executableSha256: 'b65f23a420c4acc96427efb30e5ed9bc0f7e25d2d712000f6ede77c1a0de5f46',
    },
  },
} as const

export type SupportedPlatform = keyof typeof ENGINE_RELEASE.uv

export function supportedPlatform(platform = process.platform, arch = process.arch): SupportedPlatform {
  const key = `${platform}-${arch}`
  if (!(key in ENGINE_RELEASE.uv)) {
    throw new Error(`Dinkster Desktop does not support ${platform}/${arch}`)
  }
  return key as SupportedPlatform
}

export function syncArguments(_accelerator: EngineAccelerator): readonly string[] {
  return ['sync', '--python', '3.12', '--locked', '--no-dev', '--all-packages', '--extra', 'torch']
}

export function torchBackend(accelerator: EngineAccelerator, platform = process.platform, arch = process.arch): string | undefined {
  if (platform !== 'win32' || arch !== 'x64' || (accelerator !== 'cpu' && accelerator !== 'cuda')) return undefined
  return accelerator === 'cuda' ? ENGINE_RELEASE.cudaTorch.version.split('+')[1]! : 'cpu'
}
