import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'

export const WINDOW_LAYOUT_VERSION = 2
export const MIN_WINDOW_WIDTH = 320
export const MIN_WINDOW_HEIGHT = 240

export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface WindowPlacement {
  readonly bounds: WindowBounds
  readonly maximized: boolean
}

/**
 * A top-level workspace window. The window with id 'primary' always exists
 * and owns the application lifecycle (closing it quits); additional
 * workspace windows may be opened on any project and close independently.
 */
export interface WorkspaceWindow extends WindowPlacement {
  readonly id: string
  /** Project this window is bound to; absent = the default project. */
  readonly projectId?: string
}

export interface WorkflowWindow extends WindowPlacement {
  readonly id: string
  readonly kind: 'workflow'
  readonly workflowId: string
  /** Project whose tab authority this tear-out belongs to; absent = default. */
  readonly projectId?: string
}

export interface PanelWindow extends WindowPlacement {
  readonly id: string
  readonly kind: 'panel'
  readonly panelId: string
  readonly returnPlacement: 'dock' | 'rail' | 'bottom'
  /** Project whose tab authority this panel belongs to; absent = default. */
  readonly projectId?: string
}

export type ChildWindow = WorkflowWindow | PanelWindow

export interface WindowLayout {
  readonly version: typeof WINDOW_LAYOUT_VERSION
  /** Top-level workspace windows; the entry with id 'primary' always exists. */
  readonly workspaces: readonly WorkspaceWindow[]
  readonly children: readonly ChildWindow[]
}

/** Mirrors the project id shape accepted by the renderer (app projects.ts). */
export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

export interface DisplayWorkArea extends WindowBounds {
  readonly primary?: boolean
}

const DEFAULT_BOUNDS: WindowBounds = { x: 80, y: 80, width: 1280, height: 800 }

export function defaultWindowLayout(primaryBounds: WindowBounds = DEFAULT_BOUNDS): WindowLayout {
  return {
    version: WINDOW_LAYOUT_VERSION,
    workspaces: [{ id: 'primary', bounds: validateBounds(primaryBounds), maximized: false }],
    children: [],
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function decodeBounds(value: unknown): WindowBounds | undefined {
  const row = record(value)
  if (!row) return undefined
  const { x, y, width, height } = row
  if (![x, y, width, height].every((entry) => typeof entry === 'number' && Number.isFinite(entry)) ||
    (width as number) < MIN_WINDOW_WIDTH || (height as number) < MIN_WINDOW_HEIGHT) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

function decodePlacement(value: Record<string, unknown>): WindowPlacement | undefined {
  const bounds = decodeBounds(value['bounds'])
  return bounds && typeof value['maximized'] === 'boolean'
    ? { bounds, maximized: value['maximized'] }
    : undefined
}

/** 'default' is normalized to absence so the two spellings cannot diverge. */
function decodeProject(value: unknown): { readonly projectId?: string } {
  return validProjectId(value) && value !== 'default' ? { projectId: value } : {}
}

export function decodeWindowLayout(value: unknown): WindowLayout | undefined {
  const root = record(value)
  if (!root || !Array.isArray(root['children'])) return undefined
  // Version 1 stored a single primary window; it migrates to a one-entry
  // workspace list bound to the default project.
  let workspacesRaw: unknown
  if (root['version'] === 1) workspacesRaw = [root['primary']]
  else if (root['version'] === WINDOW_LAYOUT_VERSION) workspacesRaw = root['workspaces']
  else return undefined
  if (!Array.isArray(workspacesRaw)) return undefined

  const ids = new Set<string>()
  const workspaces: WorkspaceWindow[] = []
  for (const value of workspacesRaw) {
    const workspace = record(value)
    if (!workspace || !nonEmptyString(workspace['id']) || ids.has(workspace['id'])) continue
    const placement = decodePlacement(workspace)
    if (!placement) continue
    ids.add(workspace['id'])
    workspaces.push({ id: workspace['id'], ...placement, ...decodeProject(workspace['projectId']) })
  }
  if (!ids.has('primary')) return undefined

  // Workflow/panel assignments are unique within a project: the same
  // document may be torn out once per project, not once globally.
  const assignments = new Set<string>()
  const decoded: ChildWindow[] = []
  for (const value of root['children']) {
    const child = record(value)
    if (!child || !nonEmptyString(child['id']) || ids.has(child['id'])) continue
    const placement = decodePlacement(child)
    if (!placement) continue
    const project = decodeProject(child['projectId'])
    const scope = project.projectId ?? ''
    if (child['kind'] === 'workflow' && nonEmptyString(child['workflowId']) &&
      !assignments.has(`${scope}\nworkflow\n${child['workflowId']}`)) {
      ids.add(child['id'])
      assignments.add(`${scope}\nworkflow\n${child['workflowId']}`)
      decoded.push({ id: child['id'], kind: 'workflow', workflowId: child['workflowId'], ...placement, ...project })
    } else if (child['kind'] === 'panel' && nonEmptyString(child['panelId']) &&
      !assignments.has(`${scope}\npanel\n${child['panelId']}`) &&
      (child['returnPlacement'] === 'dock' || child['returnPlacement'] === 'rail' || child['returnPlacement'] === 'bottom')) {
      ids.add(child['id'])
      assignments.add(`${scope}\npanel\n${child['panelId']}`)
      decoded.push({
        id: child['id'], kind: 'panel', panelId: child['panelId'],
        returnPlacement: child['returnPlacement'], ...placement, ...project,
      })
    }
  }
  return { version: WINDOW_LAYOUT_VERSION, workspaces, children: decoded }
}

function validateBounds(bounds: WindowBounds): WindowBounds {
  const decoded = decodeBounds(bounds)
  if (!decoded) throw new Error(`window bounds must be finite and at least ${MIN_WINDOW_WIDTH}x${MIN_WINDOW_HEIGHT}`)
  return decoded
}

export function addChildWindow(layout: WindowLayout, child: ChildWindow): WindowLayout {
  const decoded = decodeWindowLayout({ ...layout, children: [...layout.children, child] })
  if (!decoded || decoded.children.length !== layout.children.length + 1) {
    throw new Error('window id and workflow or panel assignment must be unique and valid')
  }
  return decoded
}

export function addWorkspaceWindow(layout: WindowLayout, workspace: WorkspaceWindow): WindowLayout {
  const decoded = decodeWindowLayout({ ...layout, workspaces: [...layout.workspaces, workspace] })
  if (!decoded || decoded.workspaces.length !== layout.workspaces.length + 1) {
    throw new Error('workspace window id must be unique and valid')
  }
  return decoded
}

/** Removes a window of either kind; the primary workspace is never removed. */
export function removeWindow(layout: WindowLayout, id: string): WindowLayout {
  return {
    ...layout,
    workspaces: id === 'primary' ? layout.workspaces : layout.workspaces.filter((workspace) => workspace.id !== id),
    children: layout.children.filter((child) => child.id !== id),
  }
}

export function setWorkspaceProject(layout: WindowLayout, id: string, projectId: string | undefined): WindowLayout {
  return {
    ...layout,
    workspaces: layout.workspaces.map((workspace) => workspace.id === id
      ? { id: workspace.id, bounds: workspace.bounds, maximized: workspace.maximized, ...(projectId ? { projectId } : {}) }
      : workspace),
  }
}

export async function restoreChildWindows(
  layout: WindowLayout,
  restore: (child: ChildWindow) => Promise<void>,
): Promise<{ readonly layout: WindowLayout; readonly failures: readonly { readonly child: ChildWindow; readonly error: unknown }[] }> {
  let restored = layout
  const failures: { child: ChildWindow; error: unknown }[] = []
  for (const child of layout.children) {
    try {
      await restore(child)
    } catch (error) {
      restored = removeWindow(restored, child.id)
      failures.push({ child, error })
    }
  }
  return { layout: restored, failures }
}

export function updateWindowPlacement(
  layout: WindowLayout,
  id: string,
  placement: Partial<WindowPlacement>,
): WindowLayout {
  const update = <T extends WindowPlacement>(window: T): T => ({
    ...window,
    ...(placement.bounds ? { bounds: validateBounds(placement.bounds) } : {}),
    ...(placement.maximized === undefined ? {} : { maximized: placement.maximized }),
  })
  if (layout.workspaces.some((workspace) => workspace.id === id)) {
    return { ...layout, workspaces: layout.workspaces.map((workspace) => workspace.id === id ? update(workspace) : workspace) }
  }
  return { ...layout, children: layout.children.map((child) => child.id === id ? update(child) : child) }
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  return Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) *
    Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
}

export function normalizeWindowBounds(bounds: WindowBounds, workAreas: readonly DisplayWorkArea[]): WindowBounds {
  validateBounds(bounds)
  const validAreas = workAreas.filter((area) => decodeBounds(area))
  if (validAreas.length === 0) return bounds
  const fitting = validAreas.find((area) => bounds.x >= area.x && bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height)
  if (fitting) return bounds
  const visible = validAreas.map((area) => ({ area, overlap: intersectionArea(bounds, area) }))
    .sort((left, right) => right.overlap - left.overlap)[0]
  const target = visible && visible.overlap > 0
    ? visible.area
    : validAreas.find((area) => area.primary) ?? validAreas[0]!
  const width = Math.min(bounds.width, target.width)
  const height = Math.min(bounds.height, target.height)
  return {
    x: Math.min(Math.max(bounds.x, target.x), target.x + target.width - width),
    y: Math.min(Math.max(bounds.y, target.y), target.y + target.height - height),
    width,
    height,
  }
}

const layoutPath = (dataDirectory: string): string => join(dataDirectory, 'window-layout.json')

export async function readWindowLayout(dataDirectory: string, fallback = defaultWindowLayout()): Promise<WindowLayout> {
  try {
    return decodeWindowLayout(JSON.parse(await readFile(layoutPath(dataDirectory), 'utf8'))) ?? fallback
  } catch {
    return fallback
  }
}

export async function writeWindowLayout(dataDirectory: string, layout: WindowLayout): Promise<void> {
  const validated = decodeWindowLayout(layout)
  if (!validated || validated.children.length !== layout.children.length ||
    validated.workspaces.length !== layout.workspaces.length) {
    throw new Error('cannot persist an invalid window layout')
  }
  await writeFileAtomic(layoutPath(dataDirectory), `${JSON.stringify(validated, null, 2)}\n`)
}
