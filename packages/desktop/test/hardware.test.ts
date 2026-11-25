import { describe, expect, it } from 'vitest'
import { parseHardwareSelection, projectHardware, type HardwareSelection } from '../src/hardware.js'

const selection: HardwareSelection = {
  detectedCards: [{ id: '1', name: 'Compute card', driver: '595.84', computeCapability: '8.9', memoryMiB: 24576 }],
  choices: [{ variant: 'linux-nvidia', label: 'Linux with NVIDIA graphics', reason: 'Compatible card and driver.' }],
  variant: 'linux-nvidia', buildLabel: 'Linux with NVIDIA graphics', buildReason: 'Compatible card and driver.',
  gpus: ['1'], refusal: null,
}

describe('tools-owned hardware selection', () => {
  it('passes the selected build and reasons to the project bridge without adding alternatives', () => {
    expect(projectHardware(parseHardwareSelection(selection))).toEqual({
      hardware: { gpus: selection.detectedCards },
      plan: { selected: 'linux-nvidia', reason: 'Compatible card and driver.',
        choices: [{ variant: 'linux-nvidia', supported: true, reason: 'Compatible card and driver.' }] },
    })
  })

  it('preserves a failed check as a diagnostic with no selected build or invented CPU alternative', () => {
    const unknown = { detectedCards: null, choices: null, variant: null, buildLabel: null, buildReason: null,
      gpus: [], refusal: { code: 'hardware-unavailable', message: 'Repair the driver and retry.' } }
    expect(projectHardware(parseHardwareSelection(unknown))).toEqual({
      hardware: { gpus: [], diagnostic: 'Repair the driver and retry.' },
      plan: { reason: 'Repair the driver and retry.', choices: [] },
    })
    const noDriver = { ...selection, detectedCards: [{ id: 'PCI-card', name: 'NVIDIA card',
      driver: null, computeCapability: null, memoryMiB: null }] }
    expect(projectHardware(parseHardwareSelection(noDriver)).hardware.gpus).toEqual([{ id: 'PCI-card', name: 'NVIDIA card' }])
  })

  it.each([undefined, {}, { ...selection, choices: [{}] }, { ...selection, gpus: [1] },
    { ...selection, detectedCards: [{ id: '1', name: 'GPU' }] }, { ...selection, refusal: {} }])(
    'refuses an absent or malformed tools response', (value) => {
      expect(() => parseHardwareSelection(value)).toThrow('hardware response')
    },
  )
})
