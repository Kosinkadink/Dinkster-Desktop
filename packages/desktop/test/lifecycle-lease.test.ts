import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireLifecycleLease } from '../src/lifecycle-lease.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dinkster-lease-test-'))
  roots.push(value)
  return value
}

describe('shared desktop lifecycle lease', () => {
  it('excludes another launcher using the same data directory until release', async () => {
    const data = await root()
    const first = await acquireLifecycleLease(data)
    await expect(acquireLifecycleLease(data)).rejects.toThrow('already using this data directory')
    await first.release()
    const second = await acquireLifecycleLease(data)
    await second.release()
  })

  it('reclaims a lease whose owner process no longer exists', async () => {
    const data = await root()
    const lock = join(data, 'engine', 'lifecycle.lock')
    await mkdir(join(data, 'engine'), { recursive: true })
    await writeFile(lock, JSON.stringify({ pid: 2147483647, token: 'stale' }))
    const lease = await acquireLifecycleLease(data)
    await lease.release()
  })
})
