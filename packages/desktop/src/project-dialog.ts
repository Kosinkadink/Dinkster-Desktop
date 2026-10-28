import type { DesktopProject, DesktopProjects } from './projects.js'
import type { EnvironmentRequest, EnvironmentResult } from './environment.js'
import type { HardwareDetection, VariantPlan } from './hardware.js'

export interface ProjectDialogBridge {
  list(): Promise<DesktopProjects>
  save(project: DesktopProject): Promise<void>
  remove(projectId: string): Promise<void>
  open(projectId: string, engineId: string): Promise<void>
  inspect(request: EnvironmentRequest): Promise<{ result: EnvironmentResult; hardware: HardwareDetection; plan: VariantPlan }>
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
let hardwarePlan: VariantPlan | undefined
let catalog: EnvironmentResult | undefined

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
  const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button'))
  for (const control of controls) control.disabled = true
  message.textContent = ''
  try { await action() }
  catch (error) { message.textContent = error instanceof Error ? error.message : String(error) }
  finally { for (const control of controls) control.disabled = false }
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
  clearHardware()
}

document.querySelector<HTMLSelectElement>('#local-project')!.addEventListener('change', () => {
  populateLocal(savedProjects.find((project) => project.id === field('local-project')))
})

document.querySelector<HTMLFormElement>('#local')!.addEventListener('input', () => {
  planToken = undefined
  document.querySelector<HTMLElement>('#plan-panel')!.hidden = true
})

function clearHardware(): void {
  planToken = undefined
  document.querySelector<HTMLElement>('#plan-panel')!.hidden = true
  hardwarePlan = undefined
  catalog = undefined
  document.querySelector<HTMLElement>('#detected-gpus')!.textContent = ''
  document.querySelector<HTMLSelectElement>('#local-variant')!.replaceChildren(new Option('Keep current / inspect before installing', ''))
  document.querySelector<HTMLElement>('#hardware-reason')!.textContent = 'Inspect the catalog and assigned GPUs before choosing a variant. CPU is never selected automatically.'
}

for (const id of ['local-root', 'local-channel', 'local-mirrors', 'local-gpus', 'local-project']) {
  document.querySelector(`#${id}`)!.addEventListener('input', clearHardware)
}

function showHardwareReason(override: boolean): void {
  const selected = field('local-variant')
  const choice = hardwarePlan?.choices.find((entry) => entry.variant === selected)
  const bytes = catalog?.variants?.find((entry) => entry.variant === selected)?.downloadBytes
  document.querySelector<HTMLElement>('#hardware-reason')!.textContent = [
    choice ? `${override ? 'Explicit override: ' : ''}${choice.reason}` : hardwarePlan?.reason,
    ...(choice ? hardwarePlan!.choices.filter((entry) => !entry.supported && entry.variant !== selected).map((entry) => `${entry.variant}: ${entry.reason}`) : []),
    bytes === undefined ? '' : `Download: ${bytes.toLocaleString()} bytes (reported by dinkster-env).`,
  ].filter(Boolean).join('\n')
}

document.querySelector<HTMLSelectElement>('#local-variant')!.addEventListener('change', () => showHardwareReason(true))
document.querySelector<HTMLButtonElement>('#inspect-hardware')!.addEventListener('click', () => {
  void perform(async () => {
    clearHardware()
    const result = await bridge.inspect({
      root: field('local-root'), operation: 'catalog', channel: field('local-channel') as 'stable' | 'main',
      mirrors: field('local-mirrors').split('\n').map((mirror) => mirror.trim()).filter(Boolean),
      gpus: field('local-gpus').split(',').map((gpu) => gpu.trim()).filter(Boolean),
    })
    hardwarePlan = result.plan
    catalog = result.result
    const selector = document.querySelector<HTMLSelectElement>('#local-variant')!
    for (const choice of hardwarePlan.choices) selector.add(new Option(`${choice.variant}${choice.supported ? '' : ' (override)'}`, choice.variant))
    selector.value = hardwarePlan.selected ?? ''
    document.querySelector<HTMLElement>('#detected-gpus')!.textContent = [
      ...result.hardware.gpus.map((gpu) => `${gpu.id}: ${gpu.name}; driver ${gpu.driver ?? 'unknown'}; compute ${gpu.computeCapability ?? 'unknown'}`),
      result.hardware.diagnostic,
    ].filter(Boolean).join('\n') || 'No NVIDIA GPUs detected. CPU remains an explicit choice.'
    showHardwareReason(false)
  })
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
      ...(operation === 'setup' ? { mirrors: field('local-mirrors').split('\n').map((mirror) => mirror.trim()).filter(Boolean), port: Number(field('local-port')), engine: field('local-engine') } : {}),
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
