import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const script = resolve(root, 'packages/desktop/scripts/verify-published-desktop.ps1')
const source = await readFile(resolve(root, '.github/workflows/verify-published-desktop.yml'), 'utf8')
const helper = await readFile(script, 'utf8')
const installedVerifier = await readFile(resolve(root, 'packages/e2e/scripts/verify-desktop-install.mjs'), 'utf8')
interface Step {
  id?: string
  name?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  'working-directory'?: string
  with?: Record<string, unknown>
}
const yaml = createRequire(import.meta.url)('js-yaml') as { load(source: string): unknown }
const workflow = yaml.load(source) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: { verify: { if: string; permissions?: unknown; steps: Step[] } }
}
const steps = workflow.jobs.verify.steps
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

describe('published Desktop verification workflow', () => {
  it('is disabled, dispatch-only, read-only, and cannot build or publish a release', () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.verify.if).toContain('&& false')
    expect(workflow.jobs.verify.permissions).toBeUndefined()
    expect(source).not.toMatch(/contents: write|package:win|gh release (create|upload|edit)|git push/)
  })

  it('downloads only the published Desktop with its repository token', () => {
    const downloads = steps.filter((step) => step.env?.['GH_TOKEN'])
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
    expect(downloads[0]?.run).toContain('-Action DownloadDesktop')
    expect(helper.match(/\bgh .*/g)).toEqual([
      'gh api "repos/$($Pin.repository)" | ConvertFrom-Json',
      'gh release download $Pin.releaseTag --repo $Pin.repository --pattern $Pin.archive --dir $assets',
    ])
    expect(helper).not.toMatch(/GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|githubtoken|auth login/)
  })

  it('verifies the installed control-runtime pair and fresh-project management flow', () => {
    expect(helper).toContain("'resources/control-runtime/descriptor.json'")
    expect(helper).toContain("$descriptor.format -cne 'dinkster.control-runtime/1'")
    expect(helper).toContain('Assert-Artifact @{ archive = (Split-Path $archive -Leaf)')
    expect(installedVerifier).toContain("window.dinksterDesktop.projectEngine()")
    expect(installedVerifier).toContain("getByTestId('desktop-management-button')")
    expect(installedVerifier).toContain("'-I', '-m', 'dinkster.cli', 'generations'")
    expect(`${source}\n${helper}\n${installedVerifier}`).not.toMatch(
      /prepare:engine|DINKSTER_ENGINE_ARCHIVE|DINKSTER_AIMDO_WHEEL|backend-release|resources\/engine|mismatched-profile/,
    )
  })

  it('always cleans only its owned installation and preserves bounded evidence', () => {
    const install = steps.find((step) => step.id === 'install')!
    const cleanup = steps.find((step) => step.run?.endsWith('-Action Cleanup'))!
    expect(install.env).toBeUndefined()
    expect(cleanup.if).toBe("always() && steps.install.outcome != 'skipped'")
    const upload = steps.find((step) => step.uses === 'actions/upload-artifact@v4')!
    expect(upload.if).toBe("always() && steps.install.outcome != 'skipped'")
    expect(upload.with?.['retention-days']).toBe(7)
    expect(upload.with?.['path']).not.toMatch(/\*\*|\.log|assets|cache|electron/)
    expect(helper).toContain('Remove-Item "Env:$($_.Name)"')
    expect(helper.indexOf('Remove-Item "Env:$($_.Name)"')).toBeLessThan(helper.indexOf('Start-Process'))
    expect(helper).toContain('Verification ownership mismatch')
  })

  it('records that no Desktop release has been published', async () => {
    const desktop = JSON.parse(await readFile(resolve(root, 'packages/desktop/scripts/published-desktop.json'), 'utf8'))
    expect(desktop).toEqual({ repository: 'Kosinkadink/Dinkster-Desktop', published: false })
    expect(helper).toContain("throw 'No Dinkster Desktop release has been published'")
  })
})

describe.runIf(process.platform === 'win32')('Windows verification safety', () => {
  let scratch: string
  beforeEach(async () => {
    scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-verify-safety-'))
  })
  afterEach(async () => { await rm(scratch, { recursive: true, force: true }) })

  function powershell(command: string): Promise<{ stdout: string; stderr: string }> {
    return execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
        value !== undefined && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|^GIT_/i.test(name))),
      timeout: 30_000,
    })
  }

  it('parses the helper and every workflow run block', async () => {
    const inputs = [helper, ...steps.flatMap((step) => step.run ? [step.run] : [])]
    const path = resolve(scratch, 'commands.json')
    await writeFile(path, JSON.stringify(inputs))
    await expect(powershell(`$ErrorActionPreference='Stop'; foreach ($source in (Get-Content ${psQuote(path)} -Raw | ConvertFrom-Json)) {
      $tokens=$null; $errors=$null
      [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
      if ($errors.Count) { throw ($errors | Out-String) }
    }`)).resolves.toBeDefined()
  })

  it('accepts exact artifact bytes and rejects size/hash tampering', async () => {
    const path = resolve(scratch, 'artifact.exe')
    await writeFile(path, 'fixture')
    const sha = createHash('sha256').update('fixture').digest('hex')
    const verify = helper.slice(helper.indexOf('function Assert-Artifact'), helper.indexOf('function Get-ReleaseArtifact'))
    const command = `${verify}\n$pin=@{archive='artifact.exe';size=7;sha256='${sha}'}\n`
    await expect(powershell(`${command}Assert-Artifact $pin ${psQuote(path)}`)).resolves.toBeDefined()
    await expect(powershell(`${command}$pin.size=8; Assert-Artifact $pin ${psQuote(path)}`)).rejects.toThrow('checksum/size mismatch')
    await expect(powershell(`${command}$pin.sha256='0'*64; Assert-Artifact $pin ${psQuote(path)}`)).rejects.toThrow('checksum/size mismatch')
  })

  it('cleans an empty owned installation without touching unrelated processes or retaining tokens', async () => {
    await mkdir(resolve(scratch, 'proof'))
    await writeFile(resolve(scratch, 'owned-install.json'), JSON.stringify({
      install: resolve(scratch, 'app'),
      data: resolve(scratch, 'run'),
    }))
    const fixtureScript = resolve(scratch, 'verify.ps1')
    await writeFile(fixtureScript, helper)
    await writeFile(resolve(scratch, 'published-desktop.json'), JSON.stringify({ published: false }))
    await powershell(`$env:DINKSTER_VERIFY_WORK=${psQuote(scratch)}; $env:GH_TOKEN='dummy-acquisition'; $env:GITHUB_TOKEN='dummy-fallback'
      function Get-CimInstance { [pscustomobject]@{ ExecutablePath='C:\\unrelated\\python.exe'; ProcessId=123 } }
      function Get-NetTCPConnection { }
      function Stop-Process { throw 'UNRELATED_PROCESS_STOP' }
      & ${psQuote(fixtureScript)} -Action Cleanup
      if ($env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Acquisition credential retained' }`)
    expect(JSON.parse(await readFile(resolve(scratch, 'proof/cleanup.json'), 'utf8'))).toMatchObject({
      clean: true,
      survivors: 0,
      listeners: 0,
      lifecycleLeasePresent: false,
    })
  })
})
