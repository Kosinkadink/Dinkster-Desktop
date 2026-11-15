import { describe, expect, it } from 'vitest'
import { wslLinuxPath, wslLocation, wslWindowsPath } from '../src/wsl.js'

const distribution = 'Dinkster-Desktop-012345abcdef'

describe('private WSL disk paths', () => {
  it('round trips Linux-disk project paths without treating a Windows drive as Linux storage', () => {
    const linux = '/home/dinkster/projects/studio one/models'
    const native = `\\\\wsl.localhost\\${distribution}\\home\\dinkster\\projects\\studio one\\models`
    expect(wslWindowsPath(distribution, linux)).toBe(native)
    expect(wslLocation(native)).toEqual({ distribution, path: linux })
    expect(wslLinuxPath(distribution, native)).toBe(linux)
    expect(wslLinuxPath(distribution, native.replace('wsl.localhost', 'wsl$'))).toBe(linux)
    expect(wslLocation('C:\\models')).toBeUndefined()
    expect(() => wslLinuxPath(distribution, 'C:\\models')).toThrow('copy it into WSL')
    expect(() => wslLinuxPath(distribution, native.replace('012345abcdef', 'abcdef012345'))).toThrow('copy it into WSL')
    expect(wslLocation('\\\\wsl.localhost\\Ubuntu\\home\\user')).toBeUndefined()
  })

  it('rejects traversal and Windows alternate streams instead of translating them across the boundary', () => {
    for (const suffix of ['home\\..\\mnt\\c', 'home/../../mnt/c', 'home\\models:secret', 'home\\bad\0name']) {
      expect(() => wslLocation(`\\\\wsl.localhost\\${distribution}\\${suffix}`)).toThrow('Invalid WSL path')
    }
    for (const linux of ['relative', '/home/../mnt/c', '/home/./models', '/home/models:secret', '/home\\models', '/home/invalid\0name']) {
      expect(() => wslWindowsPath(distribution, linux)).toThrow('Invalid WSL path')
    }
    expect(() => wslWindowsPath('Ubuntu', '/home/user')).toThrow('Invalid WSL path')
  })
})
