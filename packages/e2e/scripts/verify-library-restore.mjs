import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

// Real Electron IPC and window lifecycle; software transactions are controlled.
const scripts = dirname(fileURLToPath(import.meta.url))
const repo = resolve(scripts, '../../..')
const scratch = await mkdtemp(join(tmpdir(), 'dinkster-library-restore-'))
try {
  for (const scenario of [
    'shared',
    'stopped-source',
    'isolated',
    'document-changed',
    'selection-changed',
    'start-failure',
    'stop-uncertain',
    'document-during-handoff',
    'selection-during-handoff',
    'settings-during-handoff',
    'isolated-document-during-start',
    'isolated-selection-during-start',
    'isolated-settings-during-start',
    'isolated-document-during-load',
  ]) {
    const root = join(scratch, scenario)
    await mkdir(join(root, 'desktop'), { recursive: true })
    await mkdir(join(root, 'source'))
    const servers = []
    let app
    try {
      for (const title of [
        'Original supervisor',
        'Restored supervisor',
        'Isolated supervisor',
      ]) {
        const server = createServer(async (request, response) => {
          if (
            title === 'Isolated supervisor' &&
            scenario === 'isolated-document-during-load' &&
            request.url !== '/favicon.ico' &&
            !request.url.startsWith('/api/')
          )
            await library.reload()
          if (
            title === 'Restored supervisor' &&
            request.url === '/api/nodes?wire=1'
          ) {
            if (scenario === 'document-during-handoff') await library.reload()
            if (scenario === 'selection-during-handoff') {
              const current = JSON.parse(await readFile(statePath, 'utf8'))
              await writeFile(
                statePath,
                JSON.stringify({ ...current, revision: current.revision + 1 }),
              )
            }
            if (scenario === 'settings-during-handoff') {
              const file = join(root, 'desktop/projects.json')
              const saved = JSON.parse(await readFile(file, 'utf8'))
              saved.projects[0].name = 'Changed environment'
              await writeFile(file, JSON.stringify(saved))
            }
          }
          if (
            title === 'Isolated supervisor' &&
            request.url === '/api/nodes?wire=1'
          ) {
            if (scenario === 'isolated-document-during-start')
              await library.reload()
            if (scenario === 'isolated-selection-during-start') {
              const current = JSON.parse(await readFile(statePath, 'utf8'))
              await writeFile(
                statePath,
                JSON.stringify({ ...current, revision: current.revision + 1 }),
              )
            }
            if (scenario === 'isolated-settings-during-start') {
              const file = join(root, 'desktop/projects.json')
              const saved = JSON.parse(await readFile(file, 'utf8'))
              saved.projects.find((project) => project.root !== source).name =
                'Changed destination'
              await writeFile(file, JSON.stringify(saved))
            }
          }
          response.setHeader(
            'Content-Type',
            request.url.startsWith('/api/') ? 'application/json' : 'text/html',
          )
          if (request.url === '/api/nodes?wire=1')
            response.end(
              JSON.stringify({
                dinkster: { services: { name: 'production' } },
              }),
            )
          else if (request.url === '/api/health')
            response.end(
              JSON.stringify({
                ok: true,
                compositionState: { epoch: 1, failed: 0 },
              }),
            )
          else if (request.url === '/api/composition')
            response.end(JSON.stringify({ epoch: 1, packs: {} }))
          else
            response.end(
              `<!doctype html><title>${title}</title><h1>${title}</h1>`,
            )
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        servers.push(server)
      }
      const urls = servers.map(
        (server) => `http://127.0.0.1:${server.address().port}`,
      )
      const source = join(root, 'source'),
        statePath = join(root, 'state.json')
      let state = {
        scenario,
        source,
        urls,
        environments: {
          [source]: { id: 'a'.repeat(32), snapshot: 2, running: false },
        },
        selected: 'a'.repeat(32),
        revision: 2,
      }
      await writeFile(statePath, JSON.stringify(state))
      await writeFile(
        join(root, 'desktop/projects.json'),
        JSON.stringify({
          version: 1,
          projects: [
            {
              id: 'source',
              name: 'Studio',
              channel: 'stable',
              root: source,
              sandboxPacks: false,
              engines: [
                {
                  id: 'main',
                  name: 'Main',
                  kind: 'local',
                  gpus: [],
                  port: servers[0].address().port,
                },
              ],
            },
          ],
        }),
      )
      await writeFile(
        join(source, 'environment.json'),
        JSON.stringify({
          format: 'dinkster.project/1',
          channel: 'stable',
          variant: 'linux-cpu',
          port: servers[0].address().port,
        }),
      )
      const env = Object.fromEntries(
        ['PATH', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]]] : [],
        ),
      )
      Object.assign(env, {
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_CACHE_HOME: join(root, 'cache'),
        DINKSTER_HOME: join(root, 'home'),
        TMPDIR: root,
        DINKSTER_DESKTOP_DATA: join(root, 'desktop'),
        DINKSTER_ENV: join(scripts, 'restore-command.cjs'),
        DINKSTER_RESTORE_FIXTURE: root,
        CUDA_VISIBLE_DEVICES: '',
        DINKSTER_ACCELERATOR: 'cpu',
      })
      app = await electron.launch({
        executablePath: createRequire(
          join(repo, 'packages/desktop/package.json'),
        )('electron'),
        args: [
          '--no-sandbox',
          `--user-data-dir=${join(root, 'chromium')}`,
          join(repo, 'packages/desktop'),
        ],
        env,
      })
      const library = await app.firstWindow()
      await library.waitForFunction(
        () => typeof window.dinksterLibrary?.reviewRestore === 'function',
      )
      await library.evaluate(() =>
        window.dinksterLibrary.open('source', 'film'),
      )
      await expect.poll(() => app.windows().length).toBe(2)
      const engine = app.windows().find((page) => page !== library)
      await expect(engine.locator('h1')).toHaveText('Original supervisor')
      if (scenario === 'stopped-source') {
        state = JSON.parse(await readFile(statePath, 'utf8'))
        state.environments[source].running = false
        await writeFile(statePath, JSON.stringify(state))
      }
      const scope =
        scenario.startsWith('isolated') ||
        ['start-failure', 'stop-uncertain'].includes(scenario)
          ? 'only-project'
          : 'every-project'
      const review = await library.evaluate(
        (scope) =>
          window.dinksterLibrary.reviewRestore('source', 'film', 1, scope),
        scope,
      )
      assert.equal(review.projects.length, scope === 'only-project' ? 1 : 2)
      assert.equal(JSON.stringify(review).includes(root), false)
      if (scenario === 'document-changed') {
        await library.reload()
        await library.waitForFunction(
          () => typeof window.dinksterLibrary?.applyRestore === 'function',
        )
      } else if (scenario === 'selection-changed') {
        state = JSON.parse(await readFile(statePath, 'utf8'))
        state.revision++
        await writeFile(statePath, JSON.stringify(state))
      }
      const apply = await library
        .evaluate(async (token) => {
          try {
            await window.dinksterLibrary.applyRestore(token, 0)
            return { ok: true }
          } catch (error) {
            return { ok: false, error: error.message }
          }
        }, review.token)
        .catch((error) => {
          if (
            ![
              'document-during-handoff',
              'isolated-document-during-start',
              'isolated-document-during-load',
            ].includes(scenario)
          )
            throw error
          assert.match(error.message, /Execution context was destroyed/)
          return { ok: false }
        })
      if (
        [
          'document-during-handoff',
          'isolated-document-during-start',
          'isolated-document-during-load',
        ].includes(scenario)
      ) {
        await library.waitForFunction(
          () => typeof window.dinksterLibrary?.reviewRestore === 'function',
        )
        // A serialized replay waits for the interrupted Apply to finish.
        const replay = await library.evaluate(async (token) => {
          try {
            await window.dinksterLibrary.applyRestore(token, 0)
            return true
          } catch {
            return false
          }
        }, review.token)
        assert.equal(replay, false)
      }
      const after = JSON.parse(await readFile(statePath, 'utf8'))
      if (scope === 'only-project') {
        assert.equal(after.selected, 'b'.repeat(32))
        assert.equal(Object.keys(after.environments).length, 2)
      }
      const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
      if (['document-changed', 'selection-changed'].includes(scenario)) {
        assert.equal(apply.ok, false)
        assert.equal(
          calls.some((args) => args.includes('--approve')),
          false,
        )
        assert.equal(after.environments[source].snapshot, 2)
      } else if (scenario.endsWith('-during-handoff')) {
        assert.equal(apply.ok, false)
        assert.equal(after.environments[source].snapshot, 3)
        await expect(engine.locator('h1')).toHaveText('Original supervisor')
      } else if (scenario === 'stop-uncertain') {
        assert.equal(apply.ok, false)
        assert.equal(after.environments[source].running, false)
        assert.equal(after.environments[source].snapshot, 2)
        assert.equal(
          calls.filter((args) => args[2] === 'start' && args[1] === source)
            .length,
          1,
        )
        assert.equal(
          Object.values(after.environments).filter((value) => value.running)
            .length,
          1,
        )
        await expect(engine.locator('h1')).toHaveText('Original supervisor')
      } else if (
        scenario.endsWith('-during-start') ||
        scenario.endsWith('-during-load') ||
        scenario === 'start-failure'
      ) {
        assert.equal(apply.ok, false)
        assert.equal(after.environments[source].running, true)
        assert.equal(
          Object.values(after.environments).filter((value) => value.running)
            .length,
          1,
        )
        assert.equal(after.environments[source].snapshot, 2)
        assert.equal(app.windows().length, 2)
        await expect(engine.locator('h1')).toHaveText('Original supervisor')
      } else {
        assert.equal(apply.ok, true, JSON.stringify(apply))
        if (scenario === 'shared')
          await expect(engine.locator('h1')).toHaveText('Restored supervisor')
        if (scenario === 'isolated') {
          assert.equal(after.environments[source].running, false)
          assert.equal(after.environments[source].snapshot, 2)
          assert.equal(
            Object.values(after.environments).filter((value) => value.running)
              .length,
            1,
          )
          await expect
            .poll(() =>
              app.windows().some((page) => page !== library && page !== engine),
            )
            .toBe(true)
          const replacement = app
            .windows()
            .find((page) => page !== library && page !== engine)
          await expect(replacement.locator('h1')).toHaveText(
            'Isolated supervisor',
          )
        }
        if (scenario === 'stopped-source') {
          assert.equal(after.environments[source].running, false)
          await expect(engine.locator('h1')).toHaveText('Original supervisor')
          assert.equal(calls.filter((args) => args[2] === 'start').length, 1)
        }
        const replay = await library.evaluate(async (token) => {
          try {
            await window.dinksterLibrary.applyRestore(token, 0)
            return true
          } catch {
            return false
          }
        }, review.token)
        assert.equal(replay, false)
      }
      console.log(`Library software restore: ${scenario} passed`)
    } finally {
      if (app) await app.close()
      await Promise.all(
        servers.map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      )
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
