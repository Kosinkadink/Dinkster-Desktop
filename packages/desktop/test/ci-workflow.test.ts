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
const build = await load('build-desktop.yml')
const release = await load('release-desktop.yml')
const published = await load('verify-published-desktop.yml')
const releaseSource = await readFile(
  resolve(root, '.github/workflows/release-desktop.yml'),
  'utf8',
)

describe('desktop workflows', () => {
  it('pins pull-request and release builds to the same frontend commit', () => {
    expect(ci.env?.['DINKSTER_FRONTEND_REF']).toMatch(/^[0-9a-f]{40}$/)
    expect(release.env?.['DINKSTER_FRONTEND_REF']).toBe(
      ci.env?.['DINKSTER_FRONTEND_REF'],
    )
  })

  it('builds the exact native Windows control runtime without legacy engine inputs', () => {
    expect(release.env).toMatchObject({
      DINKSTER_REF: 'c4d9e9375bb8ff52cb3480666c208856fea22477',
      DINKSTER_CONTROL_RUNTIME_DESCRIPTOR_SHA256: '41be0dc1ffd778bd18b95bb0d91208b5eec38e04d5957cde56f94107915cb9ce',
      DINKSTER_CONTROL_RUNTIME_ARCHIVE_SHA256: '77d6875fa3cd5790beb67cd2a36e2f96823274603530ce488294001ebe1deea8',
      DINKSTER_CONTROL_RUNTIME_ARCHIVE_SIZE: '24812249',
    })
    const checkout = release.jobs['release']!.steps?.find(
      (step) => step.with?.['repository'] === 'Kosinkadink/Dinkster',
    )
    expect(checkout?.with).toMatchObject({
      ref: '${{ env.DINKSTER_REF }}',
      path: '.dinkster',
      token: '${{ secrets.DINKSTER_RELEASE_READ_TOKEN }}',
      'persist-credentials': false,
    })
    const build = release.jobs['release']!.steps?.find((step) =>
      step.run?.includes('scripts/build_engine_feed.py'))
    expect(build?.run).toContain('--cells win-cu128 --control-runtime')
    expect(build?.run).toContain('DINKSTER_CONTROL_RUNTIME_DESCRIPTOR=')
    expect(build?.run).toContain('DINKSTER_CONTROL_RUNTIME_ARCHIVE=')
    expect(releaseSource).not.toMatch(/DINKSTER_ENGINE_ARCHIVE|DINKSTER_AIMDO_WHEEL|resources\/engine/)
  })

  it('runs typecheck, all unit tests, and a Linux build on pull requests', () => {
    expect(ci.on).toMatchObject({ pull_request: null })
    expect(ci.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(ci.jobs)).toEqual(['frontend-access', 'test'])
    const access = ci.jobs['frontend-access']!
    expect(access['timeout-minutes']).toBe(2)
    expect(access['runs-on']).toBe(
      '${{ fromJSON(vars.DINKSTER_PR_RUNNER || \'["self-hosted", "linux", "x64"]\') }}',
    )
    expect(access.outputs).toEqual({
      available: '${{ steps.availability.outputs.available }}',
    })
    expect(access.steps).toEqual([
      {
        id: 'availability',
        env: {
          FRONTEND_READ_TOKEN:
            '${{ secrets.DINKSTER_FRONTEND_READ_TOKEN }}',
        },
        run: 'if [ -n "$FRONTEND_READ_TOKEN" ]; then\n  echo "available=true" >> "$GITHUB_OUTPUT"\nelse\n  echo "available=false" >> "$GITHUB_OUTPUT"\nfi\n',
      },
    ])
    const job = ci.jobs['test']!
    expect(job.needs).toBe('frontend-access')
    expect(job.if).toBe(
      "needs.frontend-access.outputs.available == 'true'",
    )
    expect(job['timeout-minutes']).toBe(10)
    expect(job['runs-on']).toBe(
      '${{ fromJSON(vars.DINKSTER_PR_RUNNER || \'["self-hosted", "linux", "x64"]\') }}',
    )
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
      token: '${{ secrets.DINKSTER_FRONTEND_READ_TOKEN }}',
    })
  })

  it('uses clean checkouts without persisting credentials', () => {
    for (const workflow of [ci, build, release, published]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of (job.steps ?? []).filter(
          (entry) => entry.uses === 'actions/checkout@v4',
        )) {
          expect(step.with).toMatchObject({
            clean: true,
            'persist-credentials': false,
          })
          expect(step.with).not.toHaveProperty('ssh-key')
        }
      }
    }
  })

  it('builds and verifies Windows and Linux installers on main pushes while macOS is guarded', () => {
    expect(build.on).toEqual({ push: { branches: ['main'] }, workflow_dispatch: null })
    expect(build.permissions).toEqual({ contents: 'read' })
    expect(build.env).toEqual({
      DINKSTER_FRONTEND_REF: ci.env?.['DINKSTER_FRONTEND_REF'],
      DINKSTER_REF: 'c4d9e9375bb8ff52cb3480666c208856fea22477',
    })
    expect(Object.keys(build.jobs)).toEqual(['signing-availability', 'windows', 'linux', 'macos'])
    const windows = build.jobs['windows']!
    const linux = build.jobs['linux']!
    expect(windows['runs-on']).toEqual(['self-hosted', 'windows', 'x64'])
    expect(linux['runs-on']).toEqual(['self-hosted', 'linux', 'x64'])
    expect(windows.steps?.some((step) => step.run === 'pnpm --filter @dinkster/desktop package:win')).toBe(true)
    expect(linux.steps?.some((step) => step.run === 'pnpm --filter @dinkster/desktop package:linux')).toBe(true)
    for (const job of [windows, linux]) {
      expect(job.steps?.some((step) => step.run === 'pnpm --filter @dinkster/desktop verify:update-feed')).toBe(true)
      expect(job.steps?.some((step) => step.run === 'pnpm --filter @dinkster/desktop verify:installed')).toBe(true)
      const upload = job.steps?.find((step) => step.uses === 'actions/upload-artifact@v4')
      expect(upload?.with?.['path']).toMatch(/latest(?:-linux)?\.yml/)
    }
    const signing = build.jobs['signing-availability']!
    expect(signing.outputs).toEqual({ macos: '${{ steps.macos.outputs.available }}' })
    expect(build.jobs['macos']!.needs).toBe('signing-availability')
    expect(build.jobs['macos']!.if).toBe("needs.signing-availability.outputs.macos == 'true' && false")
  })

  it('validates the exact private Desktop main commit before publication', () => {
    expect(release.jobs['validation']).toEqual({
      if: "github.repository == 'Kosinkadink/Dinkster-Desktop' && github.event.repository.private == true && github.ref == 'refs/heads/main'",
      uses: './.github/workflows/ci.yml',
      secrets: 'inherit',
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
