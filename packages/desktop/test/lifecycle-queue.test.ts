import { describe, expect, it } from 'vitest'
import { LifecycleQueue } from '../src/lifecycle-queue.js'

describe('desktop lifecycle serialization', () => {
  it('runs adversarial concurrent mutations one at a time in request order', async () => {
    const queue = new LifecycleQueue()
    const events: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const first = queue.run(async () => {
      events.push('cpu:start')
      await blocked
      events.push('cpu:end')
    })
    const second = queue.run(async () => {
      events.push('nvidia:start')
      events.push('nvidia:end')
    })
    await Promise.resolve()
    expect(events).toEqual(['cpu:start'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['cpu:start', 'cpu:end', 'nvidia:start', 'nvidia:end'])
  })

  it('continues with the next mutation after a failure', async () => {
    const queue = new LifecycleQueue()
    const failed = queue.run(async () => { throw new Error('failed update') })
    const recovered = queue.run(async () => 'restored')
    await expect(failed).rejects.toThrow('failed update')
    await expect(recovered).resolves.toBe('restored')
  })
})
