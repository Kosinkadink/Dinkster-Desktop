import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const yaml = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): unknown
}
interface Step {
  id?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
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

  it('runs complete Linux, browser, and Windows lanes on main', () => {
    expect(full.on).toMatchObject({
      push: { branches: ['main'] },
      workflow_dispatch: null,
      workflow_call: null,
    })
    expect(Object.keys(full.jobs)).toEqual([
      'linux',
      'frontend-e2e',
      'windows-package',
      'main-status',
    ])
    expect(full.jobs['linux']!['runs-on']).toBe(
      '${{ fromJSON(vars.CI_RUNNERS).linux }}',
    )
    expect(full.jobs['frontend-e2e']!['runs-on']).toBe(
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
    const browserCommands = full.jobs['frontend-e2e']!.steps?.flatMap(
      (step) => step.run ?? [],
    )
    expect(browserCommands).toContain(
      'pnpm --filter @dinkster/e2e exec playwright test --config=playwright.audit-assets.config.ts',
    )
  })

  it('uses one required variable for every hosted-eligible job', () => {
    for (const workflow of [ci, full, release, published]) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (job.uses) continue
        expect(job['runs-on'], name).toMatch(
          /^\$\{\{ fromJSON\(vars\.CI_RUNNERS\)\.(linux|windows) \}\}$/,
        )
      }
    }
  })

  it('publishes one aggregate status that fails for every incomplete lane', () => {
    const status = full.jobs['main-status']!
    expect(status.if).toBe('always()')
    expect(status.needs).toEqual([
      'linux',
      'frontend-e2e',
      'windows-package',
    ])
    const source = status.steps?.flatMap((step) => step.run ?? []).join('\n')
    expect(source).toContain('main-validation-status.json')
    expect(source).toContain('test "$LINUX_RESULT" = success')
    expect(source).toContain('test "$E2E_RESULT" = success')
    expect(source).toContain('test "$WINDOWS_RESULT" = success')
  })

  it('uses clean checkouts without persisting credentials', () => {
    for (const workflow of [ci, full, release, published]) {
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

  it('downloads public release inputs with the workflow token', () => {
    for (const workflow of [full, release, published]) {
      const downloadSteps = Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).filter(
          (step) =>
            step.run?.includes('DownloadBackend') ||
            step.run?.includes('gh release download'),
        ),
      )
      expect(downloadSteps.length).toBeGreaterThan(0)
      for (const step of downloadSteps) {
        expect(step.env?.['GH_TOKEN']).toBe('${{ github.token }}')
        expect(step.run).not.toContain('DINKSTER_RELEASE_READ_TOKEN')
      }
    }
    expect(JSON.stringify([full, release, published])).not.toContain(
      'DINKSTER_RELEASE_READ_TOKEN',
    )
  })

  it('validates the exact Desktop main commit before publication', () => {
    expect(release.jobs['validation']).toEqual({
      if: "github.repository == 'Kosinkadink/Dinkster-Desktop' && github.ref == 'refs/heads/main'",
      uses: './.github/workflows/full-validation.yml',
    })
    expect(release.jobs['release']!.needs).toBe('validation')
    expect(release.jobs['release']!.if).toBe(release.jobs['validation']!.if)
    expect(release.jobs['release']!.steps).toBeDefined()
  })

  it('keeps published verification disabled and read-only', () => {
    expect(published.permissions).toEqual({ contents: 'read' })
    expect(published.jobs['verify']!.if).toContain(
      "github.repository == 'Kosinkadink/Dinkster-Desktop'",
    )
    expect(published.jobs['verify']!.if).toContain('&& false')
  })
})
