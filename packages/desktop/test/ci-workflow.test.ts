import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const yaml = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): unknown
}
interface Step {
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
  strategy?: {
    'fail-fast': boolean
    matrix: string
  }
  steps?: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency?: Record<string, string>
  env?: Record<string, string>
  jobs: Record<string, Job>
}
const load = async (name: string): Promise<Workflow> =>
  yaml.load(
    await readFile(resolve(root, '.github/workflows', name), 'utf8'),
  ) as Workflow
const fast = await load('ci.yml')
const full = await load('full-validation.yml')
const release = await load('release-desktop.yml')
const script = await readFile(resolve(root, 'scripts/ci-fast.mjs'), 'utf8')
const appMain = await readFile(
  resolve(root, 'packages/app/src/main.tsx'),
  'utf8',
)
const hostedConfig = await readFile(
  resolve(root, 'packages/e2e/playwright.hosted.config.ts'),
  'utf8',
)
const extensionContractConfig = await readFile(
  resolve(root, 'packages/e2e/playwright.extension-contract.config.ts'),
  'utf8',
)
const baseConfig = await readFile(
  resolve(root, 'packages/e2e/playwright.config.ts'),
  'utf8',
)
const auditConfig = await readFile(
  resolve(root, 'packages/e2e/playwright.audit-assets.config.ts'),
  'utf8',
)
const testingDocs = (
  await readFile(resolve(root, 'docs/testing.md'), 'utf8')
).replace(/\r?\n/g, ' ')

describe('fast pull-request and full validation workflows', () => {
  it('pins both workflows to the same backend commit', () => {
    expect(fast.env?.['DINKSTER_REF']).toMatch(/^[0-9a-f]{40}$/)
    expect(full.env?.['DINKSTER_REF']).toBe(fast.env?.['DINKSTER_REF'])
  })

  it('runs exactly one bounded job without a PR label path', () => {
    expect(fast.on).toEqual({ pull_request: null, workflow_dispatch: null })
    expect(fast.concurrency).toEqual({
      group: 'ci-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    })
    expect(Object.keys(fast.jobs)).toEqual(['fast'])
    const job = fast.jobs['fast']!
    expect(job['timeout-minutes']).toBe(5)
    expect(job['runs-on']).toBe(
      '${{ fromJSON(vars.DINKSTER_PR_RUNNER || \'["self-hosted", "linux", "x64"]\') }}',
    )
    expect(job.steps!.flatMap((step) => step.run ?? [])).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm ci:fast',
    ])
    expect(job.steps!.flatMap((step) => step.uses ?? [])).toEqual([
      'actions/checkout@v4',
      './.github/actions/configure-dinkster-identity',
      'actions/checkout@v4',
      'actions/setup-python@v5',
      'pnpm/action-setup@v4',
      'actions/setup-node@v4',
    ])
    expect(script).toContain('gen_extension_contribution_kinds.py')
    expect(script).toContain("['check:ui-strings']")
    expect(script).toContain("['typecheck']")
    expect(script).toContain("'prettier'")
    expect(script).toContain("'--check'")
    expect(script.match(/(?<!\/)test\/[\w.-]+\.test\.ts/g)).toEqual([
      'test/format.schema.test.ts',
      'test/dinkster-graph.test.ts',
      'test/dinkster-inline-value.test.ts',
      'test/ci-workflow.test.ts',
      'test/published-verification.test.ts',
      'test/extension-dogfooding.test.ts',
    ])
    expect(script).not.toMatch(
      /playwright|pnpm test|build|prepare:engine|verify:installed/,
    )
  })

  it('runs every heavy lane through one guarded reusable workflow', async () => {
    expect(full.on).toEqual({
      push: { branches: ['main'] },
      schedule: [
        { cron: '0 6-22/2 * * *', timezone: 'America/Los_Angeles' },
        { cron: '43 10 * * *' },
      ],
      workflow_dispatch: null,
      workflow_call: null,
    })
    expect(full.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(full.concurrency).toEqual({
      group:
        "ci-${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'push' && 'push' || 'durable' }}",
      'cancel-in-progress': false,
    })
    expect(Object.keys(full.jobs)).toEqual([
      'validation-plan',
      'fast',
      'ci',
      'e2e-suite',
      'e2e',
    ])
    const plan = full.jobs['validation-plan']!
    expect(plan.outputs).toEqual({
      'run-heavy': '${{ steps.plan.outputs.run-heavy }}',
      'e2e-matrix': '${{ steps.plan.outputs.e2e-matrix }}',
    })
    const planScript = plan.steps![0]!.with!['script'] as string
    expect(
      planScript.match(/^\s+\{ name: .+ \},$/gm)?.map((entry) => entry.trim()),
    ).toEqual([
      "{ name: 'parallel 1/4', project: 'parallel-safe', shard: '--shard=1/4' },",
      "{ name: 'parallel 2/4', project: 'parallel-safe', shard: '--shard=2/4' },",
      "{ name: 'parallel 3/4', project: 'parallel-safe', shard: '--shard=3/4' },",
      "{ name: 'parallel 4/4', project: 'parallel-safe', shard: '--shard=4/4', push: true },",
      "{ name: 'backend serial 1/2', project: 'backend-serial', shard: '--shard=1/2', vulkan: true, push: true },",
      "{ name: 'backend serial 2/2', project: 'backend-serial', shard: '--shard=2/2' },",
      "{ name: 'performance', project: 'performance', shard: '' },",
    ])
    for (const required of [
      "context.eventName !== 'schedule'",
      "workflow_id: 'full-validation.yml'",
      "branch: 'main'",
      "status: 'success'",
      'per_page: 100',
      "workflow_runs.find((run) => run.event !== 'push')",
      'latestDurable?.head_sha === context.sha',
      "context.eventName === 'push'",
      'fullMatrix.filter((entry) => entry.push)',
      "core.setOutput('e2e-matrix', JSON.stringify({ include: selected }))",
    ])
      expect(planScript).toContain(required)
    const executePlan = async (
      eventName: string,
      runs: { event: string; head_sha: string }[],
    ) => {
      const outputs: Record<string, string> = {}
      let requests = 0
      const execute = new Function(
        'context',
        'core',
        'github',
        `return (async () => { ${planScript} })()`,
      ) as (
        context: {
          eventName: string
          repo: Record<string, string>
          sha: string
        },
        core: { setOutput(name: string, value: string): void },
        github: {
          rest: {
            actions: {
              listWorkflowRuns(): Promise<{
                data: { workflow_runs: { event: string; head_sha: string }[] }
              }>
            }
          }
        },
      ) => Promise<void>
      await execute(
        {
          eventName,
          repo: { owner: 'Kosinkadink', repo: 'Dinkster-Frontend' },
          sha: 'head',
        },
        { setOutput: (name, value) => (outputs[name] = value) },
        {
          rest: {
            actions: {
              listWorkflowRuns: async () => {
                requests += 1
                return { data: { workflow_runs: runs } }
              },
            },
          },
        },
      )
      return { outputs, requests }
    }
    const pushPlan = await executePlan('push', [])
    expect(pushPlan.requests).toBe(0)
    expect(JSON.parse(pushPlan.outputs['e2e-matrix']!).include).toHaveLength(2)
    expect(pushPlan.outputs['run-heavy']).toBe('true')
    const durablePlan = await executePlan('schedule', [
      { event: 'push', head_sha: 'head' },
      { event: 'workflow_dispatch', head_sha: 'head' },
    ])
    expect(durablePlan.requests).toBe(1)
    expect(durablePlan.outputs['run-heavy']).toBe('false')
    expect(JSON.parse(durablePlan.outputs['e2e-matrix']!).include).toHaveLength(
      7,
    )
    expect(
      (await executePlan('schedule', [{ event: 'push', head_sha: 'head' }]))
        .outputs['run-heavy'],
    ).toBe('true')
    expect(full.jobs['fast']!.needs).toBe('validation-plan')
    expect(full.jobs['fast']!.if).toBe(
      "needs.validation-plan.outputs.run-heavy == 'true' && github.event_name == 'push'",
    )
    expect(full.jobs['fast']!.steps).toEqual(fast.jobs['fast']!.steps)
    expect(full.jobs['ci']!.needs).toBe('validation-plan')
    expect(full.jobs['ci']!.if).toBe(
      "needs.validation-plan.outputs.run-heavy == 'true' && github.event_name != 'push'",
    )
    expect(full.jobs['e2e-suite']!.needs).toBe('validation-plan')
    expect(full.jobs['e2e-suite']!.if).toBe(
      "needs.validation-plan.outputs.run-heavy == 'true'",
    )
    expect(testingDocs).toContain(
      '`on.schedule` cron list in that file is the single schedule definition',
    )
    expect(testingDocs).toContain(
      'one active push run and only the newest pending push run',
    )
    expect(testingDocs).toContain('git merge-base --is-ancestor')
    expect(full.jobs['e2e-suite']!.strategy).toEqual({
      'fail-fast': false,
      matrix: '${{ fromJSON(needs.validation-plan.outputs.e2e-matrix) }}',
    })
    expect(full.jobs['e2e']!.if).toBe(
      "always() && needs.validation-plan.outputs.run-heavy == 'true'",
    )
    expect(full.jobs['e2e']!.needs).toEqual(['validation-plan', 'e2e-suite'])
    for (const job of Object.values(full.jobs))
      expect(job['runs-on']).toEqual(['self-hosted', 'linux', 'x64'])
    expect(full.jobs['e2e']!.steps).toEqual([
      {
        name: 'Verify every full-suite lane passed',
        run: "test '${{ needs.e2e-suite.result }}' = success",
      },
    ])
  })

  it('retains clean checkouts, ref selection, read-only credentials and isolated browser ports', () => {
    for (const workflow of [fast, full]) {
      expect(workflow.permissions['contents']).toBe('read')
      for (const job of Object.values(workflow.jobs)) {
        for (const step of (job.steps ?? []).filter(
          (step) => step.uses === 'actions/checkout@v4',
        )) {
          expect(step.with).toMatchObject({
            clean: true,
            'persist-credentials': false,
          })
          expect(step.with).not.toHaveProperty('ssh-key')
          if (!step.with?.['repository'])
            expect(step.with).not.toHaveProperty('ref')
        }
      }
    }
    for (const name of ['ci', 'e2e-suite']) {
      const steps = full.jobs[name]!.steps!
      expect(
        steps.filter(
          (step) =>
            step.uses === './.github/actions/configure-dinkster-identity',
        ),
      ).toHaveLength(2)
      const browser = steps.find((step) =>
        step.run?.includes('playwright test'),
      )!
      expect(browser.run).toContain('bash scripts/ci-browser.sh')
      expect(browser.env?.['DINKSTER_E2E_PORT']).toBe(
        name === 'ci' ? '15376' : '15410',
      )
      if (name === 'ci') {
        expect(browser.env).toMatchObject({
          DINKSTER_E2E_NATIVE_PORT: '15377',
          DINKSTER_E2E_DINKSTER_ROOT: '${{ github.workspace }}/.ci/Dinkster',
        })
        expect(
          steps.some((step) =>
            step.run?.includes(
              'dinkster-pack --accelerator cpu prepare-catalogs',
            ),
          ),
        ).toBe(true)
      }
      if (name === 'e2e-suite') {
        expect(browser.run).toContain('run_counted_suite.sh')
        expect(browser.env).toMatchObject({
          DINKSTER_E2E_COMFY_PORT: '15411',
          DINKSTER_E2E_NATIVE_PORT: '15412',
          DINKSTER_NATIVE_BACKEND: 'http://127.0.0.1:15412',
        })
        const compatibilityInstall = steps.find(
          (step) => step.name === 'Install hosted compatibility dependencies',
        )!
        expect(compatibilityInstall.run).toContain(
          'uv export --project .ci/Dinkster --locked --package dinkster-inference-torch --extra torch',
        )
        expect(compatibilityInstall.run).toContain(
          'uv pip install --python .ci/ComfyUI/venv/bin/python',
        )
        expect(compatibilityInstall.run).toContain(
          '--index https://download.pytorch.org/whl/cpu',
        )
        expect(compatibilityInstall.run).toContain(
          '--constraint "${RUNNER_TEMP}/dinkster-torch-constraints.txt"',
        )
        expect(compatibilityInstall.run).toContain(
          'dinkster-kitchen dinkster-aimdo sentencepiece tokenizers',
        )
        const extensionProof = steps.find(
          (step) =>
            step.name === 'Prove the ordinary third-party pack contract',
        )!
        expect(extensionProof.if).toBe("matrix.name == 'backend serial 1/2'")
        expect(extensionProof.run).toContain(
          'playwright.extension-contract.config.ts',
        )
        expect(extensionProof.env).toEqual({
          DINKSTER_E2E_DINKSTER_ROOT: '${{ github.workspace }}/.ci/Dinkster',
          DINKSTER_E2E_PORT: '15420',
          DINKSTER_E2E_NATIVE_PORT: '15421',
        })
      }
    }
    expect(appMain).toContain(
      "probeV1: import.meta.env['VITE_DINKSTER_E2E_PROBE_V1'] === '1'",
    )
    expect(baseConfig).toContain("VITE_DINKSTER_E2E_PROBE_V1: '1'")
    expect(baseConfig).toContain("VITE_DINKSTER_E2E_PROBE_V1: '0'")
    expect(hostedConfig).toContain("VITE_DINKSTER_E2E_PROBE_V1: '1'")
    expect(hostedConfig).toContain("VITE_DINKSTER_E2E_PROBE_V1: '0'")
    expect(extensionContractConfig).toContain("'--no-default-packs'")
    expect(extensionContractConfig).toContain(
      "'tests/fixtures/extension-contract-pack/dinkster-pack.toml'",
    )
    expect(hostedConfig).toContain(
      "'packages/dinkster-nodes-dev/dinkster-pack.toml'",
    )
    expect(hostedConfig).not.toContain("'--dev'")
    expect(auditConfig).toContain(
      "requiredDirectory('DINKSTER_E2E_DINKSTER_ROOT')",
    )
    expect(auditConfig).toContain("globalSetup: './hosted-global-setup.ts'")
    expect(auditConfig).toContain("VITE_DINKSTER_E2E_PROBE_V1: '1'")
    expect(auditConfig).toContain(
      "'packages/dinkster-nodes-dev/dinkster-pack.toml'",
    )
    expect(auditConfig).not.toContain("'--dev'")
  })

  it('validates the exact desktop release commit before publication', () => {
    expect(release.jobs['validation']).toEqual({
      if: "github.repository == 'Kosinkadink/Dinkster-Frontend' && github.event.repository.private == true && github.ref == 'refs/heads/main'",
      uses: './.github/workflows/full-validation.yml',
      secrets: 'inherit',
    })
    expect(release.jobs['release']!.needs).toBe('validation')
    expect(release.jobs['release']!.if).toBe(release.jobs['validation']!.if)
    expect(release.jobs['release']!.steps).toBeDefined()
  })
})
