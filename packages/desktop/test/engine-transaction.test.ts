import { describe, expect, it, vi } from 'vitest'
import { changeEngineTransaction, type TransactionRuntime } from '../src/engine-transaction.js'
import type { EngineSelection, InstallSnapshot } from '../src/desktop-manager.js'

const previous: EngineSelection = { commit: 'healthy', variant: 'cpu' }
const target: EngineSelection = { commit: 'replacement', variant: 'rocm' }
const snapshot = (selection: EngineSelection): InstallSnapshot => ({
  format: 1,
  createdAt: '2026-08-18T00:00:00.000Z',
  reason: 'post-update',
  selection,
  dependencies: [{ name: 'torch', version: '2.13.0' }],
})

function runtime(start: () => Promise<void> = async () => {}): TransactionRuntime {
  return { start: vi.fn(start), stop: vi.fn(async () => {}) }
}

describe('engine change transaction', () => {
  it('commits a healthy replacement only after its snapshot matches', async () => {
    const old = runtime()
    const next = runtime()
    const persist = vi.fn(async () => {})
    const clearOperation = vi.fn(async () => {})
    await changeEngineTransaction({
      previous, target, kind: 'environment-change', expectedDependencies: snapshot(target).dependencies,
      currentRuntime: old, createRuntime: () => next, activateRuntime: vi.fn(),
      writeOperation: vi.fn(async () => {}), snapshot: vi.fn(async (selection) => snapshot(selection)),
      persist, clearOperation, committed: vi.fn(async () => {}),
    })
    expect(old.stop).toHaveBeenCalledOnce()
    expect(next.start).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith(target)
    expect(clearOperation).toHaveBeenCalledOnce()
  })

  it('owns the failed candidate and restores the prior runtime before clearing recovery state', async () => {
    const old = runtime()
    const failed = runtime(async () => { throw new Error('engine failed health check') })
    const restored = runtime()
    const activated: TransactionRuntime[] = []
    const persisted: EngineSelection[] = []
    const created: TransactionRuntime[] = [failed, restored]
    let operationCleared = false
    await expect(changeEngineTransaction({
      previous, target, kind: 'packaged-update', currentRuntime: old,
      createRuntime: () => created.shift()!, activateRuntime: (value) => activated.push(value),
      writeOperation: vi.fn(async () => {}), snapshot: vi.fn(async (selection) => snapshot(selection)),
      persist: async (selection) => { persisted.push(selection) },
      clearOperation: async () => { operationCleared = true }, committed: vi.fn(async () => {}),
    })).rejects.toThrow('engine failed health check')
    expect(failed.stop).toHaveBeenCalledOnce()
    expect(restored.start).toHaveBeenCalledOnce()
    expect(activated).toEqual([failed, restored])
    expect(persisted).toEqual([previous])
    expect(operationCleared).toBe(true)
  })

  it('rolls back when restored dependency versions do not match exactly', async () => {
    const old = runtime()
    const candidate = runtime()
    const restored = runtime()
    const created = [candidate, restored]
    const persisted: EngineSelection[] = []
    await expect(changeEngineTransaction({
      previous, target, kind: 'snapshot-restore', expectedDependencies: [{ name: 'torch', version: 'different' }],
      currentRuntime: old, createRuntime: () => created.shift()!, activateRuntime: vi.fn(),
      writeOperation: vi.fn(async () => {}), snapshot: vi.fn(async (selection) => snapshot(selection)),
      persist: async (selection) => { persisted.push(selection) }, clearOperation: vi.fn(async () => {}),
      committed: vi.fn(async () => {}),
    })).rejects.toThrow('does not match')
    expect(candidate.stop).toHaveBeenCalledOnce()
    expect(restored.start).toHaveBeenCalledOnce()
    expect(persisted).toEqual([previous])
  })
})
