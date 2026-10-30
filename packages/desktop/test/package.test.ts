import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
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
  it('prepares native branding byte-for-byte from the pinned frontend without stale assets', async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-native-brand-'))
    try {
      await mkdir(resolve(scratch, '.frontend/packages/app/dist'), { recursive: true })
      await writeFile(resolve(scratch, '.frontend/packages/app/dist/index.html'), '<html>bundle</html>')
      const fixtures = ['platform/dinkster.ico', 'platform/dinkster.icns', 'raster/color/16.png', 'raster/color/24.png', 'raster/color/512.png', 'raster/mono/16.png', 'raster/mono/32.png', 'svg/dinkster-wordmark-color-dark.svg', 'svg/dinkster-wordmark-color-light.svg', 'tokens/dinkster-colors.json']
      for (const path of fixtures) {
        const target = resolve(scratch, '.frontend/branding', path)
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, Buffer.from(`source bytes: ${path}`))
      }
      const output = resolve(scratch, 'packages/desktop/resources/branding')
      await mkdir(output, { recursive: true })
      await writeFile(resolve(output, 'stale.ico'), 'obsolete')
      await execute(process.execPath, [resolve(root, 'scripts/prepare-frontend.mjs')], { cwd: scratch })
      for (const path of fixtures) {
        expect(await readFile(resolve(output, path))).toEqual(Buffer.from(`source bytes: ${path}`))
      }
      await expect(access(resolve(output, 'stale.ico'))).rejects.toThrow()
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('cleans generated outputs and excludes engine installation inputs from the shell package', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'packages/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>
      build: {
        extraResources: { from: string; to: string }[]
        publish: { provider: string; owner: string; repo: string }[]
        win: { forceCodeSigning: boolean }
      }
    }
    expect(manifest.scripts['build']).toContain('clean-output.mjs dist')
    expect(manifest.scripts['package:win']).toContain('clean-output.mjs release')
    expect(manifest.scripts['package:win']).not.toMatch(/prepare:engine|prepare-engine-source/)
    expect(manifest.scripts).not.toHaveProperty('prepare:engine')
    expect(manifest.build.extraResources).toEqual([
      { from: '../app/dist', to: 'app' },
      { from: 'resources/branding', to: 'branding' },
    ])
    expect(manifest.build.publish).toEqual([{ provider: 'generic', url: 'https://updates.dinkster.invalid/desktop' }])
    expect(manifest.build.win.forceCodeSigning).toBe(false)
    expect(manifest.build.win).not.toHaveProperty('azureSignOptions')
    expect(manifest.scripts['package:win:signed']).toBe('pnpm package:win --config electron-builder.signed.mjs')
  })

  it('signs releases through the Artifact Signing profile and accepts both publishers on update', async () => {
    const signed = await import('../electron-builder.signed.mjs') as {
      currentPublisher: string
      acceptedUpdatePublishers: string[]
      artifactSigning: Record<string, string>
      signtoolOptions: { sign: unknown; signingHashAlgorithms: string[]; publisherName: string }
      default(): Promise<{
        publish: { provider: string; url: string; publisherName?: string[] }[]
        win: { forceCodeSigning: boolean; signtoolOptions: unknown; artifactName: string }
      }>
    }
    const manifest = JSON.parse(await readFile(resolve(root, 'packages/desktop/package.json'), 'utf8')) as {
      build: { publish: unknown[]; win: Record<string, unknown> }
    }
    const configuration = await signed.default()
    expect(configuration.win.forceCodeSigning).toBe(true)
    expect(configuration.win).not.toHaveProperty('azureSignOptions')
    expect(configuration.win.signtoolOptions).toBe(signed.signtoolOptions)
    expect(signed.artifactSigning).toEqual({
      endpoint: 'https://wus2.codesigning.azure.net',
      codeSigningAccountName: 'dinkster',
      certificateProfileName: 'dinkster-desktop',
    })
    expect(typeof signed.signtoolOptions.sign).toBe('function')
    expect(signed.signtoolOptions.signingHashAlgorithms).toEqual(['sha256'])
    expect(signed.signtoolOptions.publisherName).toBe(signed.currentPublisher)
    expect(signed.acceptedUpdatePublishers).toContain(signed.currentPublisher)
    expect(configuration.publish).toEqual([{ ...(manifest.build.publish[0] as object), publisherName: signed.acceptedUpdatePublishers }])
    const { forceCodeSigning: _unsigned, ...unsignedWin } = manifest.build.win
    const { forceCodeSigning: _signed, signtoolOptions: _options, ...signedWin } = configuration.win
    expect(signedWin).toEqual(unsignedWin)
    expect(Object.keys(configuration).sort()).toEqual(Object.keys(manifest.build).sort())
    expect(JSON.stringify(signed)).not.toMatch(/secret|password|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })

  it('signs each file with the ArtifactSigning PowerShell module', async () => {
    const { installCommand, signCommand } = await import('../scripts/artifact-sign.mjs') as {
      installCommand(): string
      signCommand(signing: Record<string, string>, file: string): string
    }
    const { artifactSigning } = await import('../electron-builder.signed.mjs') as { artifactSigning: Record<string, string> }
    expect(installCommand()).toBe('Install-Module -Name ArtifactSigning -Force -Repository PSGallery -Scope CurrentUser')
    expect(signCommand(artifactSigning, "D:\\a\\release\\Dinkster's Desktop.exe")).toBe(
      "Invoke-ArtifactSigning -Endpoint 'https://wus2.codesigning.azure.net' -CodeSigningAccountName 'dinkster'" +
        " -CertificateProfileName 'dinkster-desktop' -TimestampRfc3161 'http://timestamp.acs.microsoft.com'" +
        " -TimestampDigest 'SHA256' -FileDigest 'SHA256' -Files 'D:\\a\\release\\Dinkster''s Desktop.exe'",
    )
  })

  it('scopes the release token to publication and never acquires engine installation inputs', async () => {
    const yaml = createRequire(import.meta.url)('js-yaml') as { load(source: string): unknown }
    const source = await readFile(resolve(root, '.github/workflows/release-desktop.yml'), 'utf8')
    const workflow = yaml.load(source) as {
      jobs: { release: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } }
    }
    const steps = workflow.jobs.release.steps
    expect(steps.find((step) => step.run !== undefined)?.name).toBe('Validate version tag')
    expect(steps.filter((step) => step.env?.['GH_TOKEN'] !== undefined)).toEqual([
      steps.find((step) => step.name === 'Create release'),
    ])
    for (const file of ['release-desktop.yml', 'signed-package.yml', 'full-validation.yml']) {
      const packaging = await readFile(resolve(root, '.github/workflows', file), 'utf8')
      expect(packaging).not.toMatch(/DINKSTER_ENGINE_ARCHIVE|DINKSTER_AIMDO_WHEEL|prepare:engine|gh release download|Invoke-WebRequest/)
      expect(packaging).not.toMatch(/DINKSTER_RELEASE_READ_TOKEN|githubtoken|\$env:GH_TOKEN\s*=/i)
    }
    const signing = steps.find((step) => step.name === 'Package and sign with Artifact Signing')!
    expect(signing.run).toBe('pnpm --filter @dinkster/desktop package:win:signed')
    expect(signing.env).toEqual({
      AZURE_TENANT_ID: '${{ secrets.AZURE_TENANT_ID }}',
      AZURE_CLIENT_ID: '${{ secrets.AZURE_CLIENT_ID }}',
      AZURE_CLIENT_SECRET: '${{ secrets.AZURE_CLIENT_SECRET }}',
    })
    expect(source.match(/secrets\.\w+/g)?.sort()).toEqual(['secrets.AZURE_CLIENT_ID', 'secrets.AZURE_CLIENT_SECRET', 'secrets.AZURE_TENANT_ID'])
    expect(steps.filter((step) => step.env && Object.keys(step.env).some((name) => name.startsWith('AZURE_')))).toEqual([signing])
    expect(steps.map((step) => step.name ?? step.run)).toContain('Verify publisher signatures')
    expect(steps.findIndex((step) => step.name === 'Verify publisher signatures')).toBeLessThan(steps.findIndex((step) => step.name === 'Install into an isolated directory'))
    expect(steps.find((step) => step.name === 'Create release')?.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
    expect(steps.find((step) => step.name === 'Create release')?.run).not.toContain('Unsigned')
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

  it('routes shell updates only through the bounded startup controller', async () => {
    const main = await readFile(resolve(root, 'packages/desktop/src/main.ts'), 'utf8')
    expect(main).toContain('await shellUpdater.start()')
    expect(main).not.toContain('autoUpdater.checkForUpdates(')
    expect(main).not.toContain('autoUpdater.quitAndInstall(')
    expect(main.match(/return shellUpdater.manualStatus\(\)/g)).toHaveLength(2)
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
