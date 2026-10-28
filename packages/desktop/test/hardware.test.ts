import { describe, expect, it } from 'vitest'
import { detectNvidiaGpus, planVariant, type NvidiaGpu, type VariantHardware } from '../src/hardware.js'

const manifests: readonly VariantHardware[] = [
  { variant: 'win-nvidia-cu126', platform: { os: 'windows', arch: 'x86_64' }, nvidia: { minimumDriver: '525', minimumComputeCapability: '5.0', maximumExclusiveComputeCapability: '10.0' } },
  { variant: 'win-cpu', platform: { os: 'windows', arch: 'x86_64' }, nvidia: null },
  { variant: 'win-nvidia', platform: { os: 'windows', arch: 'x86_64' }, nvidia: { minimumDriver: '580', minimumComputeCapability: '7.5', maximumExclusiveComputeCapability: null } },
  { variant: 'linux-cpu', platform: { os: 'linux', arch: 'x86_64' }, nvidia: null },
]
const gpus: readonly NvidiaGpu[] = [
  { id: '0', name: 'Display GPU', driver: '580.10', computeCapability: '6.1' },
  { id: '1', name: 'Compute GPU', driver: '580.10', computeCapability: '8.9' },
]

describe('project hardware plan', () => {
  it('reads indexes, driver, compute capability and memory for every GPU', async () => {
    const facts = await detectNvidiaGpus('win32', async (file, args) => {
      expect(file).toBe('nvidia-smi')
      expect(args).toEqual(['--query-gpu=index,name,driver_version,compute_cap,memory.total', '--format=csv,noheader'])
      return '0, Display GPU, 580.10, 6.1, 8192 MiB\r\n1, Compute GPU, 580.10, 8.9, 24576 MiB\r\n'
    })
    expect(facts).toEqual({ gpus: [
      { ...gpus[0], memoryMiB: 8192 }, { ...gpus[1], memoryMiB: 24576 },
    ] })
  })

  it('uses Windows controller detection only when nvidia-smi is absent', async () => {
    const facts = await detectNvidiaGpus('win32', async (file) => {
      if (file === 'nvidia-smi') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      expect(file).toBe('powershell.exe')
      return JSON.stringify([
        { PNPDeviceID: 'pci-nvidia', Name: 'RTX GPU', AdapterCompatibility: 'NVIDIA' },
        { PNPDeviceID: 'pci-intel', Name: 'Display GPU', AdapterCompatibility: 'Intel' },
      ])
    })
    expect(facts.gpus).toEqual([{ id: 'pci-nvidia', name: 'RTX GPU' }])
    const plan = planVariant(manifests, facts, ['pci-nvidia'], 'win32')
    expect(plan.selected).toBeUndefined()
    expect(plan.reason).toContain('driver 525')
    expect(plan.choices.find((choice) => choice.variant === 'win-cpu')?.supported).toBe(true)
    const failed = await detectNvidiaGpus('win32', async () => { throw new Error('driver failed') })
    expect(failed.gpus).toEqual([])
    expect(failed.diagnostic).toContain('detection failed')
  })

  it('uses only assigned GPUs and supports multiple assigned GPUs', () => {
    expect(planVariant(manifests, { gpus }, ['1'], 'win32').selected).toBe('win-nvidia')
    expect(planVariant(manifests, { gpus }, ['0', '1'], 'win32').selected).toBe('win-nvidia-cu126')
    const modern = planVariant(manifests, { gpus }, ['1'], 'win32')
    expect(modern.reason).toContain('lowest compute capability 8.9')
    expect(planVariant(manifests, { gpus }, ['missing'], 'win32').selected).toBeUndefined()
  })

  it('checks the driver before capability and never silently chooses CPU', () => {
    const old = gpus.map((gpu) => ({ ...gpu, driver: '524.99' }))
    const plan = planVariant(manifests, { gpus: old }, ['1'], 'win32')
    expect(plan.selected).toBeUndefined()
    expect(plan.reason).toContain('Requires NVIDIA driver 525')
    expect(plan.reason).toContain('win-nvidia-cu126: Compute GPU: driver 524.99. Requires NVIDIA driver 525')
    expect(plan.reason).toContain('win-nvidia: Compute GPU: driver 524.99. Requires NVIDIA driver 580')
    const transitional = gpus.map((gpu) => ({ ...gpu, driver: '579.99' }))
    expect(planVariant(manifests, { gpus: transitional }, ['1'], 'win32').selected).toBe('win-nvidia-cu126')
    expect(planVariant(manifests, { gpus: gpus.map((gpu) => ({ ...gpu, driver: '525.0' })) }, ['1'], 'win32').selected).toBe('win-nvidia-cu126')
    expect(planVariant(manifests, { gpus: [] }, [], 'win32').selected).toBeUndefined()
    expect(planVariant(manifests, { gpus: old }, ['1'], 'win32', 'win-cpu').selected).toBe('win-cpu')
    expect(planVariant(manifests, { gpus: old }, ['1'], 'win32', 'win-nvidia').reason).toContain('Explicit override:')
  })

  it('applies both capability boundaries from manifest data, not GPU model names', () => {
    const assigned = (capability: string) => [{ id: '1', name: 'arbitrary GPU', driver: '580.0', computeCapability: capability }]
    expect(planVariant(manifests, { gpus: assigned('7.4') }, ['1'], 'win32').selected).toBe('win-nvidia-cu126')
    expect(planVariant(manifests, { gpus: assigned('7.5') }, ['1'], 'win32').selected).toBe('win-nvidia')
    const oldDriver = assigned('10.0').map((gpu) => ({ ...gpu, driver: '579' }))
    expect(planVariant(manifests, { gpus: oldDriver }, ['1'], 'win32').selected).toBeUndefined()
    const raised = manifests.map((manifest) => manifest.nvidia ? { ...manifest, nvidia: { ...manifest.nvidia, minimumDriver: '600' } } : manifest)
    expect(planVariant(raised, { gpus }, ['1'], 'win32').selected).toBeUndefined()
    expect(planVariant(manifests, { gpus }, ['1'], 'linux').choices.map((choice) => choice.variant)).toEqual(['linux-cpu'])
    expect(() => planVariant(manifests, { gpus }, ['1'], 'linux', 'win-nvidia')).toThrow('not available')
  })

  it('compares numeric dotted components for driver and capability bounds', async () => {
    const facts = await detectNvidiaGpus('win32', async () => '1, GPU, 580.10.1, 7.10, 8192 MiB')
    expect(facts.gpus[0]?.computeCapability).toBe('7.10')
    const dotted = manifests.map((manifest) => manifest.nvidia && manifest.variant === 'win-nvidia'
      ? { ...manifest, nvidia: { ...manifest.nvidia, minimumDriver: '580.9.99' } } : manifest)
    expect(planVariant(dotted, facts, ['1'], 'win32').selected).toBe('win-nvidia')
    const cu126Only = manifests.filter((manifest) => manifest.variant !== 'win-nvidia')
    const assigned = (capability: string) => ({ gpus: [{ id: '1', name: 'GPU', driver: '580', computeCapability: capability }] })
    expect(planVariant(cu126Only, assigned('9.99'), ['1'], 'win32').selected).toBe('win-nvidia-cu126')
    expect(planVariant(cu126Only, assigned('10.0'), ['1'], 'win32').selected).toBeUndefined()
    expect(planVariant(cu126Only, assigned('5.0'), ['1'], 'win32').selected).toBe('win-nvidia-cu126')
    expect(planVariant(cu126Only, assigned('4.99'), ['1'], 'win32').selected).toBeUndefined()
  })

  it('uses explicit platform metadata rather than interpreting variant labels', () => {
    const renamed = manifests.map((manifest) => ({ ...manifest, variant: `custom-${manifest.variant}` }))
    expect(planVariant(renamed, { gpus }, ['1'], 'win32').selected).toBe('custom-win-nvidia')
    const misleading: VariantHardware[] = [{ variant: 'win-nvidia', platform: { os: 'linux', arch: 'x86_64' }, nvidia: manifests[2]!.nvidia }]
    expect(planVariant(misleading, { gpus }, ['1'], 'win32').choices).toEqual([])
    expect(planVariant(misleading, { gpus }, ['1'], 'linux').selected).toBe('win-nvidia')
    expect(planVariant(manifests, { gpus }, ['1'], 'win32', undefined, 'arm64').choices).toEqual([])
  })
})
