import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const yaml = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): unknown
}
interface Step {
  id?: string
  if?: string
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
  environment?: string
  needs?: string | string[]
  uses?: string
  secrets?: string
  outputs?: Record<string, string>
  'runs-on'?: string | string[]
  'timeout-minutes'?: number
  steps?: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  env?: Record<string, string>
  jobs: Record<string, Job>
}
const load = async (name: string): Promise<Workflow> =>
  yaml.load(
    await readFile(resolve(root, '.github/workflows', name), 'utf8'),
  ) as Workflow

const ci = await load('ci.yml')
const full = await load('full-validation.yml')
const release = await load('release-desktop.yml')
const publish = await load('publish-desktop.yml')
const signed = await load('signed-package.yml')
const published = await load('verify-published-desktop.yml')

describe('desktop workflows', () => {
  it('pins pull-request and release builds to the same frontend commit', () => {
    expect(ci.env?.['DINKSTER_FRONTEND_REF']).toMatch(/^[0-9a-f]{40}$/)
    expect(full.env?.['DINKSTER_FRONTEND_REF']).toBe(
      ci.env?.['DINKSTER_FRONTEND_REF'],
    )
    expect(release.env?.['DINKSTER_FRONTEND_REF']).toBe(
      ci.env?.['DINKSTER_FRONTEND_REF'],
    )
    expect(signed.env?.['DINKSTER_FRONTEND_REF']).toBe(
      ci.env?.['DINKSTER_FRONTEND_REF'],
    )
  })

  it('shares installer builds with draft publication and isolates manual signing', () => {
    expect(release.on).toMatchObject({
      push: { branches: ['main'] },
      pull_request: { paths: expect.arrayContaining(['.github/workflows/release-desktop.yml', 'packages/desktop/src/environment-tools-release.json']) },
      workflow_call: { inputs: { source: { required: true }, signed: { default: false } } },
    })
    expect(release.on.push).not.toHaveProperty('tags')
    expect(publish.jobs['build']!.uses).toBe('./.github/workflows/release-desktop.yml')
    expect(signed.on).toEqual({ workflow_dispatch: null })
    expect(signed.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(signed.jobs)).toEqual(['package'])
    const job = signed.jobs['package']!
    expect(job.environment).toBe('desktop-signing')
    expect(release.jobs['release']!.environment).toBe(job.environment)
    expect(job.if).toBe("github.repository == 'Kosinkadink/Dinkster-Desktop'")
    expect(job.needs).toBeUndefined()
    const names = (steps: Step[] | undefined) =>
      steps?.map((step) => step.name ?? step.run ?? step.uses) ?? []
    const releaseSteps = release.jobs['release']!.steps!
    const signing = 'Package and sign with Artifact Signing'
    const verify = 'Verify publisher signatures'
    const install = 'Install into an isolated directory'
    for (const name of [signing, verify, install]) {
      const ours = job.steps?.find((step) => step.name === name)
      const theirs = releaseSteps.find((step) => step.name === name)
      expect(ours?.run, name).toBe(theirs?.run)
      expect(ours?.env, name).toEqual(theirs?.env)
    }
    expect(names(job.steps)).toContain('pnpm --filter @dinkster/desktop verify:installed')
    expect(names(job.steps)).toContain('Keep the signed installer')
    const source = JSON.stringify(signed)
    expect(source).not.toMatch(/gh release create|contents: write|DESKTOP_TAG/)
  })

  it('runs typecheck, all unit tests, and a Linux build on pull requests', () => {
    expect(ci.on).toMatchObject({ pull_request: null })
    expect(ci.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(ci.jobs)).toEqual(['test', 'pr-status'])
    const job = ci.jobs['test']!
    expect(job.needs).toBeUndefined()
    expect(job.if).toBeUndefined()
    expect(job['timeout-minutes']).toBe(10)
    expect(job['runs-on']).toBe('${{ fromJSON(vars.CI_RUNNERS).linux }}')
    expect(job.steps?.flatMap((step) => step.run ?? [])).toEqual([
      'pnpm --dir .frontend install --frozen-lockfile',
      'pnpm --dir .frontend --filter @dinkster/app build',
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
    ])
    const frontend = job.steps?.find(
      (step) => step.with?.['repository'] === 'Kosinkadink/Dinkster-Frontend',
    )
    expect(frontend?.with).toMatchObject({
      clean: true,
      'persist-credentials': false,
      ref: '${{ env.DINKSTER_FRONTEND_REF }}',
      path: '.frontend',
    })
    expect(frontend?.with).not.toHaveProperty('token')
    const status = ci.jobs['pr-status']!
    expect(status.if).toBe('always()')
    expect(status.needs).toEqual(['test'])
    const statusSource = status.steps?.flatMap((step) => step.run ?? []).join('\n')
    expect(statusSource).toContain('test "$TEST_RESULT" = success')
  })

  it('runs Linux build, packaged Desktop startup, and Windows package lanes on main', () => {
    expect(full.on).toMatchObject({
      push: { branches: ['main'] },
      workflow_dispatch: null,
      workflow_call: null,
    })
    expect(Object.keys(full.jobs)).toEqual([
      'linux',
      'desktop-smoke',
      'windows-package',
      'windows-installed',
      'main-status',
    ])
    expect(full.jobs['linux']!['runs-on']).toBe(
      '${{ fromJSON(vars.CI_RUNNERS).linux }}',
    )
    expect(full.jobs['desktop-smoke']!['runs-on']).toBe(
      '${{ fromJSON(vars.CI_RUNNERS).linux }}',
    )
    expect(full.jobs['windows-package']!['runs-on']).toBe(
      '${{ fromJSON(vars.CI_RUNNERS).windows }}',
    )
    expect(full.jobs['windows-package']!['timeout-minutes']).toBe(20)
    const windowsCommands = full.jobs['windows-package']!.steps?.flatMap(
      (step) => step.run ?? [],
    )
    expect(windowsCommands).toContain(
      'pnpm --filter @dinkster/desktop package:win',
    )
    expect(windowsCommands).toContain(
      'pnpm --filter @dinkster/desktop verify:update-feed',
    )
    const smokeCommands = full.jobs['desktop-smoke']!.steps?.flatMap(
      (step) => step.run ?? [],
    )
    expect(smokeCommands).toContain('xvfb-run --auto-servernum node packages/e2e/scripts/verify-environment-client.mjs')
    expect(smokeCommands).toContain('pnpm --filter @dinkster/desktop exec electron-builder --linux --dir --config electron-builder.smoke.mjs --publish never')
    const client = full.jobs['desktop-smoke']!.steps?.find((step) => step.run?.includes('node packages/e2e/scripts/verify-environment-client.mjs'))
    expect(client?.env).toEqual({
      DINKSTER_ELECTRON_EXECUTABLE: 'packages/desktop/release/linux-unpacked/dinkster-desktop-smoke',
    })
    expect(smokeCommands!.indexOf('pnpm --filter @dinkster/desktop exec electron-builder --linux --dir --config electron-builder.smoke.mjs --publish never'))
      .toBeLessThan(smokeCommands!.indexOf(client!.run!))
    const installed = full.jobs['desktop-smoke']!.steps?.find((step) => step.run?.includes('node packages/e2e/scripts/verify-desktop-install.mjs'))
    expect(installed?.env).toEqual({
      DINKSTER_DESKTOP_EXECUTABLE: 'packages/desktop/release/linux-unpacked/dinkster-desktop-smoke',
      DINKSTER_DESKTOP_VERIFY_ROOT: 'test-results/desktop-smoke/installed',
    })
    expect(JSON.stringify(full)).not.toMatch(/prepare-smoke-backend|engine-source|setup-uv|DINKSTER_REF/)
    expect(JSON.stringify(full)).not.toContain('playwright.audit-assets.config.ts')
  })

  it('requires installed Windows first start without Git before main can pass', () => {
    const installed = full.jobs['windows-installed']!
    expect(installed.needs).toBe('windows-package')
    expect(installed['runs-on']).toBe('${{ fromJSON(vars.CI_RUNNERS).windows }}')
    expect(installed['timeout-minutes']).toBe(60)
    const download = installed.steps?.find((step) => step.uses === 'actions/download-artifact@v4')
    expect(download?.with?.['name']).toBe('windows-installer')
    const upload = full.jobs['windows-package']!.steps?.find((step) => step.uses === 'actions/upload-artifact@v4')
    expect(upload?.with?.['name']).toBe(download?.with?.['name'])
    expect(installed.steps?.map((step) => step.run)).toContain('pnpm --filter @dinkster/desktop verify:installed')
    expect(full.jobs['main-status']!.needs).toContain('windows-installed')
    const requireSuccess = full.jobs['main-status']!.steps?.find((step) => step.name === 'Require every lane to pass')
    expect(requireSuccess?.env?.['INSTALLED_RESULT']).toBe('${{ needs.windows-installed.result }}')
    expect(requireSuccess?.run).toContain('test "$INSTALLED_RESULT" = success')
  })

  it('uses hosted macOS directly and the runner variable for existing platforms', () => {
    for (const workflow of [ci, full, release, signed, published, publish]) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (job.uses) continue
        if (workflow === release && name === 'macos') {
          expect(job['runs-on']).toBe('macos-latest')
          continue
        }
        expect(job['runs-on'], name).toMatch(
          /^\$\{\{ fromJSON\(vars\.CI_RUNNERS\)(\.(linux|windows)|\[matrix\.os\]) \}\}$/,
        )
      }
    }
  })

  it('packages unsigned arm64 macOS without the signing environment or publication', () => {
    const job = release.jobs['macos']!
    expect(job.environment).toBeUndefined()
    expect(job.needs).toBeUndefined()
    const source = JSON.stringify(job)
    expect(source).not.toMatch(/secrets\.|desktop-signing|gh release|notarytool|package:win:signed/)
    expect(job.steps?.flatMap(step => step.run ?? [])).toContain('pnpm --filter @dinkster/desktop package:mac')
    const verification = job.steps?.find(step => step.name === 'Verify the extracted Apple Silicon app')
    expect(verification?.run).toContain('test "$(lipo -archs "$executable")" = arm64')
    expect(verification?.run).toContain('verify-installed-tools.mjs "$RUNNER_TEMP/dinkster-macos-installed/Dinkster Desktop.app/Contents/Resources" > installed-tools.json')
    expect(verification?.run).toContain('shasum -a 256')
    const upload = job.steps?.find(step => step.uses === 'actions/upload-artifact@v4')
    expect(upload?.with?.['path']).toContain('*-macos-arm64.zip')
    expect(upload?.with?.['path']).toContain('installer-SHA256SUMS')
    expect(upload?.with?.['path']).toContain('installed-tools.json')
    expect(upload?.with?.['if-no-files-found']).toBe('error')
  })

  it('publishes one aggregate status that fails for every incomplete lane', () => {
    const status = full.jobs['main-status']!
    expect(status.if).toBe('always()')
    expect(status.needs).toEqual([
      'linux',
      'desktop-smoke',
      'windows-package',
      'windows-installed',
    ])
    const source = status.steps?.flatMap((step) => step.run ?? []).join('\n')
    expect(source).toContain('main-validation-status.json')
    expect(source).toContain('test "$LINUX_RESULT" = success')
    expect(source).toContain('test "$SMOKE_RESULT" = success')
    expect(source).toContain('test "$WINDOWS_RESULT" = success')
    expect(source).toContain('test "$INSTALLED_RESULT" = success')
  })

  it('uses clean checkouts without persisting credentials', () => {
    for (const workflow of [ci, full, release, signed, published, publish]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of (job.steps ?? []).filter(
          (entry) => entry.uses === 'actions/checkout@v4',
        )) {
          expect(step.with).toMatchObject({
            clean: true,
            'persist-credentials': false,
          })
          expect(step.with).not.toHaveProperty('ssh-key')
          expect(step.with).not.toHaveProperty('token')
        }
      }
    }
  })

  it('excludes backend downloads and scopes published shell acquisition', () => {
    for (const workflow of [full, release, signed, published]) {
      const downloadSteps = Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).filter(
          (step) =>
            step.run?.includes('DownloadBackend') ||
            step.run?.includes('gh release download'),
        ),
      )
      expect(downloadSteps).toEqual([])
    }
    const desktop = published.jobs['verify']!.steps?.find((step) => step.run?.includes('-Action DownloadDesktop'))
    expect(desktop?.env?.['GH_TOKEN']).toBe('${{ github.token }}')
    expect(JSON.stringify([full, release, signed, published])).not.toContain(
      'DINKSTER_RELEASE_READ_TOKEN',
    )
  })

  it('builds signed assets only for validated drafts without creating releases or refs', () => {
    expect(release.jobs['release']!.needs).toEqual(['macos'])
    expect(release.jobs['release']!.if).toBe("github.repository == 'Kosinkadink/Dinkster-Desktop' && inputs.signed")
    const steps = release.jobs['release']!.steps!
    expect(steps.find((step) => step.name === 'Keep the signed installer')?.with?.['name']).toBe('desktop-signed-installer')
    expect(JSON.stringify([release, publish])).not.toMatch(/gh release create|git push|git\/refs/)
    expect(publish.on).toHaveProperty('workflow_dispatch')
    expect(publish.permissions).toEqual({ contents: 'read' })
    expect(publish.jobs['publish']).toHaveProperty('permissions', { contents: 'write' })
    expect(publish.jobs['publish']!.needs).toEqual(['draft', 'build'])
    expect(publish.jobs['draft']!.if).toContain("github.ref == 'refs/heads/main'")
  })

  it('admits only matching source and verified Mac bytes into the shared release', async () => {
    const steps = release.jobs['release']!.steps!
    const upload = release.jobs['macos']!.steps!.find(step => step.uses === 'actions/upload-artifact@v4')!
    const download = steps.find(step => step.name === 'Acquire the verified unsigned Mac installer')!
    expect(download.with?.['name']).toBe(upload.with?.['name'])
    const verify = steps.find(step => step.name === 'Verify the Mac installer belongs to this release')!
    const script = verify.run!.match(/<<'JS'\n([\s\S]*)\nJS\n?$/)![1]!
    const assets = steps.find(step => step.name === 'Keep the complete verified release asset set')!
    expect(assets.with?.['path']).toContain('packages/desktop/macos-release/*-macos-arm64.zip')
    expect(assets.with?.['path']).toContain('packages/desktop/macos-release/desktop-macos-release.json')
    const scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-macos-release-'))
    const directory = resolve(scratch, 'packages/desktop')
    const name = 'Dinkster-Desktop-0.2.0-macos-arm64.zip'
    const bytes = Buffer.from('native Mac archive')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const metadata = { repository: 'Kosinkadink/Dinkster-Desktop', commit: 'source-head', frontend: 'frontend-head', version: '0.2.0', archive: name, platform: { os: 'macos', arch: 'arm64' }, signed: false, notarized: false, size: bytes.length, sha256 }
    const execute = promisify(execFile)
    const run = () => execute(process.execPath, ['--input-type=module', '-e', script], { cwd: scratch, env: { ...process.env, DESKTOP_SOURCE_COMMIT: metadata.commit, DINKSTER_FRONTEND_REF: metadata.frontend } })
    const record = (value: object) => writeFile(resolve(directory, 'macos-release/desktop-macos-release.json'), JSON.stringify(value))
    try {
      await mkdir(resolve(directory, 'macos-release'), { recursive: true })
      await mkdir(resolve(directory, 'release'))
      await writeFile(resolve(directory, 'package.json'), JSON.stringify({ version: metadata.version }))
      await writeFile(resolve(directory, 'macos-release', name), bytes)
      await writeFile(resolve(directory, 'release/SHA256SUMS'), 'windows checksum\n')
      await record(metadata)
      await run()
      const expected = `windows checksum\n${sha256}  ${name}\n`
      expect(await readFile(resolve(directory, 'release/SHA256SUMS'), 'utf8')).toBe(expected)
      for (const mismatch of [{ commit: 'other-head' }, { version: '0.3.0' }, { signed: true }, { size: bytes.length + 1 }]) {
        await record({ ...metadata, ...mismatch })
        await expect(run()).rejects.toThrow()
      }
      await record(metadata)
      const corrupt = Buffer.from(bytes)
      corrupt[0] = corrupt[0]! ^ 1
      await writeFile(resolve(directory, 'macos-release', name), corrupt)
      await expect(run()).rejects.toThrow()
      expect(await readFile(resolve(directory, 'release/SHA256SUMS'), 'utf8')).toBe(expected)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('produces both native installers without signing or publishing on main and relevant pull requests', () => {
    const job = release.jobs['installers']!
    expect(job.environment).toBeUndefined()
    const steps = job.steps!
    expect(steps.find((step) => step.run === 'pnpm --filter @dinkster/desktop package:linux')?.if).toBe("matrix.os == 'linux'")
    expect(steps.find((step) => step.run === 'pnpm --filter @dinkster/desktop package:win')?.if).toBe("matrix.os == 'windows'")
    for (const name of ['Extract Linux installer and verify resources', 'Install Windows package and verify resources']) {
      expect(steps.find((step) => step.name === name)?.run).toContain('verify-installed-tools.mjs')
    }
    expect(steps.find((step) => step.uses === 'actions/upload-artifact@v4')?.with).toMatchObject({
      name: 'desktop-${{ matrix.os }}-installer', 'if-no-files-found': 'error',
    })
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|gh release create|package:win:signed/)
    const smoke = full.jobs['desktop-smoke']!.steps!.map((step) => step.run ?? '')
    expect(smoke.indexOf('pnpm --filter @dinkster/desktop prepare:tools')).toBeLessThan(smoke.indexOf('pnpm --filter @dinkster/desktop exec electron-builder --linux --dir --config electron-builder.smoke.mjs --publish never'))
    expect(smoke).toContain('node packages/desktop/scripts/verify-installed-tools.mjs packages/desktop/release/linux-unpacked/resources')
  })

  it('refuses invalid drafts and verifies uploaded bytes before making a release public', async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-draft-'))
    const execute = promisify(execFile)
    const commit = 'a'.repeat(40)
    const state = resolve(scratch, 'state.json')
    const mock = resolve(scratch, 'gh.cjs')
    const output = resolve(scratch, 'output')
    const summary = resolve(scratch, 'summary')
    const macName = 'Dinkster-Desktop-0.2.3-macos-arm64.zip'
    const winName = 'Dinkster-Desktop-0.2.3-Setup.exe'
    const record = (value: object) => writeFile(state, JSON.stringify(value))
    const draft = { tagName: 'desktop-v0.2.3-probe', isDraft: true, targetCommitish: commit, assets: [] }
    const run = (mode: string, tag = draft.tagName) => execute(process.execPath, ['--import', pathToFileURL(mock).href, resolve(root, 'scripts/publish-desktop.mjs'), mode], {
      cwd: scratch,
      env: { ...process.env, RELEASE_TAG: tag, DESKTOP_SOURCE_COMMIT: commit, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, DRAFT_TEST_STATE: state },
    })
    try {
      // Replace only the external CLI boundary; the actual publication program runs unchanged.
      await writeFile(mock, `
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
cp.execFileSync = (file, args) => {
  if (file !== 'gh') throw Error('Unexpected executable');
  const location = process.env.DRAFT_TEST_STATE;
  const state = JSON.parse(fs.readFileSync(location));
  if (args[0] === 'api') return Buffer.from(JSON.stringify({version:'0.2.3'})).toString('base64');
  if (args[1] === 'view') return JSON.stringify(state);
  if (args[1] === 'upload') {
    state.assets = args.slice(3, args.indexOf('--repo')).map(file => ({name:path.basename(file), bytes:fs.readFileSync(file).toString('base64')}));
  } else if (args[1] === 'download') {
    const asset = state.assets.find(asset => asset.name === args[args.indexOf('--pattern') + 1]);
    fs.writeFileSync(args[args.indexOf('--output') + 1], state.corrupt ? 'corrupt' : Buffer.from(asset.bytes, 'base64'));
  } else if (args[1] === 'edit') {
    if (state.refuse) throw Error('Publication refused');
    state.isDraft = false;
    state.isPrerelease = args.includes('--prerelease');
    state.latest = args.includes('--latest=false') ? false : true;
  } else throw Error('Unexpected operation');
  fs.writeFileSync(location, JSON.stringify(state));
  return '';
};
require('node:module').syncBuiltinESMExports();
`)
      await record(draft)
      await run('resolve')
      expect(await readFile(output, 'utf8')).toBe(`source=${commit}\n`)
      for (const invalid of [{ isDraft: false }, { tagName: 'desktop-v0.2.4-probe' }, { tagName: 'v0.2.3' }, { targetCommitish: 'main' }]) {
        await record({ ...draft, ...invalid })
        await expect(run('resolve', invalid.tagName ?? draft.tagName)).rejects.toThrow()
      }
      await mkdir(resolve(scratch, 'release-assets/release'), { recursive: true })
      await mkdir(resolve(scratch, 'release-assets/macos-release'))
      const metadata = async (folder: string, name: string, bytes: string, extra = {}) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        await writeFile(resolve(scratch, `release-assets/${folder}/${name}`), bytes)
        return { repository: 'Kosinkadink/Dinkster-Desktop', commit, version: '0.2.3', archive: name, size: Buffer.byteLength(bytes), sha256, ...extra }
      }
      const windows = await metadata('release', winName, 'signed installer')
      const mac = await metadata('macos-release', macName, 'unsigned arm64 ZIP', { platform: { os: 'macos', arch: 'arm64' }, signed: false, notarized: false })
      await writeFile(resolve(scratch, 'release-assets/release/desktop-release.json'), JSON.stringify(windows))
      await writeFile(resolve(scratch, 'release-assets/macos-release/desktop-macos-release.json'), JSON.stringify(mac))
      await writeFile(resolve(scratch, 'release-assets/release/SHA256SUMS'), `${windows.sha256}  ${winName}\r\n${mac.sha256}  ${macName}\n`)
      await record(draft)
      await run('publish')
      const test = JSON.parse(await readFile(state, 'utf8'))
      expect(test.isDraft).toBe(false)
      expect(test.isPrerelease).toBe(true)
      expect(test.latest).toBe(false)
      expect(test.assets.map((asset: { name: string }) => asset.name).sort()).toEqual([winName, macName, 'desktop-release.json', 'desktop-macos-release.json', 'SHA256SUMS'].sort())
      const stable = { ...draft, tagName: 'desktop-v0.2.3' }
      await record(stable)
      await run('publish', stable.tagName)
      expect(JSON.parse(await readFile(state, 'utf8'))).toMatchObject({ isDraft: false, isPrerelease: false })
      for (const failure of [{ corrupt: true }, { refuse: true }, { targetCommitish: 'b'.repeat(40) }]) {
        await record({ ...stable, ...failure })
        await expect(run('publish', stable.tagName)).rejects.toThrow()
        expect(JSON.parse(await readFile(state, 'utf8')).isDraft).toBe(true)
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('keeps published verification disabled and read-only', () => {
    expect(published.permissions).toEqual({ contents: 'read' })
    expect(published.jobs['verify']!.if).toContain(
      "github.repository == 'Kosinkadink/Dinkster-Desktop'",
    )
    expect(published.jobs['verify']!.if).toContain('&& false')
  })
})
