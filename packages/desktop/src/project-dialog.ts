import type { DesktopProject, DesktopProjects } from './projects.js'
import type { EnvironmentRequest, EnvironmentResult } from './environment.js'

export interface ProjectDialogBridge {
  list(): Promise<DesktopProjects>
  save(project: DesktopProject): Promise<void>
  remove(projectId: string): Promise<void>
  open(projectId: string, engineId: string): Promise<void>
  plan(project: DesktopProject, request: EnvironmentRequest): Promise<{ token?: string; result: EnvironmentResult }>
  apply(token: string): Promise<EnvironmentResult>
}

declare global {
  interface Window { readonly dinksterProjects: ProjectDialogBridge }
}

const bridge = window.dinksterProjects
const message = document.querySelector<HTMLElement>('#message')!
let savedProjects: readonly DesktopProject[] = []
let planToken: string | undefined
let newProjectId = `project-${crypto.randomUUID()}`

function field(id: string): string {
  return document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`)!.value.trim()
}

function localProject(): DesktopProject {
  const channel = field('local-channel')
  if (channel !== 'stable' && channel !== 'main') throw new Error('unsupported channel')
  const existing = savedProjects.find((project) => project.id === field('local-project'))
  const engineId = field('local-engine')
  const engine = { id: engineId, name: engineId, kind: 'local' as const,
    gpus: field('local-gpus').split(',').map((id) => id.trim()).filter(Boolean), port: Number(field('local-port')) }
  return {
    id: existing?.id ?? newProjectId, name: field('local-name'), channel, root: field('local-root'),
    engines: [...(existing?.engines.filter((entry) => entry.id !== engineId) ?? []), engine],
  }
}

function showPlan(result: EnvironmentResult, token?: string): void {
  planToken = token
  document.querySelector<HTMLElement>('#plan-panel')!.hidden = false
  document.querySelector<HTMLElement>('#plan')!.textContent = [result.status, ...result.plan, ...(result.changes ?? [])].join('\n')
  document.querySelector<HTMLButtonElement>('#apply')!.hidden = token === undefined
  document.querySelector<HTMLElement>('#plan-panel')!.scrollIntoView({ block: 'nearest' })
}

async function perform(action: () => Promise<void>): Promise<void> {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  for (const button of buttons) button.disabled = true
  message.textContent = ''
  try { await action() }
  catch (error) { message.textContent = error instanceof Error ? error.message : String(error) }
  finally { for (const button of buttons) button.disabled = false }
}

async function render(): Promise<void> {
  const list = document.querySelector<HTMLElement>('#projects')!
  const projects = await bridge.list()
  savedProjects = projects.projects
  const selector = document.querySelector<HTMLSelectElement>('#local-project')!
  const selection = selector.value
  selector.replaceChildren(new Option('New local project', ''))
  for (const project of savedProjects.filter((candidate) => candidate.root)) selector.add(new Option(project.name, project.id))
  selector.value = selection
  list.replaceChildren()
  if (projects.projects.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No projects yet. Connect a server to get started.'
    list.append(empty)
  }
  for (const project of projects.projects) {
    const card = document.createElement('article')
    const title = document.createElement('h2')
    title.textContent = project.name
    card.append(title)
    const channel = document.createElement('p')
    channel.textContent = `Channel: ${project.channel}`
    card.append(channel)
    for (const engine of project.engines) {
      const address = document.createElement('p')
      address.className = 'endpoint'
      address.textContent = engine.kind === 'remote' ? engine.url : project.root ?? ''
      const button = document.createElement('button')
      button.textContent = `Open ${engine.name}`
      button.addEventListener('click', () => { void perform(async () => { await bridge.open(project.id, engine.id) }) })
      card.append(address, button)
      if (engine.kind === 'local') {
        const manage = document.createElement('button')
        manage.textContent = `Manage ${engine.name}`
        manage.addEventListener('click', () => {
          selector.value = project.id
          populateLocal(project, engine.id)
          document.querySelector<HTMLDetailsElement>('#local-settings')!.open = true
          document.querySelector<HTMLElement>('#local-settings')!.scrollIntoView({ block: 'start' })
        })
        card.append(manage)
      }
    }
    const actions = document.createElement('div')
    actions.className = 'actions'
    const remove = document.createElement('button')
    remove.textContent = 'Remove binding'
    remove.addEventListener('click', () => { void perform(async () => { await bridge.remove(project.id); await render() }) })
    actions.append(remove)
    card.append(actions)
    list.append(card)
  }
}

document.querySelector<HTMLFormElement>('#create')!.addEventListener('submit', (event) => {
  event.preventDefault()
  void perform(async () => {
    const name = document.querySelector<HTMLInputElement>('#name')!.value.trim()
    const url = document.querySelector<HTMLInputElement>('#url')!.value.trim()
    const channel = document.querySelector<HTMLSelectElement>('#channel')!.value
    if (channel !== 'stable' && channel !== 'main') throw new Error('unsupported channel')
    await bridge.save({
      id: `project-${crypto.randomUUID()}`,
      name, channel,
      engines: [{ id: 'remote', name: 'Remote engine', kind: 'remote', url }],
    })
    await render()
    message.textContent = 'Project saved. Open the engine to start working.'
  })
})

function populateLocal(project: DesktopProject | undefined, engineId?: string): void {
  planToken = undefined
  document.querySelector<HTMLElement>('#plan-panel')!.hidden = true
  const engine = project?.engines.find((entry) => entry.kind === 'local' && (!engineId || entry.id === engineId))
  for (const [id, value] of Object.entries({
    'local-name': project?.name ?? '', 'local-root': project?.root ?? '', 'local-channel': project?.channel ?? 'stable',
    'local-engine': engine?.id ?? 'main', 'local-gpus': engine?.kind === 'local' ? engine.gpus.join(',') : '',
    'local-port': String(engine?.kind === 'local' ? engine.port ?? 3639 : 3639),
    'local-operation': project ? 'update' : 'setup',
  })) document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value = value
}

document.querySelector<HTMLSelectElement>('#local-project')!.addEventListener('change', () => {
  populateLocal(savedProjects.find((project) => project.id === field('local-project')))
})

document.querySelector<HTMLFormElement>('#local')!.addEventListener('input', () => {
  planToken = undefined
  document.querySelector<HTMLElement>('#plan-panel')!.hidden = true
})

document.querySelector<HTMLFormElement>('#local')!.addEventListener('submit', (event) => {
  event.preventDefault()
  void perform(async () => {
    const project = localProject()
    const operation = field('local-operation') as EnvironmentRequest['operation']
    if (operation === 'setup' && !field('local-variant')) throw new Error('Choose an explicit variant before installation. CPU is not selected automatically.')
    const request: EnvironmentRequest = {
      root: project.root!, operation,
      ...(['setup', 'update'].includes(operation) ? { channel: project.channel, ...(field('local-variant') ? { variant: field('local-variant') } : {}) } : {}),
      ...(operation === 'setup' ? { mirrors: field('local-mirrors').split('\n').map((mirror) => mirror.trim()).filter(Boolean), port: Number(field('local-port')) } : {}),
      ...(['setup', 'move'].includes(operation) && field('local-data') ? { data: field('local-data') } : {}),
      ...(operation === 'move' ? { destination: field('local-destination') } : {}),
    }
    const planned = await bridge.plan(project, request)
    showPlan(planned.result, planned.token)
  })
})

document.querySelector<HTMLButtonElement>('#bind-local')!.addEventListener('click', () => {
  void perform(async () => {
    const project = localProject()
    await bridge.save(project)
    await render()
    document.querySelector<HTMLSelectElement>('#local-project')!.value = project.id
    newProjectId = `project-${crypto.randomUUID()}`
    message.textContent = 'Binding saved. Opening it starts the existing generation without installing packages.'
  })
})

document.querySelector<HTMLButtonElement>('#apply')!.addEventListener('click', () => {
  void perform(async () => {
    if (!planToken) throw new Error('Review an environment plan first')
    const token = planToken
    planToken = undefined
    document.querySelector<HTMLButtonElement>('#apply')!.hidden = true
    const result = await bridge.apply(token)
    showPlan(result)
    await render()
    newProjectId = `project-${crypto.randomUUID()}`
    message.textContent = 'Environment operation completed. Open the engine to start working.'
  })
})

document.querySelector<HTMLButtonElement>('#cancel-plan')!.addEventListener('click', () => {
  planToken = undefined
  document.querySelector<HTMLElement>('#plan-panel')!.hidden = true
})

void perform(render)
