import { describe, expect, it, vi } from 'vitest'
import { ProjectEngineManager, type ManagedProjectEngine } from '../src/project-engine-manager.js'

function engine(projectId: string, port: number, events: string[]): ManagedProjectEngine {
  return {
    startCurrent: vi.fn(async () => { events.push(`start:${projectId}:${port}`) }),
    stop: vi.fn(async () => { events.push(`stop:${projectId}:${port}`) }),
    info: vi.fn(async () => ({
      projectId, configured: true, mirrorConfigured: true, dataRoot: `/data/${projectId}`,
      generations: [], port,
    })),
    install: vi.fn(async (channel, cell) => { events.push(`install:${projectId}:${channel}:${cell}`) }),
    activate: vi.fn(async (generation) => { events.push(`activate:${projectId}:${generation}`) }),
    remove: vi.fn(async (deleteDataRoot) => { events.push(`remove:${projectId}:${String(deleteDataRoot)}`) }),
  }
}

describe('project engine manager', () => {
  it('assigns distinct ports and keeps project operations isolated', async () => {
    const ports = [4101, 4101, 4102]
    const events: string[] = []
    const created = new Map<string, ManagedProjectEngine>()
    const manager = new ProjectEngineManager({
      allocatePort: async () => ports.shift()!,
      create: (projectId, port) => {
        const createdEngine = engine(projectId, port, events)
        created.set(projectId, createdEngine)
        return createdEngine
      },
    })

    const [alpha, beta] = await Promise.all([manager.info('alpha'), manager.info('beta')])
    await manager.install('alpha', 'stable', 'linux-cpu')
    await manager.activate('beta', 7)
    await manager.stop()

    expect(alpha.port).toBe(4101)
    expect(beta.port).toBe(4102)
    expect(created.get('alpha')?.install).toHaveBeenCalledWith('stable', 'linux-cpu')
    expect(created.get('beta')?.activate).toHaveBeenCalledWith(7)
    expect(created.get('alpha')?.stop).toHaveBeenCalledOnce()
    expect(created.get('beta')?.stop).toHaveBeenCalledOnce()
  })

  it('serializes operations for one project without blocking another project', async () => {
    const events: string[] = []
    let releaseAlpha!: () => void
    const alphaBlocked = new Promise<void>((resolve) => { releaseAlpha = resolve })
    const manager = new ProjectEngineManager({
      allocatePort: async () => events.includes('port:4101') ? 4102 : (events.push('port:4101'), 4101),
      create: (projectId, port) => {
        const createdEngine = engine(projectId, port, events)
        if (projectId === 'alpha') {
          createdEngine.install = vi.fn(async () => {
            events.push('alpha-install-start')
            await alphaBlocked
            events.push('alpha-install-end')
          })
        }
        return createdEngine
      },
    })

    const first = manager.install('alpha', 'stable', 'linux-cpu')
    await vi.waitFor(() => expect(events).toContain('alpha-install-start'))
    const second = manager.activate('alpha', 2)
    await manager.activate('beta', 3)
    expect(events).toContain('activate:beta:3')
    expect(events).not.toContain('activate:alpha:2')
    releaseAlpha()
    await Promise.all([first, second])
    expect(events.indexOf('alpha-install-end')).toBeLessThan(events.indexOf('activate:alpha:2'))
  })

  it('rejects invalid project ids before allocating a port', async () => {
    const allocatePort = vi.fn(async () => 4101)
    const manager = new ProjectEngineManager({
      allocatePort,
      create: (projectId, port) => engine(projectId, port, []),
    })

    await expect(manager.info('Not Valid')).rejects.toThrow('invalid project id')
    expect(allocatePort).not.toHaveBeenCalled()
  })

  it('retries controller creation after a transient failure', async () => {
    let attempt = 0
    const manager = new ProjectEngineManager({
      allocatePort: async () => 4101,
      create: (projectId, port) => {
        if (++attempt === 1) throw new Error('controller creation failed')
        return engine(projectId, port, [])
      },
    })

    await expect(manager.info('alpha')).rejects.toThrow('creation failed')
    await expect(manager.info('alpha')).resolves.toMatchObject({ projectId: 'alpha', port: 4101 })
  })

  it('waits for an active project operation before stopping its supervisor', async () => {
    const events: string[] = []
    let releaseInstall!: () => void
    const installBlocked = new Promise<void>((resolve) => { releaseInstall = resolve })
    const manager = new ProjectEngineManager({
      allocatePort: async () => 4101,
      create: (projectId, port) => {
        const createdEngine = engine(projectId, port, events)
        createdEngine.install = vi.fn(async () => {
          events.push('install-start')
          await installBlocked
          events.push('install-end')
        })
        return createdEngine
      },
    })

    const install = manager.install('alpha', 'stable', 'linux-cpu')
    await vi.waitFor(() => expect(events).toContain('install-start'))
    const stop = manager.stop()
    await Promise.resolve()
    expect(events).not.toContain('stop:alpha:4101')
    releaseInstall()
    await Promise.all([install, stop])
    expect(events.indexOf('install-end')).toBeLessThan(events.indexOf('stop:alpha:4101'))
  })
})
