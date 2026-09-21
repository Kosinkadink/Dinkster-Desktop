import { describe, expect, it } from 'vitest'
import { ENGINE_RELEASE, supportedPlatform, syncArguments, torchBackend } from '../src/release.js'
import backend from '../src/backend-release.json'

describe('engine release selection', () => {
  it('pins the engine source and uv payloads by checksum', () => {
    expect(backend.repository).toBe('Kosinkadink/Dinkster')
    expect(backend.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(backend.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(backend.archive).toBe(`dinkster-backend-${backend.commit}.zip`)
    expect(backend.releaseTag).toBe(`backend-${backend.commit}`)
    expect(backend.identityCommit).toMatch(/^[a-f0-9]{40}$/)
    const { aimdo, cudaTorch } = backend.desktopWindowsRuntime
    expect(aimdo.repository).toBe('Kosinkadink/dinkster-aimdo')
    expect(aimdo.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(aimdo.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(aimdo.releaseTag).toBe(`v${aimdo.version}`)
    expect(aimdo.archive).toBe(`dinkster_aimdo-${aimdo.version}-cp39-abi3-win_amd64.whl`)
    expect(ENGINE_RELEASE).toMatchObject({
      commit: backend.commit,
      sourceSha256: backend.sha256,
      workerProtocol: backend.workerProtocol,
      aimdo,
      cudaTorch,
      uvVersion: '0.12.5',
      uv: {
        'win32-x64': {
          sha256: '4c4d49d8738847d9b71ba319e49a5688c93eac0fe6204b1df24e98528dddf39a',
          executableSha256: '8da6cedef60c27ac997ebf400fbfc6d373c5b0a7ae6a299b9d52be7fe63723fb',
        },
        'linux-x64': {
          sha256: '68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2',
          executableSha256: 'b65f23a420c4acc96427efb30e5ed9bc0f7e25d2d712000f6ede77c1a0de5f46',
        },
      },
    })
  })

  it('uses one locked provisioning path for every accelerator', () => {
    for (const accelerator of ['cpu', 'cuda', 'mps', 'rocm', 'xpu'] as const) {
      expect(syncArguments(accelerator)).toEqual([
        'sync', '--python', '3.12', '--locked', '--no-dev', '--all-packages', '--extra', 'torch',
      ])
    }
  })

  it('pins the supplemental Windows CUDA wheel separately from the backend lock', () => {
    const pin = ENGINE_RELEASE.cudaTorch
    const url = new URL(pin.url)
    expect(url.origin).toBe('https://download-r2.pytorch.org')
    expect(decodeURIComponent(url.pathname)).toBe(`/whl/cu130/${pin.archive}`)
    expect(pin.archive).toBe(`torch-${pin.version}-cp312-cp312-win_amd64.whl`)
    expect(pin.version).toBe('2.13.0+cu130')
    expect(pin.cudaVersion).toBe('13.0')
    expect(torchBackend('cuda', 'win32', 'x64')).toBe('cu130')
    expect(torchBackend('cpu', 'win32', 'x64')).toBe('cpu')
    expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(pin.size).toBeGreaterThan(0)
  })

  it('does not apply Windows native pins to other accelerators or platforms', () => {
    for (const accelerator of ['mps', 'rocm', 'xpu'] as const) {
      expect(torchBackend(accelerator, 'win32', 'x64')).toBeUndefined()
    }
    for (const accelerator of ['cpu', 'cuda'] as const) {
      expect(torchBackend(accelerator, 'linux', 'x64')).toBeUndefined()
      expect(torchBackend(accelerator, 'darwin', 'arm64')).toBeUndefined()
      expect(torchBackend(accelerator, 'win32', 'arm64')).toBeUndefined()
    }
  })

  it('refuses unmanifested platforms', () => {
    expect(() => supportedPlatform('darwin', 'arm64')).toThrow('does not support darwin/arm64')
  })
})
