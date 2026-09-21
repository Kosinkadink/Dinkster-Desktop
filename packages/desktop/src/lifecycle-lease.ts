import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface LifecycleLease {
  release(): Promise<void>
}

interface LeaseOwner {
  readonly pid: number
  readonly token: string
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readOwner(path: string): Promise<LeaseOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseOwner>
    if (Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === 'string') {
      return { pid: Number(value.pid), token: value.token }
    }
  } catch {
    // A malformed owner cannot identify a live process.
  }
  return undefined
}

export async function acquireLifecycleLease(dataDirectory: string): Promise<LifecycleLease> {
  const path = join(dataDirectory, 'engine', 'lifecycle.lock')
  const owner: LeaseOwner = { pid: process.pid, token: randomUUID() }
  await mkdir(dirname(path), { recursive: true })
  for (;;) {
    const temporary = `${path}.${owner.token}.tmp`
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, { flag: 'wx' })
    try {
      await link(temporary, path)
      await rm(temporary, { force: true })
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          const current = await readOwner(path)
          if (current?.token === owner.token) await rm(path, { force: true })
        },
      }
    } catch (error) {
      await rm(temporary, { force: true })
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      const current = await readOwner(path)
      if (current && processIsAlive(current.pid)) {
        throw new Error(`Dinkster is already using this data directory (process ${current.pid})`)
      }
      await rm(path, { force: true })
    }
  }
}
