#!/usr/bin/env node
// Controlled supervisor boundary for the Electron restore scenarios.
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const directory = process.env.DINKSTER_RESTORE_FIXTURE
const statePath = path.join(directory, 'state.json')
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
fs.appendFileSync(
  path.join(directory, 'calls.jsonl'),
  JSON.stringify(args) + '\n',
)
const root = args[1],
  operation = args[2]
const environment = state.environments[root] ?? {
  id: 'b'.repeat(32),
  snapshot: 1,
  running: false,
}
const project = {
  id: 'film',
  uid: 'film-global',
  name: 'Film',
  revision: state.revision,
  deleted: false,
  environment: { id: state.selected, lastSnapshot: null, lastRunAt: null },
}
const result = {
  format: 'dinkster.environment-result/1',
  operation,
  root,
  current: environment.snapshot,
  status: 'clean',
  plan: [],
}
const engine = () => ({
  name: 'main',
  generation: environment.snapshot,
  state: environment.running ? 'ready' : 'stopped',
  url:
    root === state.source
      ? state.urls[environment.snapshot === 2 ? 0 : 1]
      : state.urls[2],
  gpus: [],
})
if (operation === 'status') result.engines = [engine()]
else if (operation === 'library-list') {
  const kind = args[3]
  result.library = {
    kind,
    cursor: null,
    ...(kind === 'projects'
      ? { items: [{ id: project.id, name: project.name }] }
      : kind === 'workflows'
        ? { records: [] }
        : { assets: [] }),
  }
} else if (operation === 'history') {
  result.history = [
    {
      format: 'dinkster.install-history/1',
      id: 1,
      generation: 7,
      timestamp: '2026-11-22T22:00:00Z',
      reason: 'update',
      exact: true,
      snapshot: {
        engine: { version: '1.0', release: 'recorded-release' },
        base: { id: 'cpu', variant: 'cpu' },
      },
    },
  ]
} else if (operation === 'project-get' || operation === 'project-check') {
  result.project = project
  result.environment = {
    id: environment.id,
    snapshot: String(environment.snapshot),
  }
} else if (operation === 'restore' || operation === 'fork') {
  const fork = operation === 'fork',
    destination = fork ? args[4] : undefined
  const before = {
    ...project,
    revision: Number(args[args.indexOf('--revision') + 1]),
    environment: { ...project.environment, id: 'a'.repeat(32) },
  }
  const sibling = {
    ...before,
    id: 'sibling',
    uid: 'sibling-global',
    name: 'Sibling',
  }
  const approval = 'sha256:' + 'c'.repeat(64)
  result.restorePlan = {
    format: 'dinkster.restore-plan/1',
    entry: 1,
    exact: true,
    missing: [],
    scope: args[args.indexOf('--scope') + 1],
    projectReview: {
      library: 'private-library',
      environment: 'a'.repeat(32),
      project: before,
      projects: [before, sibling].map((project) => ({ project, needs: {} })),
    },
    alternatives: [
      {
        approval,
        snapshot: {
          engine: { version: '1.0', release: 'recorded-release' },
          base: { id: 'cpu', variant: 'cpu' },
        },
        substitutions: [],
      },
      {
        approval: 'sha256:' + 'd'.repeat(64),
        snapshot: {
          engine: { version: '1.1', release: 'c'.repeat(64) },
          base: { id: 'cpu', variant: 'cpu' },
        },
        substitutions: [
          {
            field: 'engine',
            before: { version: '1.0', release: 'recorded-release' },
            after: { version: '1.1', release: 'c'.repeat(64) },
          },
        ],
      },
    ],
    ...(fork ? { fork: { source: root, destination } } : {}),
  }
  result.restoredFrom = 1
  result.status = 'approval-required'
  if (fork) {
    result.destination = destination
    result.current = null
  }
  if (args.includes('--approve')) {
    if (
      args[args.indexOf('--approve') + 1] !==
      (state.interactive ? 'sha256:' + 'd'.repeat(64) : approval)
    )
      throw new Error('wrong approval')
    if (fork) {
      const saved = JSON.parse(
        fs.readFileSync(path.join(directory, 'desktop/projects.json'), 'utf8'),
      )
      if (!saved.projects.some((row) => row.root === destination))
        throw new Error('unsaved destination')
      fs.mkdirSync(destination)
      state.environments[destination] = {
        id: 'b'.repeat(32),
        snapshot: 1,
        running: false,
      }
      state.selected = 'b'.repeat(32)
      state.revision++
      result.current = 1
      result.engines = []
      result.project = {
        ...project,
        revision: state.revision,
        environment: { ...project.environment, id: state.selected },
      }
      result.environment = { id: state.selected, snapshot: '1' }
    } else {
      environment.snapshot = 3
      result.current = 3
      result.engines = [engine()]
    }
    result.status = 'applied'
    fs.writeFileSync(statePath, JSON.stringify(state))
  }
} else if (operation === 'start' || operation === 'stop') {
  if (
    operation === 'start' &&
    Object.entries(state.environments).some(
      ([other, value]) => other !== root && value.running,
    )
  )
    throw new Error('two environments would run')
  environment.running = operation === 'start'
  state.environments[root] = environment
  result.status = 'applied'
  if (
    operation === 'start' &&
    root !== state.source &&
    ['start-failure', 'stop-uncertain'].includes(state.scenario)
  ) {
    result.status = 'error'
    result.error = 'replacement startup failed'
  }
  if (
    operation === 'stop' &&
    root !== state.source &&
    state.scenario === 'stop-uncertain'
  ) {
    environment.running = true
    result.status = 'error'
    result.error = 'replacement stop could not be confirmed'
  }
  result.engines = [engine()]
  fs.writeFileSync(statePath, JSON.stringify(state))
} else throw new Error('unexpected operation ' + operation)
console.log(JSON.stringify(result))
