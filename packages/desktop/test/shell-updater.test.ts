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
    channel: null,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn().mockImplementation(async () => {
      checked = true
      return version ? { isUpdateAvailable: true, updateInfo: { version } } : null
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

  it('clears only an already-installed pending RC even when its public feed refuses the request', async () => {
    const directory = await dataDirectory()
    const marker = join(directory, 'updates', 'shell-attempts.json')
    await mkdir(join(directory, 'updates'))
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
    try {
      for (const version of ['2.0.0-rc.10', '3.0.0-rc.1']) {
        const pending = { version, attempts: 1 }
        await writeFile(marker, JSON.stringify({ version: 1, pending }))
        const diagnostics: string[] = []
        const installed = new ShellUpdater({
          target: target(), dataDirectory: directory, currentVersion: '2.0.0-rc.10',
          updateFeed: undefined, packaged: true, diagnostic: (message) => diagnostics.push(message),
        })
        await expect(installed.start()).resolves.toMatchObject({ state: 'failed' })
        expect(diagnostics.map((line) => JSON.parse(line))).toEqual([{
          event: 'desktop-update-feed',
          url: 'https://api.github.com/repos/Kosinkadink/Dinkster-Desktop/releases?per_page=100&page=1',
          status: 403,
        }])
        expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual(version === '2.0.0-rc.10'
          ? { version: 1 } : { version: 1, pending })
      }
    } finally {
      vi.unstubAllGlobals()
    }
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
})
