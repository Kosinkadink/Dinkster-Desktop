import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
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
  describe('backend source payload', () => {
    let scratch: string
    let script: string
    let input: string
    let wheel: string
    let output: string
    let content: Buffer
    const wheelContent = Buffer.from('pinned wheel fixture')
    const pin = {
      repository: 'Kosinkadink/Dinkster', commit: 'a'.repeat(40),
      releaseTag: `backend-${'a'.repeat(40)}`,
      archive: `dinkster-backend-${'a'.repeat(40)}.zip`,
      sha256: '', size: 0, workerProtocol: 8,
      desktopWindowsRuntime: {
        aimdo: {
          repository: 'Kosinkadink/dinkster-aimdo', commit: 'b'.repeat(40),
          releaseTag: 'v0.5.5.post1', version: '0.5.5.post1',
          archive: 'dinkster_aimdo-0.5.5.post1-cp39-abi3-win_amd64.whl',
          sha256: createHash('sha256').update(wheelContent).digest('hex'), size: wheelContent.length,
        },
        cudaTorch: {
          version: '2.13.0+cu130', torchvisionVersion: '0.28.0', cudaVersion: '13.0',
          archive: 'torch-2.13.0+cu130-cp312-cp312-win_amd64.whl',
          url: 'https://example.test/torch.whl', sha256: 'c'.repeat(64), size: 123,
        },
      },
    }
    const { aimdo, cudaTorch } = pin.desktopWindowsRuntime

    async function writeArchive(profile: string | null = JSON.stringify({ aimdo, cudaTorch }),
      path = `dinkster-backend-${pin.commit}/scripts/desktop_windows_runtime.json`): Promise<void> {
      content = Buffer.from(zipSync(profile === null ? {} : { [path]: Buffer.from(profile) }))
      pin.sha256 = createHash('sha256').update(content).digest('hex')
      pin.size = content.length
      await writeFile(input, content)
      await writeFile(resolve(scratch, 'src/backend-release.json'), JSON.stringify(pin))
    }

    beforeEach(async () => {
      scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-package-source-'))
      await mkdir(resolve(scratch, 'scripts'))
      await mkdir(resolve(scratch, 'src'))
      script = resolve(scratch, 'scripts/prepare-engine-source.mjs')
      const original = await readFile(resolve(root, 'packages/desktop/scripts/prepare-engine-source.mjs'), 'utf8')
      const extract = pathToFileURL(createRequire(import.meta.url).resolve('extract-zip')).href
      await writeFile(script, original.replace("'extract-zip'", JSON.stringify(extract)))
      input = resolve(scratch, pin.archive)
      await writeArchive()
      wheel = resolve(scratch, aimdo.archive)
      await writeFile(wheel, wheelContent)
      output = resolve(scratch, 'resources/engine')
      await mkdir(output, { recursive: true })
    })

    afterEach(async () => {
      await rm(scratch, { recursive: true, force: true })
    })

    function prepare(source = input, aimdoWheel = wheel): Promise<unknown> {
      return execute(process.execPath, [script], {
        env: { ...process.env, DINKSTER_ENGINE_ARCHIVE: source, DINKSTER_AIMDO_WHEEL: aimdoWheel },
      })
    }

    it('copies only the pinned artifacts and removes stale payloads', async () => {
      await writeFile(resolve(output, 'stale.zip'), 'stale')
      await prepare()
      expect((await readdir(output)).sort()).toEqual([aimdo.archive, pin.archive].sort())
      expect(await readFile(resolve(output, pin.archive))).toEqual(content)
      expect(await readFile(resolve(output, aimdo.archive))).toEqual(wheelContent)
    })

    it('compares the source profile structurally rather than by JSON key order', async () => {
      const reorderedAimdo = Object.fromEntries(Object.entries(aimdo).reverse())
      await writeArchive(JSON.stringify({ cudaTorch, aimdo: reorderedAimdo }, null, 4))
      await prepare()
      expect(await readFile(resolve(output, pin.archive))).toEqual(content)
    })

    it.each([
      ['missing', null],
      ['malformed', '{'],
      ['wrong prefix', JSON.stringify({ aimdo, cudaTorch })],
    ])('rejects a %s source profile before changing outputs', async (kind, profile) => {
      await writeArchive(profile, kind === 'wrong prefix' ? 'other/scripts/desktop_windows_runtime.json' : undefined)
      await writeFile(resolve(output, 'existing.zip'), 'preserved')
      await expect(prepare()).rejects.toThrow('must contain valid scripts/desktop_windows_runtime.json')
      expect(await readFile(resolve(output, 'existing.zip'), 'utf8')).toBe('preserved')
      expect(await readFile(input)).toEqual(content)
    })

    it.each([
      { aimdo: { ...aimdo, sha256: 'd'.repeat(64) }, cudaTorch },
      { aimdo, cudaTorch: { ...cudaTorch, version: '2.13.0+cpu' } },
      { aimdo },
      { aimdo, cudaTorch, extra: true },
    ])('rejects a source profile that differs from the frontend pin: %j', async (profile) => {
      await writeArchive(JSON.stringify(profile))
      await writeFile(resolve(output, 'existing.zip'), 'preserved')
      await expect(prepare()).rejects.toThrow('Windows native profile does not match')
      expect(await readFile(resolve(output, 'existing.zip'), 'utf8')).toBe('preserved')
      expect(await readFile(input)).toEqual(content)
    })

    it('rejects frontend-only native repinning even when the archive checksum matches', async () => {
      await writeFile(resolve(scratch, 'src/backend-release.json'), JSON.stringify({
        ...pin,
        desktopWindowsRuntime: { aimdo, cudaTorch: { ...cudaTorch, sha256: 'd'.repeat(64) } },
      }))
      await expect(prepare()).rejects.toThrow('Windows native profile does not match')
      expect(await readFile(input)).toEqual(content)
    })

    it('rejects mismatches without deleting the input or existing output', async () => {
      await writeFile(resolve(output, pin.archive), content)
      await writeFile(input, 'corrupted')
      await expect(prepare()).rejects.toThrow('checksum mismatch')
      expect(await readFile(input, 'utf8')).toBe('corrupted')
      expect(await readFile(resolve(output, pin.archive))).toEqual(content)
    })

    it('refuses input inside the output directory before deleting anything', async () => {
      const unsafeInput = resolve(output, 'input.zip')
      await writeFile(unsafeInput, content)
      await expect(prepare(unsafeInput)).rejects.toThrow('outside resources/engine')
      expect(await readFile(unsafeInput)).toEqual(content)
    })

    it.each(['backend', 'Aimdo'])('refuses aliased %s input inside the output directory', async (kind) => {
      const alias = resolve(scratch, 'engine-alias')
      await symlink(output, alias, 'junction')
      expect(await realpath(alias)).toBe(await realpath(output))
      const unsafeInput = resolve(alias, kind === 'backend' ? pin.archive : aimdo.archive)
      const bytes = kind === 'backend' ? content : wheelContent
      await writeFile(unsafeInput, bytes)
      await writeFile(resolve(output, 'existing.zip'), 'preserved')
      await expect(kind === 'backend' ? prepare(unsafeInput) : prepare(input, unsafeInput)).rejects.toThrow('outside resources/engine')
      expect(await readFile(unsafeInput)).toEqual(bytes)
      expect(await readFile(resolve(output, 'existing.zip'), 'utf8')).toBe('preserved')
    })

    it.each(['backend', 'Aimdo'])('refuses an outward %s input alias within the output directory', async (kind) => {
      const alias = resolve(output, 'inputs')
      await symlink(scratch, alias, 'junction')
      expect(await realpath(alias)).toBe(await realpath(scratch))
      const unsafeInput = resolve(alias, kind === 'backend' ? pin.archive : aimdo.archive)
      const bytes = kind === 'backend' ? content : wheelContent
      await writeFile(resolve(output, 'existing.zip'), 'preserved')
      await expect(kind === 'backend' ? prepare(unsafeInput) : prepare(input, unsafeInput)).rejects.toThrow('outside resources/engine')
      expect(await readFile(unsafeInput)).toEqual(bytes)
      expect(await readFile(kind === 'backend' ? input : wheel)).toEqual(bytes)
      expect(await readFile(resolve(output, 'existing.zip'), 'utf8')).toBe('preserved')
      expect(await realpath(alias)).toBe(await realpath(scratch))
    })

    it.each(['backend', 'Aimdo'])('copies canonical %s bytes when cleanup breaks an external alias chain', async (kind) => {
      const outward = resolve(output, 'inputs')
      const alias = resolve(scratch, 'chained-inputs')
      await symlink(scratch, outward, 'junction')
      await symlink(outward, alias, 'junction')
      const chainedInput = resolve(alias, kind === 'backend' ? pin.archive : aimdo.archive)
      const originalInput = kind === 'backend' ? input : wheel
      expect(await realpath(chainedInput)).toBe(await realpath(originalInput))
      await writeFile(resolve(output, 'stale.zip'), 'stale')
      await (kind === 'backend' ? prepare(chainedInput) : prepare(input, chainedInput))
      expect(await readFile(input)).toEqual(content)
      expect(await readFile(wheel)).toEqual(wheelContent)
      expect(await readFile(resolve(output, pin.archive))).toEqual(content)
      expect(await readFile(resolve(output, aimdo.archive))).toEqual(wheelContent)
      expect((await readdir(output)).sort()).toEqual([aimdo.archive, pin.archive].sort())
      await expect(access(chainedInput)).rejects.toThrow()
    })

    it('refuses input in the real target of an aliased output directory', async () => {
      const target = resolve(scratch, 'engine-target')
      await mkdir(target)
      await rm(output, { recursive: true })
      await symlink(target, output, 'junction')
      expect(await realpath(output)).toBe(await realpath(target))
      const unsafeInput = resolve(target, pin.archive)
      await writeFile(unsafeInput, content)
      await expect(prepare(unsafeInput)).rejects.toThrow('outside resources/engine')
      expect(await readFile(unsafeInput)).toEqual(content)
      expect(await realpath(output)).toBe(await realpath(target))
    })

    it('creates an absent output directory for verified external inputs', async () => {
      await rm(resolve(scratch, 'resources'), { recursive: true })
      await prepare()
      expect(await readFile(resolve(output, pin.archive))).toEqual(content)
      expect(await readFile(resolve(output, aimdo.archive))).toEqual(wheelContent)
    })

    it('requires an explicit backend input archive', async () => {
      await expect(prepare('')).rejects.toThrow('Set DINKSTER_ENGINE_ARCHIVE')
    })

    it('requires the private Aimdo wheel before changing package outputs', async () => {
      await writeFile(resolve(output, pin.archive), content)
      await expect(prepare(input, '')).rejects.toThrow('Set DINKSTER_AIMDO_WHEEL')
      expect(await readFile(resolve(output, pin.archive))).toEqual(content)
    })

    it('rejects a corrupted Aimdo wheel before changing package outputs', async () => {
      await writeFile(resolve(output, pin.archive), content)
      await writeFile(wheel, 'corrupted')
      await expect(prepare()).rejects.toThrow('checksum mismatch')
      expect(await readFile(resolve(output, pin.archive))).toEqual(content)
      expect(await readFile(wheel, 'utf8')).toBe('corrupted')
    })

    it('rejects a size that disagrees with the verified artifact bytes', async () => {
      await writeFile(resolve(scratch, 'src/backend-release.json'), JSON.stringify({ ...pin, size: pin.size + 1 }))
      await expect(prepare()).rejects.toThrow('size mismatch')
    })

    it('rejects invalid backend metadata', async () => {
      await writeFile(resolve(scratch, 'src/backend-release.json'), JSON.stringify({ ...pin, archive: '../escape.zip' }))
      await expect(prepare()).rejects.toThrow('Invalid pinned backend')
    })
  })

  it('cleans generated outputs and selects only the manifest engine archive', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'packages/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>
      build: {
        extraResources: { from: string; to: string }[]
        publish: { provider: string; owner: string; repo: string }[]
        win: { forceCodeSigning: boolean }
      }
    }
    expect(manifest.scripts['build']).toContain('clean-output.mjs dist')
    expect(manifest.scripts['prepare:engine']).toBe('node scripts/prepare-engine-source.mjs')
    expect(manifest.scripts['package:win']).toContain('clean-output.mjs release')
    expect(manifest.build.extraResources[1]).toEqual({
      from: 'resources/engine',
      to: 'engine',
      filter: ['*.zip', '*.whl'],
    })
    expect(manifest.build.publish).toEqual([{ provider: 'generic', url: 'https://updates.dinkster.invalid/desktop' }])
    expect(manifest.build.win.forceCodeSigning).toBe(false)
  })

  it('fails early without the dedicated cross-repository release credential and never falls back', async () => {
    const yaml = createRequire(import.meta.url)('js-yaml') as { load(source: string): unknown }
    const source = await readFile(resolve(root, '.github/workflows/release-desktop.yml'), 'utf8')
    const workflow = yaml.load(source) as {
      jobs: { release: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } }
    }
    const steps = workflow.jobs.release.steps
    const acquire = steps.find((step) => step.name === 'Download pinned private backend and Aimdo')!
    expect(steps.find((step) => step.run !== undefined)).toBe(acquire)
    expect(acquire.env).toEqual({ GH_TOKEN: '${{ secrets.DINKSTER_RELEASE_READ_TOKEN }}' })
    expect(acquire.run?.trim().split('\n')[0]).toBe("if (-not $env:GH_TOKEN) { throw 'Configure DINKSTER_RELEASE_READ_TOKEN with read access to private Kosinkadink/Dinkster and Kosinkadink/dinkster-aimdo releases' }")
    expect(acquire.run).not.toMatch(/GITHUB_TOKEN|github\.token|githubtoken|\$env:GH_TOKEN\s*=/i)
    expect(source.match(/secrets\.DINKSTER_RELEASE_READ_TOKEN/g)).toHaveLength(1)
    expect(steps.find((step) => step.name === 'Create private release')?.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
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
