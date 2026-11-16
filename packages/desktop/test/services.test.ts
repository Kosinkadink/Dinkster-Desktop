import { expect, it, vi } from 'vitest'
import { desktopTitle, engineServices, parseDesktopServices } from '../src/services.js'

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

it('requires a declared service before an engine is opened', async () => {
  let name: unknown = 'qa'
  vi.stubGlobal('fetch', async () => Response.json({ dinkster: { services: { name } } }))
  try {
    expect(await engineServices('http://127.0.0.1:39262')).toBe('qa')
    name = 'production'
    expect(await engineServices('http://127.0.0.1:39262')).toBe('production')
    name = 'custom'
    expect(await engineServices('http://127.0.0.1:39262')).toBe('custom')
    name = undefined
    await expect(engineServices('http://127.0.0.1:39262')).rejects.toThrow('did not report')
  } finally { vi.unstubAllGlobals() }
})
