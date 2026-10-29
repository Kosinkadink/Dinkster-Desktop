import { describe, expect, it } from 'vitest'
import { ENGINE_RELEASE, torchBackend } from '../src/release.js'
import backend from '../src/backend-release.json'

describe('engine release selection', () => {
  it('pins the engine source payload by checksum', () => {
    expect(backend.repository).toBe('Kosinkadink/Dinkster')
    expect(backend.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(backend.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(backend.version).toMatch(/^\d+\.\d+\.\d+\.dev\d+\+g[a-f0-9]{40}$/)
    expect(backend.version.endsWith(`+g${backend.commit}`)).toBe(true)
    expect(backend.archive).toBe(`dinkster-source-${backend.version}.zip`)
    expect(backend.releaseTag).toBe(`main-${backend.commit}`)
    expect(backend.bootstrap.requiresGit).toBe(false)
    expect(backend).not.toHaveProperty('identityCommit')
    expect(backend).not.toHaveProperty('install')
    const { aimdo, cudaTorch } = backend.desktopWindowsRuntime
    expect(aimdo.repository).toBe('Comfy-Org/comfy-aimdo')
    expect(new URL(aimdo.url).origin).toBe('https://files.pythonhosted.org')
    expect(aimdo.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(aimdo.releaseTag).toBe(`v${aimdo.version}`)
    expect(aimdo.archive).toBe(`comfy_aimdo-${aimdo.version}-cp39-abi3-win_amd64.whl`)
    expect(ENGINE_RELEASE).toMatchObject({
      commit: backend.commit,
      sourceSha256: backend.sha256,
      workerProtocol: backend.workerProtocol,
      aimdo,
      cudaTorch,
    })
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

})
