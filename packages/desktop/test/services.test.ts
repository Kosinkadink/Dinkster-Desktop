import { expect, it, vi } from 'vitest'
import { desktopTitle, parseDesktopServices } from '../src/services.js'

it('selects services only from startup arguments and preserves production defaults', () => {
  vi.stubEnv('DINKSTER_SERVICES', 'qa')
  try {
    expect(parseDesktopServices(['desktop'])).toBe('production')
    expect(parseDesktopServices(['desktop', '--services=qa'])).toBe('qa')
    expect(parseDesktopServices(['desktop', '--services', 'production'])).toBe('production')
    for (const argv of [['--services=custom'], ['--services'], ['--services=qa', '--services=production']]) {
      expect(() => parseDesktopServices(argv)).toThrow('production or qa')
    }
    expect(desktopTitle('qa', true)).toBe('Dinkster Desktop [QA]')
    expect(desktopTitle('production')).toBe('Dinkster Desktop')
    expect(desktopTitle('production', true)).toBe('Dinkster Desktop - Development - unpublished sources')
  } finally { vi.unstubAllEnvs() }
})
