import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const execute = promisify(execFile)

describe('desktop package inputs', () => {
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
