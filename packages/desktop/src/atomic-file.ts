import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function currentText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function isSameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)])
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const changedWhileEditing = (conflict?: string): Error => new Error(
  conflict
    ? `The file changed while it was being edited; a conflicting copy was kept at ${conflict}`
    : 'The file changed while it was being edited; review it and try again',
)

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function linkIfMissing(source: string, path: string): Promise<void> {
  try {
    await link(source, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
}

async function retireClaim(path: string, previous: string, backup: string): Promise<void> {
  await linkIfMissing(previous, path)
  await rename(previous, backup)
  await syncDirectory(path)
}

export async function recoverInterruptedAtomicWrite(path: string): Promise<void> {
  let pathExists = true
  try {
    await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    pathExists = false
  }
  const directory = dirname(path)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const prefix = `${basename(path)}.`
  const suffix = '.previous'
  const candidates = entries.filter((entry) =>
    entry.startsWith(prefix)
      && entry.endsWith(suffix)
      && UUID_PATTERN.test(entry.slice(prefix.length, -suffix.length)),
  )
  if (candidates.length === 0) return
  if (!pathExists && candidates.length > 1) throw new Error(`Multiple interrupted updates were found for ${path}`)
  for (const candidate of candidates) {
    const previous = join(directory, candidate)
    const backup = `${previous.slice(0, -'.previous'.length)}.backup`
    await retireClaim(path, previous, backup)
  }
}

/**
 * Durably replace a file's contents using a unique, fsynced sibling temp file.
 * An unconditional replacement is atomic for readers. A conditional replacement
 * briefly claims the old path, then creates the new path without overwriting a
 * concurrent editor's file. The claimed inode remains as a unique backup so
 * writes through an already-open file descriptor cannot be lost. Conditional
 * updates retain the installed inode as a unique candidate so a later editor
 * replacement cannot erase it. On POSIX the containing directory is synced too.
 */
export async function writeFileAtomic(path: string, text: string, expectedText?: string): Promise<void> {
  const id = randomUUID()
  const temporary = `${path}.${id}.tmp`
  const previous = `${path}.${id}.previous`
  const backup = `${path}.${id}.backup`
  const candidate = `${path}.${id}.candidate`
  let previousOwned = false
  await mkdir(dirname(path), { recursive: true })
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (expectedText === undefined) {
      await rename(temporary, path)
    } else {
      await rename(temporary, candidate)
      await syncDirectory(path)
      try {
        await rename(path, previous)
        previousOwned = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (expectedText !== '') throw changedWhileEditing(candidate)
        try {
          await link(candidate, path)
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code === 'EEXIST') throw changedWhileEditing(candidate)
          throw linkError
        }
        if (!(await isSameFile(path, candidate))) {
          await syncDirectory(path)
          throw changedWhileEditing(candidate)
        }
        await syncDirectory(path)
        return
      }
      if ((await currentText(previous)) !== expectedText) {
        await retireClaim(path, previous, backup)
        previousOwned = false
        throw changedWhileEditing(candidate)
      }
      try {
        await link(candidate, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await retireClaim(path, previous, backup)
        previousOwned = false
        throw changedWhileEditing(candidate)
      }
      await rename(previous, backup)
      previousOwned = false
      if (!(await isSameFile(path, candidate))) {
        await syncDirectory(path)
        throw changedWhileEditing(candidate)
      }
      await syncDirectory(path)
      if ((await currentText(backup)) !== expectedText) throw changedWhileEditing(backup)
    }
    await syncDirectory(path)
  } catch (error) {
    await rm(temporary, { force: true })
    if (previousOwned) await retireClaim(path, previous, backup)
    throw error
  }
}
