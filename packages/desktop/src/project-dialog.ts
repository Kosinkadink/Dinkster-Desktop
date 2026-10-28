import type { DesktopProject, DesktopProjects } from './projects.js'

export interface ProjectDialogBridge {
  list(): Promise<DesktopProjects>
  save(project: DesktopProject): Promise<void>
  remove(projectId: string): Promise<void>
  open(projectId: string, engineId: string): Promise<void>
}

declare global {
  interface Window { readonly dinksterProjects: ProjectDialogBridge }
}

const bridge = window.dinksterProjects
const message = document.querySelector<HTMLElement>('#message')!

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

void perform(render)
