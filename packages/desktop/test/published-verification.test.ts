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
  jobs: { verify: { if: string; permissions?: unknown; env: Record<string, string>; steps: Step[] } }
}
const steps = workflow.jobs.verify.steps
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

describe('published Desktop verification workflow', () => {
  it('is dispatch-only, read-only and cannot build or publish a release', () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.verify.permissions).toBeUndefined()
    expect(source).not.toMatch(/contents: write|package:win|release-desktop\.yml|gh release (create|upload|edit)|git push/)
    expect(helper.match(/\bgh .*/g)).toEqual([
      'gh api "repos/$($Pin.repository)" | ConvertFrom-Json',
      'gh release download $Pin.releaseTag --repo $Pin.repository --pattern $Pin.archive --dir $assets',
    ])
  })

  it('keeps its safety contracts in fast CI without running the published installer', async () => {
    const fast = await readFile(resolve(root, 'scripts/ci-fast.mjs'), 'utf8')
    expect(fast).toContain('test/published-verification.test.ts')
    expect(fast).not.toMatch(/verify:installed|prepare:engine|verify-published-desktop\.ps1/)
  })

  it('guards before checkout and routes each acquisition token exclusively', () => {
    expect(steps[0]?.name).toBe('Require dedicated private release credential')
    expect(steps[1]?.uses).toBe('actions/checkout@v4')
    expect(steps[1]?.with).toEqual({ clean: true, 'persist-credentials': false })
    const backend = steps.find((step) => step.run?.endsWith('-Action DownloadBackend'))!
    const desktop = steps.find((step) => step.run?.endsWith('-Action DownloadDesktop'))!
    expect(steps[0]?.env).toEqual({ GH_TOKEN: '${{ secrets.DINKSTER_RELEASE_READ_TOKEN }}' })
    expect(backend.env).toEqual(steps[0]?.env)
    expect(desktop.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
    expect(steps.filter((step) => step.env?.['GH_TOKEN'])).toEqual([steps[0], backend, desktop])
    expect(helper).not.toMatch(/GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|githubtoken|auth login/)
    expect(helper).toContain('Get-ReleaseArtifact $aimdo')
    expect(helper).toContain('Get-ReleaseArtifact $desktop')
  })

  it('reuses the source-profile and CPU installed-app contracts and always cleans owned installs', () => {
    expect(steps.some((step) => step.run === 'pnpm --filter @dinkster/desktop prepare:engine')).toBe(true)
    const verify = steps.find((step) => step.run === 'pnpm --filter @dinkster/desktop verify:installed')!
    expect(verify.env).toEqual({ DINKSTER_ACCELERATOR: 'cpu' })
    expect(steps.find((step) => step.id === 'install')?.env).toBeUndefined()
    expect(steps.find((step) => step.run?.endsWith('-Action Cleanup'))?.if).toBe("always() && steps.install.outcome != 'skipped'")
    const upload = steps.find((step) => step.uses === 'actions/upload-artifact@v4')!
    expect(upload.if).toBe("always() && steps.install.outcome != 'skipped'")
    expect(upload.with?.['retention-days']).toBe(7)
    expect(upload.with?.['path']).not.toMatch(/\*\*|\.log|assets|cache|electron/)
    expect(helper).toContain('Remove-Item "Env:$($_.Name)"')
    expect(helper.indexOf('Remove-Item "Env:$($_.Name)"')).toBeLessThan(helper.indexOf('Start-Process'))
    expect(helper).toContain('Verification ownership mismatch')
    expect(helper).toContain("'Refusing to overwrite an existing installation, protocol, or verification environment'")
  })

  it('records that no Dinkster Desktop release has been published', async () => {
    const desktop = JSON.parse(await readFile(resolve(root, 'packages/desktop/scripts/published-desktop.json'), 'utf8'))
    expect(desktop).toEqual({ repository: 'Kosinkadink/Dinkster-Frontend', published: false })
    expect(workflow.jobs.verify.if).toContain('&& false')
    expect(helper).toContain("throw 'No Dinkster Desktop release has been published'")
    expect(helper).toContain('Assert-Artifact $Pin (Join-Path $assets $Pin.archive)')
    expect(helper).toContain('Assert-Artifact $pin (Join-Path $install "resources/engine/$($pin.archive)")')
  })

  it('keeps the proof code ready but does not select an unpublished source commit', async () => {
    const checkout = steps.find((step) => step.name === 'Check out the published frontend proof harness')!
    expect(checkout.with).toEqual({ clean: true, ref: 'main', path: 'published-source', 'persist-credentials': false })
    expect(workflow.jobs.verify.env['DINKSTER_PUBLISHED_SOURCE']).toBe('published-source')
    const commands = steps.filter((step) => step.run?.startsWith('pnpm '))
    expect(commands.map((step) => step.run)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm --filter @dinkster/desktop prepare:engine',
      'pnpm --filter @dinkster/desktop verify:installed',
    ])
    expect(commands.every((step) => step['working-directory'] === 'published-source')).toBe(true)
    expect(helper).toContain("Join-Path $env:DINKSTER_PUBLISHED_SOURCE 'packages/desktop/src/backend-release.json'")
    expect(helper).not.toContain("Join-Path $PSScriptRoot '../src/backend-release.json'")
  })
})

describe.runIf(process.platform === 'win32')('Windows verification safety', () => {
  let scratch: string
  beforeEach(async () => {
    scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-verify-safety-'))
    await mkdir(resolve(scratch, 'published/packages/desktop/src'), { recursive: true })
    await writeFile(resolve(scratch, 'published/packages/desktop/src/backend-release.json'), JSON.stringify({
      commit: '69130cdd6c00ffac7430c1564b5da30ec91db051',
      releaseTag: 'backend-69130cdd6c00ffac7430c1564b5da30ec91db051',
    }))
  })
  afterEach(async () => { await rm(scratch, { recursive: true, force: true }) })

  function powershell(command: string): Promise<{ stdout: string; stderr: string }> {
    return execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|^GIT_/i.test(name))),
        DINKSTER_PUBLISHED_SOURCE: resolve(scratch, 'published'),
      },
      timeout: 30_000,
    })
  }

  it('parses the PowerShell helper and every workflow run block', async () => {
    const inputs = [helper, ...steps.flatMap((step) => step.run ? [step.run] : [])]
    const path = resolve(scratch, 'commands.json')
    await writeFile(path, JSON.stringify(inputs))
    await expect(powershell(`$ErrorActionPreference='Stop'; foreach ($source in (Get-Content ${psQuote(path)} -Raw | ConvertFrom-Json)) {
      $tokens=$null; $errors=$null
      [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
      if ($errors.Count) { throw ($errors | Out-String) }
    }`)).resolves.toBeDefined()
  })

  it('downloads each fixture only with its repository-specific token and exports no token', async () => {
    const scripts = resolve(scratch, 'scripts')
    await mkdir(scripts)
    await mkdir(resolve(scratch, 'src'))
    const content = 'fixture'
    const digest = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
    const desktop = {
      repository: 'Kosinkadink/Dinkster-Frontend', published: true,
      releaseTag: 'desktop-v0.2.0', commit: 'c'.repeat(40),
      archive: 'Dinkster-Desktop-0.2.0-Setup.exe', backendCommit: 'a'.repeat(40),
    }
    const backend = JSON.parse(await readFile(resolve(root, 'packages/desktop/src/backend-release.json'), 'utf8'))
    await writeFile(resolve(scripts, 'published-desktop.json'), JSON.stringify({ ...desktop, ...digest }))
    await writeFile(resolve(scratch, 'src/backend-release.json'), 'invalid moving-main pin')
    await writeFile(resolve(scratch, 'published/packages/desktop/src/backend-release.json'), JSON.stringify({
      ...backend, ...digest, commit: desktop.backendCommit, releaseTag: `backend-${desktop.backendCommit}`,
      desktopWindowsRuntime: {
        ...backend.desktopWindowsRuntime,
        aimdo: { ...backend.desktopWindowsRuntime.aimdo, ...digest },
      },
    }))
    const fixtureScript = resolve(scripts, 'verify.ps1')
    await writeFile(fixtureScript, helper)
    const envFile = resolve(scratch, 'exported-env')
    await powershell(`$env:DINKSTER_VERIFY_WORK=${psQuote(resolve(scratch, 'work'))}; $env:GITHUB_ENV=${psQuote(envFile)}
      function gh {
        $global:LASTEXITCODE=0
        if ($args[0] -eq 'api') { $repo=$args[1].Substring(6) }
        elseif ($args[0] -eq 'release' -and $args[1] -eq 'download') { $repo=$args[4] }
        else { throw 'UNEXPECTED_GH_OPERATION' }
        $allowed = if ($env:GH_TOKEN -eq 'backend-only') { @('Kosinkadink/Dinkster','Kosinkadink/dinkster-aimdo') }
          elseif ($env:GH_TOKEN -eq 'frontend-only') { @('Kosinkadink/Dinkster-Frontend') } else { @() }
        if ($repo -notin $allowed) { throw 'WRONG_TOKEN_ROUTE' }
        if ($args[0] -eq 'api') { '{"private":true}' }
        else { [IO.File]::WriteAllText((Join-Path $args[8] $args[6]), 'fixture') }
      }
      $env:GH_TOKEN='backend-only'; & ${psQuote(fixtureScript)} -Action DownloadBackend
      $env:GH_TOKEN='frontend-only'; & ${psQuote(fixtureScript)} -Action DownloadDesktop`)
    const exported = await readFile(envFile, 'utf8')
    expect(exported).toContain('DINKSTER_ENGINE_ARCHIVE=')
    expect(exported).toContain('DINKSTER_AIMDO_WHEEL=')
    expect(exported).not.toMatch(/TOKEN|backend-only|frontend-only/)
    expect(await readFile(resolve(scratch, 'work/assets', desktop.archive), 'utf8')).toBe(content)
  })

  it.each(['workflow guard', 'download helper'])('fails the %s with a dummy fallback token before GH access', async (target) => {
    const command = target === 'workflow guard' ? steps[0]!.run!
      : `& ${psQuote(script)} -Action DownloadBackend`
    await expect(powershell(`$env:GITHUB_TOKEN='dummy-fallback'; $env:GH_ENTERPRISE_TOKEN='dummy-fallback'
      function gh { throw 'UNEXPECTED_GH_ACCESS' }
      ${command}`)).rejects.toThrow(/no fallback token is permitted/)
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
    await writeFile(resolve(scratch, 'owned-install.json'), JSON.stringify({ install: resolve(scratch, 'app'), data: resolve(scratch, 'run') }))
    await powershell(`$env:DINKSTER_VERIFY_WORK=${psQuote(scratch)}; $env:GH_TOKEN='dummy-acquisition'; $env:GITHUB_TOKEN='dummy-fallback'
      function Get-CimInstance { [pscustomobject]@{ ExecutablePath='C:\\unrelated\\python.exe'; ProcessId=123 } }
      function Get-NetTCPConnection { }
      function Stop-Process { throw 'UNRELATED_PROCESS_STOP' }
      & ${psQuote(script)} -Action Cleanup
      if ($env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Acquisition credential retained' }`)
    expect(JSON.parse(await readFile(resolve(scratch, 'proof/cleanup.json'), 'utf8'))).toMatchObject({ clean: true, survivors: 0, listeners: 0, lifecycleLeasePresent: false })
  })
})
