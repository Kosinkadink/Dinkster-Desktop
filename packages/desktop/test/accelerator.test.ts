import { describe, expect, it, vi } from 'vitest'
import {
  configuredEngineAccelerator,
  detectEngineAccelerator,
  engineProcessEnvironment,
  persistedEngineAccelerator,
} from '../src/accelerator.js'

const host = (
  platform: NodeJS.Platform,
  architecture: string,
  commands: readonly string[] = [],
  paths: readonly string[] = [],
) => ({
  platform,
  architecture,
  commandExists: (command: string) => commands.includes(command),
  pathExists: (path: string) => paths.includes(path),
  windowsDirectory: 'C:\\Windows',
})

describe('desktop engine accelerator selection', () => {
  it('uses the worker accelerator vocabulary for host detection', () => {
    expect(detectEngineAccelerator(host('darwin', 'arm64'))).toBe('mps')
    expect(detectEngineAccelerator(host('darwin', 'x64'))).toBe('cpu')
    expect(detectEngineAccelerator(host('linux', 'x64', ['nvidia-smi']))).toBe('cuda')
    expect(detectEngineAccelerator(host('linux', 'x64', ['rocminfo']))).toBe('rocm')
    expect(detectEngineAccelerator(host('linux', 'x64', ['xpu-smi']))).toBe('xpu')
    expect(detectEngineAccelerator(host('linux', 'x64'))).toBe('cpu')
  })

  it('uses driver files without invoking an accelerator runtime', () => {
    expect(detectEngineAccelerator(host('win32', 'x64', [], ['C:\\Windows\\System32\\nvml.dll']))).toBe('cuda')
    expect(detectEngineAccelerator(host('linux', 'x64', [], ['/sys/module/amdgpu']))).toBe('rocm')
    expect(detectEngineAccelerator(host('linux', 'x64', [], ['/sys/module/intel_vsec']))).toBe('xpu')
  })

  it('migrates the legacy name and diagnoses unknown explicit selections', () => {
    expect(configuredEngineAccelerator('nvidia')).toEqual({
      accelerator: 'cuda',
      diagnostic: "Desktop engine accelerator 'nvidia' was renamed to 'cuda'; using cuda",
    })
    expect(configuredEngineAccelerator('rocm')).toEqual({ accelerator: 'rocm' })
    expect(configuredEngineAccelerator('other')).toEqual({
      accelerator: 'cpu',
      diagnostic: "Unknown desktop engine accelerator 'other'; using cpu",
    })
  })

  it('diagnoses unknown persisted selections before falling back to cpu', () => {
    const diagnostic = vi.fn()
    expect(persistedEngineAccelerator('other', diagnostic)).toBe('cpu')
    expect(diagnostic).toHaveBeenCalledWith("Unknown persisted desktop engine accelerator 'other'; using cpu")
    expect(persistedEngineAccelerator('nvidia', diagnostic)).toBe('cuda')
  })

  it('pins the selected accelerator for the supervisor and workers', () => {
    expect(engineProcessEnvironment('xpu', { KEEP: 'yes', DINKSTER_ACCELERATOR: 'cpu' })).toEqual({
      KEEP: 'yes',
      DINKSTER_ACCELERATOR: 'xpu',
    })
  })
})
