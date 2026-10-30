import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellUpdater, type ShellUpdaterTarget } from '../src/shell-updater.js'

const directories: string[] = []

afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dinkster-shell-updater-'))
  directories.push(directory)
  return directory
}

function target(version?: string, installers: readonly string[] = []): ShellUpdaterTarget & { readonly checkForUpdates: ReturnType<typeof vi.fn>; readonly downloadUpdate: ReturnType<typeof vi.fn>; readonly quitAndInstall: ReturnType<typeof vi.fn> } {
  let checked = false
  let downloaded = false
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn().mockImplementation(async () => {
      checked = true
      return version ? { updateInfo: { version } } : null
    }),
    downloadUpdate: vi.fn().mockImplementation(async () => {
      if (!checked) throw new Error('download requires checkForUpdates')
      downloaded = true
      return installers
    }),
    quitAndInstall: vi.fn(() => {
      if (!downloaded) throw new Error('quitAndInstall requires a downloaded update')
    }),
  }
}

function updater(targetValue: ShellUpdaterTarget, directory: string, currentVersion = '1.0.0'): ShellUpdater {
  return new ShellUpdater({
    target: targetValue,
    dataDirectory: directory,
    currentVersion,
    updateFeed: 'https://updates.example.test/desktop',
    packaged: true,
  })
}

describe('shell updater', () => {
  it('checks only at startup, downloads manually, and waits for the next startup to install', async () => {
    const directory = await dataDirectory()
    const firstTarget = target('2.0.0')
    const first = updater(firstTarget, directory)

    await expect(first.start()).resolves.toMatchObject({ state: 'ready' })
    expect(firstTarget.autoDownload).toBe(false)
    expect(firstTarget.autoInstallOnAppQuit).toBe(false)
    expect(firstTarget.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(firstTarget.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(firstTarget.quitAndInstall).not.toHaveBeenCalled()
    expect(first.manualStatus()).toEqual(first.status)

    const secondTarget = target('2.0.0')
    const second = updater(secondTarget, directory)
    await expect(second.start()).resolves.toMatchObject({ state: 'installing' })
    expect(secondTarget.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(secondTarget.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(secondTarget.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('stops retrying a version after its third failed installation attempt', async () => {
    const directory = await dataDirectory()
    await updater(target('2.0.0'), directory).start()

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const retryTarget = target('2.0.0')
      await expect(updater(retryTarget, directory).start()).resolves.toMatchObject({ state: 'installing' })
      expect(retryTarget.quitAndInstall).toHaveBeenCalledTimes(1)
    }

    const stoppedTarget = target('2.0.0')
    await expect(updater(stoppedTarget, directory).start()).resolves.toMatchObject({ state: 'failed' })
    expect(stoppedTarget.quitAndInstall).not.toHaveBeenCalled()
    expect(stoppedTarget.downloadUpdate).not.toHaveBeenCalled()
  })

  it('downloads a different version after an older version reached the retry limit', async () => {
    const directory = await dataDirectory()
    await updater(target('2.0.0'), directory).start()
    for (let attempt = 0; attempt < 3; attempt += 1) await updater(target('2.0.0'), directory).start()

    const newerTarget = target('3.0.0')
    await expect(updater(newerTarget, directory).start()).resolves.toMatchObject({ state: 'ready' })
    expect(newerTarget.downloadUpdate).toHaveBeenCalledTimes(1)

    const installNewerTarget = target('3.0.0')
    await expect(updater(installNewerTarget, directory).start()).resolves.toMatchObject({ state: 'installing' })
    expect(installNewerTarget.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('clears the pending attempt after the downloaded version starts', async () => {
    const directory = await dataDirectory()
    await updater(target('2.0.0'), directory).start()

    const installedTarget = target('2.0.0')
    await expect(updater(installedTarget, directory, '2.0.0').start()).resolves.toMatchObject({ state: 'current' })
    const marker = JSON.parse(await readFile(join(directory, 'updates', 'shell-attempts.json'), 'utf8'))
    expect(marker).toEqual({ version: 1 })
  })

  it('fails closed when the durable retry state is corrupt', async () => {
    const directory = await dataDirectory()
    const updates = join(directory, 'updates')
    await mkdir(updates)
    await writeFile(join(updates, 'shell-attempts.json'), '{broken')
    const corruptTarget = target('2.0.0')

    await expect(updater(corruptTarget, directory).start()).resolves.toMatchObject({ state: 'failed' })
    expect(corruptTarget.checkForUpdates).not.toHaveBeenCalled()
    expect(corruptTarget.downloadUpdate).not.toHaveBeenCalled()
  })

  it('does not download the current version and starts only once per controller', async () => {
    const directory = await dataDirectory()
    const currentTarget = target('1.0.0')
    const controller = updater(currentTarget, directory)

    await Promise.all([controller.start(), controller.start()])
    await controller.start()
    expect(currentTarget.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(currentTarget.downloadUpdate).not.toHaveBeenCalled()
  })

  it('retains downloaded installers outside the updater cache', async () => {
    const directory = await dataDirectory()
    const cache = join(directory, 'updater-cache.exe')
    await writeFile(cache, 'installer')

    await updater(target('2.0.0', [cache]), directory).start()
    expect(await readFile(join(directory, 'updates', 'installers', '2.0.0', 'updater-cache.exe'), 'utf8')).toBe('installer')
  })
})
