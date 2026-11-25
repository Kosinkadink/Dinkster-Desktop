import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addChildWindow, addWorkspaceWindow, decodeWindowLayout, defaultWindowLayout, normalizeWindowBounds,
  readWindowLayout, removeWindow, restoreChildWindows, setWorkspaceProject, updateWindowPlacement, writeWindowLayout,
} from '../src/window-layout.js'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dinkster-window-layout-'))
  temporaryDirectories.push(path)
  return path
}

const placement = { bounds: { x: 10, y: 20, width: 640, height: 480 }, maximized: false } as const

describe('window layout model', () => {
  it('falls back for corrupt and unsupported persisted data', async () => {
    const directory = await temporaryDirectory()
    const fallback = defaultWindowLayout({ x: 1, y: 2, width: 800, height: 600 })
    await writeFile(join(directory, 'window-layout.json'), '{broken')
    expect(await readWindowLayout(directory, fallback)).toEqual(fallback)
    await writeFile(join(directory, 'window-layout.json'), JSON.stringify({ ...fallback, version: 3 }))
    expect(await readWindowLayout(directory, fallback)).toEqual(fallback)
  })

  it('migrates a version 1 layout to the workspace list', () => {
    const decoded = decodeWindowLayout({
      version: 1,
      primary: { id: 'primary', ...placement },
      children: [{ id: 'one', kind: 'workflow', workflowId: 'tab-a', ...placement }],
    })
    expect(decoded).toEqual({
      version: 2,
      workspaces: [{ id: 'primary', ...placement }],
      children: [{ id: 'one', kind: 'workflow', workflowId: 'tab-a', ...placement }],
    })
  })

  it('requires the primary workspace and validates workspace project ids', () => {
    const base = defaultWindowLayout()
    expect(decodeWindowLayout({ ...base, workspaces: [{ id: 'workspace-a', ...placement }] })).toBeUndefined()
    const decoded = decodeWindowLayout({ ...base, workspaces: [
      { id: 'primary', ...placement, projectId: 'default' },
      { id: 'workspace-a', ...placement, projectId: 'p-alpha' },
      { id: 'workspace-b', ...placement, projectId: 'NOT VALID!' },
    ] })
    expect(decoded?.workspaces).toEqual([
      { id: 'primary', ...placement },
      { id: 'workspace-a', ...placement, projectId: 'p-alpha' },
      { id: 'workspace-b', ...placement },
    ])
  })

  it('deduplicates workflow assignments per project, not globally', () => {
    const base = defaultWindowLayout()
    const decoded = decodeWindowLayout({ ...base, children: [
      { id: 'one', kind: 'workflow', workflowId: 'tab-a', ...placement },
      { id: 'two', kind: 'workflow', workflowId: 'tab-a', projectId: 'p-alpha', ...placement },
      { id: 'three', kind: 'workflow', workflowId: 'tab-a', projectId: 'p-alpha', ...placement },
    ] })
    expect(decoded?.children.map((child) => child.id)).toEqual(['one', 'two'])
  })

  it('adds, rebinds, and removes workspace windows but never removes the primary', () => {
    let layout = addWorkspaceWindow(defaultWindowLayout(), { id: 'workspace-a', projectId: 'p-alpha', ...placement })
    expect(() => addWorkspaceWindow(layout, { id: 'workspace-a', ...placement })).toThrow(/unique/)
    layout = setWorkspaceProject(layout, 'workspace-a', 'p-beta')
    expect(layout.workspaces[1]?.projectId).toBe('p-beta')
    layout = setWorkspaceProject(layout, 'workspace-a', undefined)
    expect(layout.workspaces[1]?.projectId).toBeUndefined()
    expect(removeWindow(layout, 'workspace-a').workspaces.map((workspace) => workspace.id)).toEqual(['primary'])
    expect(removeWindow(layout, 'primary').workspaces.map((workspace) => workspace.id)).toEqual(['primary', 'workspace-a'])
  })

  it('retains the first valid id and assignment and discards invalid children', () => {
    const base = defaultWindowLayout()
    const decoded = decodeWindowLayout({ ...base, children: [
      { id: 'one', kind: 'workflow', workflowId: 'tab-a', ...placement },
      { id: 'two', kind: 'workflow', workflowId: 'tab-a', ...placement },
      { id: 'one', kind: 'panel', panelId: 'preview', returnPlacement: 'dock', ...placement },
      { id: 'small', kind: 'panel', panelId: 'queue', returnPlacement: 'rail', bounds: { x: 0, y: 0, width: 10, height: 10 }, maximized: false },
      { id: 'three', kind: 'panel', panelId: 'preview', returnPlacement: 'bottom', ...placement },
    ] })
    expect(decoded?.children.map((child) => child.id)).toEqual(['one', 'three'])
  })

  it('adds, updates, and removes unique assignments', () => {
    const workflow = { id: 'workflow-window', kind: 'workflow', workflowId: 'tab-a', ...placement } as const
    let layout = addChildWindow(defaultWindowLayout(), workflow)
    expect(() => addChildWindow(layout, { ...workflow, id: 'duplicate' })).toThrow(/unique/)
    layout = updateWindowPlacement(layout, workflow.id, { maximized: true, bounds: { x: 30, y: 40, width: 700, height: 500 } })
    expect(layout.children[0]?.maximized).toBe(true)
    expect(removeWindow(layout, workflow.id).children).toEqual([])
  })

  it('recovers off-screen bounds and retains valid secondary-display bounds', () => {
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080, primary: true },
      { x: 1920, y: -200, width: 1280, height: 1024 },
    ]
    const secondary = { x: 2000, y: -100, width: 800, height: 600 }
    expect(normalizeWindowBounds(secondary, displays)).toEqual(secondary)
    expect(normalizeWindowBounds({ x: 8000, y: 5000, width: 900, height: 700 }, displays))
      .toEqual({ x: 1020, y: 380, width: 900, height: 700 })
  })

  it('fits restored bounds inside a display smaller than the normal desktop minimum', () => {
    expect(normalizeWindowBounds(
      { x: 0, y: 0, width: 1280, height: 800 },
      [{ x: 0, y: 0, width: 640, height: 480, primary: true }],
    )).toEqual({ x: 0, y: 0, width: 640, height: 480 })
  })

  it('keeps restoring after one child fails and removes only that assignment', async () => {
    let layout = addChildWindow(defaultWindowLayout(), {
      id: 'workflow-window', kind: 'workflow', workflowId: 'tab-a', ...placement,
    })
    layout = addChildWindow(layout, {
      id: 'panel-window', kind: 'panel', panelId: 'preview', returnPlacement: 'bottom', ...placement,
    })
    const attempted: string[] = []
    const restored = await restoreChildWindows(layout, async (child) => {
      attempted.push(child.id)
      if (child.id === 'workflow-window') throw new Error('load failed')
    })
    expect(attempted).toEqual(['workflow-window', 'panel-window'])
    expect(restored.layout.children.map((child) => child.id)).toEqual(['panel-window'])
    expect(restored.failures.map((failure) => failure.child.id)).toEqual(['workflow-window'])
  })

  it('atomically persists a round trip without leaving a temporary file', async () => {
    const directory = await temporaryDirectory()
    const layout = addChildWindow(defaultWindowLayout(), {
      id: 'panel-window', kind: 'panel', panelId: 'preview', returnPlacement: 'bottom', ...placement,
    })
    await writeWindowLayout(directory, layout)
    const updated = updateWindowPlacement(layout, 'panel-window', {
      bounds: { x: 40, y: 50, width: 700, height: 520 }, maximized: true,
    })
    await writeWindowLayout(directory, updated)
    expect(await readWindowLayout(directory)).toEqual(updated)
    expect(await readdir(directory)).toEqual(['window-layout.json'])
  })
})
