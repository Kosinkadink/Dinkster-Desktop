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

  it('builds the pinned, unrouted MXC executor from source for Windows packages', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'packages/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>
      build: { win: { extraResources: { from: string; to: string }[] } }
    }
    const preparation = await readFile(resolve(root, 'packages/desktop/scripts/prepare-mxc.mjs'), 'utf8')
    const signer = await readFile(resolve(root, 'packages/desktop/scripts/sign-mxc.mjs'), 'utf8')
    const verifier = await readFile(resolve(root, 'packages/desktop/scripts/verify-installed-mxc.mjs'), 'utf8')
    const provenance = JSON.parse(await readFile(resolve(root, 'packages/desktop/resources/sandbox/MXC-PROVENANCE.json'), 'utf8')) as Record<string, unknown>
    const license = await readFile(resolve(root, 'packages/desktop/resources/sandbox/MXC-LICENSE.txt'), 'utf8')

    expect(provenance).toMatchObject({
      name: 'wxc-exec.exe',
      source: 'https://github.com/microsoft/mxc',
      commit: 'c66201839d63cae2239db5e92f1f1d6076cf5181',
      license: 'MIT',
      toolchain: 'Rust 1.93',
    })
    expect(provenance.build).toEqual([
      'MXC_TELEMETRY_COMPONENT_PATH=',
      'cargo build --locked --release -p wxc --target x86_64-pc-windows-msvc',
    ])
    expect(license).toMatch(/^MIT License\r?\n/m)
    expect(preparation).toContain("MXC_TELEMETRY_COMPONENT_PATH: ''")
    expect(preparation).toContain("['build', '--locked', '--release', '-p', 'wxc', '--target', 'x86_64-pc-windows-msvc']")
    expect(preparation).toContain('mxc/archive/${commit}.zip')
    expect(manifest.scripts['package:win']).toContain('package:win:prepare')
    expect(manifest.scripts['package:win:signed']).toContain('sign:mxc')
    expect(manifest.build.win.extraResources).toContainEqual({ from: 'resources/sandbox', to: 'sandbox' })
    expect((manifest.build.win as { signExts?: string[] }).signExts).toContain('!wxc-exec.exe')
    expect(signer).toContain('createArtifactSigningHook(artifactSigning)')
    expect(signer).toContain("writeMxcBuild(executable, resolve(import.meta.dirname, '../resources/sandbox/mxc-build.json'))")
    expect(verifier).toContain("provenance.commit, 'c66201839d63cae2239db5e92f1f1d6076cf5181'")
  })

  it('writes the final executor hash into the MXC build manifest', async () => {
    const { writeMxcBuild } = await import('../scripts/mxc-build.mjs') as {
      writeMxcBuild(executable: string, destination: string): Promise<void>
    }
    const scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-mxc-build-'))
    const executable = resolve(scratch, 'wxc-exec.exe')
    const manifest = resolve(scratch, 'mxc-build.json')
    try {
      await writeFile(executable, 'unrouted executor')
      await writeMxcBuild(executable, manifest)
      expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual({
        format: 'dinkster.mxc/1',
        commit: 'c66201839d63cae2239db5e92f1f1d6076cf5181',
        telemetryComponent: '',
        sha256: 'c4a827a50fcd1c036ac659d1c5cc3dfd5e69d82f89aefa4faf81b8c7555cab38',
      })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
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
