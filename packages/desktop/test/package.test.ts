import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyUpdateFeed } from '../scripts/verify-update-feed.mjs'

const root = resolve(import.meta.dirname, '../../..')
const execute = promisify(execFile)

async function writeFeedFixture(release: string, overrides: { url?: string; size?: number; sha512?: string } = {}): Promise<void> {
  const artifactName = 'Dinkster-Desktop-test-Setup.exe'
  const artifact = Buffer.from('test installer')
  const sha512 = createHash('sha512').update(artifact).digest('base64')
  await mkdir(release, { recursive: true })
  await writeFile(resolve(release, artifactName), artifact)
  await writeFile(resolve(release, 'latest.yml'), [
    'version: 0.2.0',
    'files:',
    `  - url: ${overrides.url ?? artifactName}`,
    `    sha512: ${overrides.sha512 ?? sha512}`,
    `    size: ${overrides.size ?? artifact.length}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    'releaseDate: 2026-08-18T00:00:00.000Z',
    '',
  ].join('\n'))
}

describe('desktop package inputs', () => {
  describe('control-runtime package inputs', () => {
    let scratch: string
    let script: string
    let descriptorFile: string
    let archiveFile: string
    let output: string
    let archiveBytes: Buffer

    function descriptorFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
      return {
        format: 'dinkster.control-runtime/1',
        commit: 'a'.repeat(40),
        platform: 'linux-x86_64',
        artifact: { path: `control/linux-x86_64/${sha256}.tar.gz`, sha256, size: archiveBytes.length },
        python: 'bin/python3',
        invocation: ['<python>', '-I', '-m', 'dinkster.cli'],
        ...overrides,
      }
    }

    async function writeInputs(descriptor: Record<string, unknown>): Promise<void> {
      await writeFile(archiveFile, archiveBytes)
      await writeFile(descriptorFile, JSON.stringify(descriptor))
    }

    function prepare(inputs: { descriptor?: string; archive?: string } = {}): Promise<unknown> {
      return execute(process.execPath, [script], {
        env: {
          ...process.env,
          DINKSTER_CONTROL_RUNTIME_DESCRIPTOR: inputs.descriptor ?? descriptorFile,
          DINKSTER_CONTROL_RUNTIME_ARCHIVE: inputs.archive ?? archiveFile,
        },
      })
    }

    async function expectPreserved(existing: string, bytes: Buffer | string): Promise<void> {
      expect(await readFile(resolve(output, 'existing.txt'), 'utf8')).toBe('preserved')
      expect(await readFile(existing)).toEqual(bytes)
    }

    beforeEach(async () => {
      scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-package-source-'))
      await mkdir(resolve(scratch, 'scripts'))
      script = resolve(scratch, 'scripts/prepare-control-runtime.mjs')
      await copyFile(resolve(root, 'packages/desktop/scripts/prepare-control-runtime.mjs'), script)
      archiveBytes = Buffer.from('bundled control-runtime archive bytes')
      descriptorFile = resolve(scratch, `control/${'a'.repeat(40)}/linux-x86_64.json`)
      await mkdir(resolve(descriptorFile, '..'), { recursive: true })
      archiveFile = resolve(scratch, `${createHash('sha256').update(archiveBytes).digest('hex')}.tar.gz`)
      await writeInputs(descriptorFixture())
      output = resolve(scratch, 'resources/control-runtime')
      await mkdir(output, { recursive: true })
    })

    afterEach(async () => {
      await rm(scratch, { recursive: true, force: true })
    })

    it('stages only the verified descriptor and archive and removes stale payloads', async () => {
      await writeFile(resolve(output, 'stale.zip'), 'stale')
      await prepare()
      const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
      expect((await readdir(output)).sort()).toEqual([`${sha256}.tar.gz`, 'descriptor.json'].sort())
      expect(await readFile(resolve(output, 'descriptor.json'), 'utf8')).toBe(JSON.stringify(descriptorFixture()))
      expect(await readFile(resolve(output, `${sha256}.tar.gz`))).toEqual(archiveBytes)
      expect(await readFile(descriptorFile, 'utf8')).toBe(JSON.stringify(descriptorFixture()))
      expect(await readFile(archiveFile)).toEqual(archiveBytes)
    })

    it('requires both explicit inputs', async () => {
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare({ descriptor: '' })).rejects.toThrow('Set DINKSTER_CONTROL_RUNTIME_DESCRIPTOR')
      await expect(prepare({ archive: '' })).rejects.toThrow('Set DINKSTER_CONTROL_RUNTIME_ARCHIVE')
      await expectPreserved(archiveFile, archiveBytes)
    })

    it('rejects a malformed descriptor before changing outputs', async () => {
      await writeFile(descriptorFile, '{')
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare()).rejects.toThrow('must be valid JSON')
      await expectPreserved(archiveFile, archiveBytes)
    })

    it.each([
      ['unknown top-level field', { extra: true }],
      ['unknown artifact field', { artifact: { path: '', sha256: '', size: 1, extra: true } }],
    ])('rejects a descriptor with an %s before changing outputs', async (_kind, overrides) => {
      await writeInputs(descriptorFixture(overrides))
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare()).rejects.toThrow('must contain exactly the fields')
      await expectPreserved(archiveFile, archiveBytes)
    })

    it('rejects a platform outside the staged set before changing outputs', async () => {
      await writeInputs(descriptorFixture({ platform: 'linux-x86_64-extra' }))
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare()).rejects.toThrow('platform must be one of linux-x86_64, macos-arm64, windows-amd64')
      await expectPreserved(archiveFile, archiveBytes)
    })

    it.each([
      ['windows-amd64', 'python.exe'],
      ['macos-arm64', 'bin/python3'],
    ])('stages a verified %s descriptor and archive', async (platform, python) => {
      const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
      const descriptor = descriptorFixture({
        platform,
        artifact: { path: `control/${platform}/${sha256}.tar.gz`, sha256, size: archiveBytes.length },
        python,
      })
      await writeInputs(descriptor)
      await rm(output, { recursive: true })
      await prepare()
      expect(await readFile(resolve(output, 'descriptor.json'), 'utf8')).toBe(JSON.stringify(descriptor))
      expect(await readFile(resolve(output, `${sha256}.tar.gz`))).toEqual(archiveBytes)
      expect(await readFile(archiveFile)).toEqual(archiveBytes)
    })

    it.each([
      ['interpreter that disagrees with the platform', { python: 'python.exe' }],
      ['artifact path under a different platform', { artifact: { path: `control/windows-amd64/${'a'.repeat(64)}.tar.gz`, sha256: 'a'.repeat(64), size: 1 } }],
      ['invocation with a resolved interpreter', { invocation: ['bin/python3', '-I', '-m', 'dinkster.cli'] }],
      ['invocation with a different module', { invocation: ['<python>', '-I', '-m', 'other.cli'] }],
    ])('rejects a descriptor with %s before changing outputs', async (_kind, overrides) => {
      await writeInputs(descriptorFixture(overrides))
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare()).rejects.toThrow(/must be (bin\/python3|control\/|exactly)/)
      await expectPreserved(archiveFile, archiveBytes)
    })

    it('rejects an archive whose bytes disagree with the verified digest before changing outputs', async () => {
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await writeFile(archiveFile, 'corrupted')
      await expect(prepare()).rejects.toThrow('checksum mismatch')
      await expectPreserved(archiveFile, Buffer.from('corrupted'))
    })

    it('rejects an archive size that disagrees with the descriptor', async () => {
      const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
      const descriptor = descriptorFixture({
        artifact: { path: `control/linux-x86_64/${sha256}.tar.gz`, sha256, size: archiveBytes.length + 1 },
      })
      await writeInputs(descriptor)
      await expect(prepare()).rejects.toThrow('size mismatch')
    })

    it('rejects an archive that does not carry the descriptor artifact file name', async () => {
      const renamed = resolve(scratch, 'wrong-name.tar.gz')
      await copyFile(archiveFile, renamed)
      await expect(prepare({ archive: renamed })).rejects.toThrow('must be named')
      expect(await readFile(renamed)).toEqual(archiveBytes)
    })

    it('refuses an input inside the staging directory before deleting anything', async () => {
      const unsafeInput = resolve(output, 'input.tar.gz')
      await writeFile(unsafeInput, archiveBytes)
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare({ archive: unsafeInput })).rejects.toThrow('outside resources/control-runtime')
      expect(await readFile(unsafeInput)).toEqual(archiveBytes)
      expect(await readFile(resolve(output, 'existing.txt'), 'utf8')).toBe('preserved')
    })

    it.each(['descriptor', 'archive'])('refuses an aliased %s input inside the staging directory', async (kind) => {
      const alias = resolve(scratch, 'staging-alias')
      await symlink(output, alias, 'junction')
      expect(await realpath(alias)).toBe(await realpath(output))
      const unsafeInput = resolve(alias, kind === 'descriptor' ? 'linux-x86_64.json' : `${createHash('sha256').update(archiveBytes).digest('hex')}.tar.gz`)
      const bytes = kind === 'descriptor' ? Buffer.from(JSON.stringify(descriptorFixture())) : archiveBytes
      await writeFile(unsafeInput, bytes)
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare({ [kind]: unsafeInput })).rejects.toThrow('outside resources/control-runtime')
      expect(await readFile(unsafeInput)).toEqual(bytes)
      expect(await readFile(resolve(output, 'existing.txt'), 'utf8')).toBe('preserved')
    })

    it.each(['descriptor', 'archive'])('refuses an outward %s input alias within the staging directory', async (kind) => {
      const alias = resolve(output, 'inputs')
      await symlink(scratch, alias, 'junction')
      expect(await realpath(alias)).toBe(await realpath(scratch))
      const unsafeInput = resolve(alias, kind === 'descriptor' ? `control/${'a'.repeat(40)}/linux-x86_64.json` : `${createHash('sha256').update(archiveBytes).digest('hex')}.tar.gz`)
      const bytes = kind === 'descriptor' ? Buffer.from(JSON.stringify(descriptorFixture())) : archiveBytes
      await writeFile(resolve(output, 'existing.txt'), 'preserved')
      await expect(prepare({ [kind]: unsafeInput })).rejects.toThrow('outside resources/control-runtime')
      expect(await readFile(kind === 'descriptor' ? descriptorFile : archiveFile)).toEqual(bytes)
      expect(await readFile(resolve(output, 'existing.txt'), 'utf8')).toBe('preserved')
      expect(await realpath(alias)).toBe(await realpath(scratch))
    })

    it('copies canonical input bytes when cleanup breaks an external alias chain', async () => {
      const outward = resolve(output, 'inputs')
      const alias = resolve(scratch, 'chained-inputs')
      await symlink(scratch, outward, 'junction')
      await symlink(outward, alias, 'junction')
      const chainedArchive = resolve(alias, `${createHash('sha256').update(archiveBytes).digest('hex')}.tar.gz`)
      expect(await realpath(chainedArchive)).toBe(await realpath(archiveFile))
      await writeFile(resolve(output, 'stale.txt'), 'stale')
      await prepare({ archive: chainedArchive })
      expect(await readFile(archiveFile)).toEqual(archiveBytes)
      const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
      expect((await readdir(output)).sort()).toEqual([`${sha256}.tar.gz`, 'descriptor.json'].sort())
      await expect(access(chainedArchive)).rejects.toThrow()
    })

    it('refuses input in the real target of an aliased staging directory', async () => {
      const target = resolve(scratch, 'staging-target')
      await mkdir(target)
      await rm(output, { recursive: true })
      await symlink(target, output, 'junction')
      expect(await realpath(output)).toBe(await realpath(target))
      const unsafeInput = resolve(target, 'descriptor.json')
      await writeFile(unsafeInput, JSON.stringify(descriptorFixture()))
      await expect(prepare({ descriptor: unsafeInput })).rejects.toThrow('outside resources/control-runtime')
      expect(await readFile(unsafeInput, 'utf8')).toBe(JSON.stringify(descriptorFixture()))
      expect(await realpath(output)).toBe(await realpath(target))
    })

    it('creates an absent staging directory for verified external inputs', async () => {
      await rm(resolve(scratch, 'resources'), { recursive: true })
      await prepare()
      const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
      expect(await readFile(resolve(output, 'descriptor.json'), 'utf8')).toBe(JSON.stringify(descriptorFixture()))
      expect(await readFile(resolve(output, `${sha256}.tar.gz`))).toEqual(archiveBytes)
    })
  })

  it('cleans generated outputs and selects only the control-runtime inputs', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'packages/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>
      build: {
        extraResources: { from: string; to: string; filter?: string[] }[]
        publish: { provider: string; owner: string; repo: string }[]
        win: { forceCodeSigning: boolean }
        linux: {
          category: string
          executableName: string
          synopsis: string
          description: string
          maintainer: string
          vendor: string
          syncDesktopName: boolean
          target: { target: string; arch: string[] }[]
          artifactName: string
        }
      }
    }
    expect(manifest.scripts['build']).toContain('clean-output.mjs dist')
    expect(manifest.scripts['prepare:control-runtime']).toBe('node scripts/prepare-control-runtime.mjs')
    expect(manifest.scripts['package:win']).toContain('prepare:control-runtime')
    expect(manifest.scripts['package:win']).not.toContain('prepare:engine')
    expect(manifest.scripts['package:linux']).toContain('prepare:control-runtime')
    expect(manifest.scripts['package:linux']).not.toContain('prepare:engine')
    expect(manifest.scripts['package:win']).toContain('clean-output.mjs release')
    expect(Object.keys(manifest.scripts)).not.toContain('prepare:engine')
    expect(manifest.build.extraResources).toEqual([
      { from: '../app/dist', to: 'app' },
      { from: 'resources/control-runtime', to: 'control-runtime' },
    ])
    expect(manifest.build.publish).toEqual([{ provider: 'generic', url: 'https://updates.dinkster.invalid/desktop' }])
    expect(manifest.build.win.forceCodeSigning).toBe(false)
    expect(manifest.build.linux).toEqual({
      category: 'Utility',
      executableName: 'dinkster-desktop',
      synopsis: 'Dinkster Desktop',
      description: 'Dinkster Desktop local engine and project manager',
      maintainer: 'Dinkster contributors',
      vendor: 'Dinkster contributors',
      syncDesktopName: true,
      target: [{ target: 'AppImage', arch: ['x64'] }],
      artifactName: 'Dinkster-Desktop-${version}-${arch}.${ext}',
    })
    const embedded = JSON.stringify(manifest)
    expect(embedded).not.toMatch(/prepare-engine-source|resources\/engine|"engine"|\.whl/i)
    expect(embedded).not.toMatch(/aimdo/i)
  })

  it('keeps both tinkerer launchers on the shared web runtime', async () => {
    const windows = await readFile(resolve(root, 'scripts/start-dinkster.bat'), 'utf8')
    const bash = await readFile(resolve(root, 'scripts/start-dinkster.sh'), 'utf8')
    const main = await readFile(resolve(root, 'packages/desktop/src/main.ts'), 'utf8')
    const webCli = await readFile(resolve(root, 'packages/desktop/src/web-cli.ts'), 'utf8')
    expect(windows).toContain('pnpm --filter @dinkster/desktop start:web')
    expect(bash).toContain('pnpm --filter @dinkster/desktop start:web')
    expect(main).toContain('app.requestSingleInstanceLock()')
    expect(main).toContain('acquireLifecycleLease(dataDirectory)')
    expect(webCli).toContain('acquireLifecycleLease(dataDirectory)')
  })

  it('requires explicit confirmation before a downloaded update installs', async () => {
    const main = await readFile(resolve(root, 'packages/desktop/src/main.ts'), 'utf8')
    expect(main).toContain('autoUpdater.autoInstallOnAppQuit = false')
    expect(main).toContain("update.state !== 'ready'")
    expect(main).toContain('autoUpdater.quitAndInstall(false, true)')
  })

  it('validates the updater files entry against the release artifact', async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-update-feed-'))
    try {
      const valid = resolve(scratch, 'valid')
      await writeFeedFixture(valid)
      const wrongUrl = resolve(scratch, 'wrong-url')
      await writeFeedFixture(wrongUrl, { url: 'missing.exe' })
      const wrongSize = resolve(scratch, 'wrong-size')
      await writeFeedFixture(wrongSize, { size: 1 })
      const wrongHash = resolve(scratch, 'wrong-hash')
      await writeFeedFixture(wrongHash, { sha512: 'invalid' })
      await Promise.all([
        expect(verifyUpdateFeed(valid)).resolves.toBeUndefined(),
        expect(verifyUpdateFeed(wrongUrl)).rejects.toThrow(),
        expect(verifyUpdateFeed(wrongSize)).rejects.toThrow(),
        expect(verifyUpdateFeed(wrongHash)).rejects.toThrow(),
      ])
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('removes stale files from every requested output directory', async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-package-clean-'))
    const dist = resolve(scratch, 'dist')
    const release = resolve(scratch, 'release')
    try {
      await mkdir(dist)
      await mkdir(release)
      await writeFile(resolve(dist, 'stale.js'), 'stale')
      await writeFile(resolve(release, 'old-installer.exe'), 'stale')
      await execute(process.execPath, [
        resolve(root, 'packages/desktop/scripts/clean-output.mjs'),
        dist,
        release,
      ])
      await expect(access(dist)).rejects.toThrow()
      await expect(access(release)).rejects.toThrow()
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
