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
const tagRelease = await load('release-from-pr-label.yml')
const signed = await load('signed-package.yml')
const published = await load('verify-published-desktop.yml')

describe('desktop workflows', () => {
  it('shares installer builds with tag publication and isolates manual signing', () => {
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
    for (const workflow of [ci, full, release, signed, published, publish, tagRelease]) {
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

  it('builds signed assets only for validated tags without creating refs in the publisher', () => {
    expect(release.jobs['release']!.needs).toEqual(['macos'])
    expect(release.jobs['release']!.if).toBe("github.repository == 'Kosinkadink/Dinkster-Desktop' && inputs.signed")
    const steps = release.jobs['release']!.steps!
    expect(steps.find((step) => step.name === 'Keep the signed installer')?.with?.['name']).toBe('desktop-signed-installer')
    expect(JSON.stringify([release, publish])).not.toMatch(/gh release create|git push|git\/refs/)
    expect(publish.on).toHaveProperty('workflow_dispatch')
    expect(publish.permissions).toEqual({ contents: 'read' })
    expect(publish.jobs['publish']).toHaveProperty('permissions', { contents: 'write' })
    expect(publish.jobs['publish']!.needs).toEqual(['validate', 'build'])
    expect(publish.jobs['validate']!.if).toContain("github.repository == 'Kosinkadink/Dinkster-Desktop'")
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

  it('refuses invalid tags and verifies installer bytes before creating a release', async () => {
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
    const draft = { tagName: 'desktop-v0.2.3', targetCommitish: commit, assets: [] }
    const run = (mode: string, tag = draft.tagName) => execute(process.execPath, ['--import', pathToFileURL(mock).href, resolve(root, 'scripts/publish-desktop.mjs'), mode], {
      cwd: scratch,
      env: { ...process.env, GITHUB_REF: `refs/tags/${tag}`, RELEASE_TAG: tag, DESKTOP_SOURCE_COMMIT: commit, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, DRAFT_TEST_STATE: state },
    })
    try {
      // Replace only the external CLI boundary; the actual publication program runs unchanged.
      await writeFile(mock, `
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
cp.execFileSync = (file, args) => {
  const location = process.env.DRAFT_TEST_STATE;
  const state = JSON.parse(fs.readFileSync(location));
  if (file === 'git') return '${commit}';
  if (file !== 'gh') throw Error('Unexpected executable');
  if (args[0] === 'api') return args[1] === 'graphql'
    ? JSON.stringify({data:{repository:{release:state.exists ? {id:'existing'} : null}}})
    : JSON.stringify({sha:state.targetCommitish});
  if (args[1] === 'view') return JSON.stringify(state);
  if (args[1] === 'create') {
    if (!args.includes('--verify-tag') || args.includes('--target')) throw Error('Unsafe release creation');
    if (state.refuse) throw Error('Publication refused');
    state.assets = args.slice(3, args.indexOf('--verify-tag')).map(file => ({name:path.basename(file)}));
    state.isDraft = false;
    state.created = true;
    state.isPrerelease = args.includes('--prerelease');
    state.latest = args.includes('--latest=false') ? false : true;
  } else throw Error('Unexpected operation');
  fs.writeFileSync(location, JSON.stringify(state));
  return '';
};
require('node:module').syncBuiltinESMExports();
`)
      await mkdir(resolve(scratch, 'packages/desktop'), { recursive: true })
      await writeFile(resolve(scratch, 'packages/desktop/package.json'), JSON.stringify({version:'0.2.3'}))
      await record(draft)
      await run('validate')
      expect(await readFile(output, 'utf8')).toBe(`source=${commit}\n`)
      for (const invalid of [{ exists: true }, { tagName: 'desktop-v0.2.4' }, { tagName: 'v0.2.3' }, { targetCommitish: 'b'.repeat(40) }]) {
        await record({ ...draft, ...invalid })
        await expect(run('validate', invalid.tagName ?? draft.tagName)).rejects.toThrow()
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
      expect(test.isPrerelease).toBe(false)
      expect(test.latest).toBe(true)
      expect(test.assets.map((asset: { name: string }) => asset.name).sort()).toEqual([winName, macName, 'desktop-release.json', 'desktop-macos-release.json', 'SHA256SUMS'].sort())
      const stable = { ...draft, tagName: 'desktop-v0.2.3' }
      await record(stable)
      await run('publish', stable.tagName)
      expect(JSON.parse(await readFile(state, 'utf8'))).toMatchObject({ isDraft: false, isPrerelease: false })
      for (const failure of [{ refuse: true }, { targetCommitish: 'b'.repeat(40) }, { exists: true }]) {
        await record({ ...stable, ...failure })
        await expect(run('publish', stable.tagName)).rejects.toThrow()
        expect(JSON.parse(await readFile(state, 'utf8')).created).toBeUndefined()
      }
      await record(stable)
      await writeFile(resolve(scratch, `release-assets/release/${winName}`), 'corrupt')
      await expect(run('publish')).rejects.toThrow()
      expect(JSON.parse(await readFile(state, 'utf8')).created).toBeUndefined()
      const version = '0.2.3-rc.1'
      const rcMacName = macName.replace('0.2.3', version)
      const rcWinName = winName.replace('0.2.3', version)
      const rcWindows = await metadata('release', rcWinName, 'signed rc installer', { version })
      const rcMac = await metadata('macos-release', rcMacName, 'unsigned rc ZIP', { platform: { os: 'macos', arch: 'arm64' }, signed: false, notarized: false, version })
      await writeFile(resolve(scratch, 'packages/desktop/package.json'), JSON.stringify({ version }))
      await writeFile(resolve(scratch, 'release-assets/release/desktop-release.json'), JSON.stringify(rcWindows))
      await writeFile(resolve(scratch, 'release-assets/macos-release/desktop-macos-release.json'), JSON.stringify(rcMac))
      await writeFile(resolve(scratch, 'release-assets/release/SHA256SUMS'), `${rcWindows.sha256}  ${rcWinName}\n${rcMac.sha256}  ${rcMacName}\n`)
      await record({ ...draft, tagName: `desktop-v${version}` })
      await run('publish', `desktop-v${version}`)
      expect(JSON.parse(await readFile(state, 'utf8'))).toMatchObject({ created: true, isPrerelease: true, latest: false })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('tags only a merged same-repository labelled version change', async () => {
    expect(tagRelease.on).toEqual({ pull_request_target: { types: ['closed'] } })
    expect(tagRelease.permissions).toEqual({ contents: 'write', actions: 'write', 'pull-requests': 'read' })
    expect(tagRelease.jobs['tag']!.if).toContain("contains(github.event.pull_request.labels.*.name, 'Release')")
    const scratch = await mkdtemp(resolve(tmpdir(), 'dinkster-version-pr-'))
    const eventPath = resolve(scratch, 'event.json')
    const state = resolve(scratch, 'state.json')
    const mock = resolve(scratch, 'cli.cjs')
    const commit = 'c'.repeat(40)
    const event = { repository: {full_name:'Kosinkadink/Dinkster-Desktop'}, pull_request: {merged:true, base:{ref:'main'}, head:{repo:{full_name:'Kosinkadink/Dinkster-Desktop'}}, labels:[{name:'Release'}], merge_commit_sha:commit} }
    try {
      await writeFile(mock, `
const cp=require('node:child_process'); const fs=require('node:fs');
cp.execFileSync=(file,args)=>{
 const location=process.env.TAG_TEST_STATE; const s=JSON.parse(fs.readFileSync(location));
 if(file==='git') return JSON.stringify({version:args[1].includes('^:') ? s.before : s.after});
 if(file!=='gh') throw Error('Unexpected executable');
 if(args[1].includes('matching-refs')) return JSON.stringify(s.existing ? [{ref:'refs/tags/desktop-v0.2.4-rc.1'}] : []);
 if(args[1].includes('/commits/')) return JSON.stringify({sha:s.existing});
 if(args[0]==='api') { if(args[args.indexOf('-f')+1]!=='ref=refs/tags/desktop-v0.2.4-rc.1') throw Error('Wrong ref'); s.tagged=true; }
 else if(args[0]==='workflow') { if(args[args.indexOf('--ref')+1]!=='desktop-v0.2.4-rc.1') throw Error('Wrong dispatch ref'); s.dispatched=true; }
 else throw Error('Unexpected operation');
 fs.writeFileSync(location,JSON.stringify(s)); return '';
}; require('node:module').syncBuiltinESMExports();
`)
      for (const scenario of ['changed','unchanged','unlabelled','unmerged','fork','conflict','matching']) {
        const payload=structuredClone(event)
        if(scenario==='unlabelled') payload.pull_request.labels=[]
        if(scenario==='unmerged') payload.pull_request.merged=false
        if(scenario==='fork') payload.pull_request.head.repo.full_name='other/fork'
        await writeFile(eventPath,JSON.stringify(payload))
        await writeFile(state,JSON.stringify({before:scenario==='unchanged'?'0.2.4-rc.1':'0.2.3',after:'0.2.4-rc.1',existing:scenario==='conflict'?'d'.repeat(40):scenario==='matching'?commit:null}))
        const run=promisify(execFile)(process.execPath,['--import',pathToFileURL(mock).href,resolve(root,'scripts/tag-desktop.mjs')],{cwd:scratch,env:{...process.env,GITHUB_EVENT_PATH:eventPath,TAG_TEST_STATE:state}})
        if(['unlabelled','unmerged','fork','conflict'].includes(scenario)) await expect(run).rejects.toThrow()
        else await run
        const result=JSON.parse(await readFile(state,'utf8'))
        expect(result.dispatched ?? false,scenario).toBe(['changed','matching'].includes(scenario))
        expect(result.tagged ?? false,scenario).toBe(scenario==='changed')
      }
    } finally { await rm(scratch,{recursive:true,force:true}) }
  })

  it('keeps published verification disabled and read-only', () => {
    expect(published.permissions).toEqual({ contents: 'read' })
    expect(published.jobs['verify']!.if).toContain(
      "github.repository == 'Kosinkadink/Dinkster-Desktop'",
    )
    expect(published.jobs['verify']!.if).toContain('&& false')
  })
})
