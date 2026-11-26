import { describe, expect, it } from 'vitest'
import { parseHardwareSelection, projectHardware, type HardwareSelection } from '../src/hardware.js'

const selection: HardwareSelection = {
  detectedCards: [
    { id: '0', name: 'Other card', driver: '595.84', computeCapability: '8.9', memoryMiB: 12288 },
    { id: '1', name: 'Compute card', driver: '595.84', computeCapability: '8.9', memoryMiB: 24576 },
  ],
  choices: [
    { variant: 'linux-nvidia', label: 'NVIDIA graphics', reason: 'Compatible card and driver.' },
    { variant: 'linux-cpu', label: 'CPU only', reason: 'Does not use the graphics card and is much slower.' },
  ],
  variant: 'linux-nvidia', buildLabel: 'NVIDIA graphics', buildReason: 'Compatible card and driver.',
  gpus: ['1'], refusal: null,
}

describe('tools-owned hardware selection', () => {
  it('passes the selected build and reasons to the project bridge without adding alternatives', () => {
    expect(projectHardware(parseHardwareSelection(selection))).toEqual({
      hardware: { gpus: selection.detectedCards },
      plan: { selected: 'linux-nvidia', gpus: ['1'], reason: 'Compatible card and driver.',
        choices: [
          { variant: 'linux-nvidia', supported: true, reason: 'Compatible card and driver.' },
          { variant: 'linux-cpu', supported: true, reason: 'Does not use the graphics card and is much slower.' },
        ] },
    })
  })

  it('keeps the tools CPU default when no supported card is found', () => {
    const cpu = { ...selection, detectedCards: [], choices: [selection.choices![1]!],
      variant: 'linux-cpu', buildLabel: 'CPU only',
      buildReason: 'Does not use the graphics card and is much slower.', gpus: [] }
    expect(projectHardware(parseHardwareSelection(cpu))).toEqual({
      hardware: { gpus: [] },
      plan: { selected: 'linux-cpu', gpus: [], reason: 'Does not use the graphics card and is much slower.',
        choices: [{ variant: 'linux-cpu', supported: true, reason: 'Does not use the graphics card and is much slower.' }] },
    })
    expect(projectHardware(parseHardwareSelection({ ...cpu, detectedCards: selection.detectedCards })).plan.gpus).toEqual([])
  })

  it('preserves each tools choice assignment independently of the detected inventory and current selection', () => {
    const choices = [
      { variant: 'win-nvidia', label: 'NVIDIA graphics', reason: 'Current.', gpus: ['0', '1'] },
      { variant: 'win-nvidia-older', label: 'Older NVIDIA graphics', reason: 'Older.', gpus: ['1'] },
      { variant: 'win-cpu', label: 'CPU only', reason: 'Slower.', gpus: [] },
    ]
    expect(projectHardware(parseHardwareSelection({ ...selection, choices })).plan.choices).toEqual(
      choices.map(({ variant, reason, gpus }) => ({ variant, reason, gpus, supported: true })),
    )
  })

  it('preserves a failed check as a diagnostic with no selected build or invented CPU alternative', () => {
    const unknown = { detectedCards: null, choices: null, variant: null, buildLabel: null, buildReason: null,
      gpus: [], refusal: { code: 'hardware-unavailable', message: 'Repair the driver and retry.' } }
    expect(projectHardware(parseHardwareSelection(unknown))).toEqual({
      hardware: { gpus: [], diagnostic: 'Repair the driver and retry.' },
      plan: { gpus: [], reason: 'Repair the driver and retry.', choices: [] },
    })
    const noDriver = { ...selection, detectedCards: [{ id: 'PCI-card', name: 'NVIDIA card',
      driver: null, computeCapability: null, memoryMiB: null }] }
    expect(projectHardware(parseHardwareSelection(noDriver)).hardware.gpus).toEqual([{ id: 'PCI-card', name: 'NVIDIA card' }])
  })

  it.each([undefined, {}, { ...selection, choices: [{}] }, { ...selection, gpus: [1] },
    ...[null, ['1', 2], '1'].map((gpus) => ({ ...selection, choices: [{ ...selection.choices![0], gpus }] })),
    { ...selection, detectedCards: [{ id: '1', name: 'GPU' }] }, { ...selection, refusal: {} }])(
    'refuses an absent or malformed tools response', (value) => {
      expect(() => parseHardwareSelection(value)).toThrow('hardware response')
    },
  )
})
