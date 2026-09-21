import type { DesktopDeepLink } from './types.js'

/**
 * Strict dinkster:// grammar:
 *
 *   dinkster://open/workflow?workflow=<record-id>[&project=<project-id>][&backend=<http(s)-url>]
 *
 * Links carry identifiers only. Anything else - embedded credentials,
 * unknown hosts or paths, non-http backend URLs, oversized or control-coded
 * identifiers - is rejected as a whole, never partially honored. The
 * renderer side formats the same grammar (packages/app connection-profiles).
 */

const MAX_WORKFLOW_ID = 512

/** Matches the renderer's project id shape (app projects.ts validProjectId). */
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

function validWorkflowId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_WORKFLOW_ID) return false
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function validBackendUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' && parsed.password === ''
}

export function parseDeepLink(raw: string): DesktopDeepLink | undefined {
  if (typeof raw !== 'string' || raw.length > 4096) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dinkster:' || url.username !== '' || url.password !== '') return undefined
  if (url.host !== 'open' || url.pathname !== '/workflow' || url.hash !== '') return undefined
  // Whole-link strictness: only the three known keys, each at most once.
  const keys = [...url.searchParams.keys()]
  if (keys.length !== new Set(keys).size) return undefined
  if (keys.some((key) => key !== 'workflow' && key !== 'project' && key !== 'backend')) return undefined
  const workflowId = url.searchParams.get('workflow')
  if (workflowId === null || !validWorkflowId(workflowId)) return undefined
  const project = url.searchParams.get('project') ?? 'default'
  if (!PROJECT_ID.test(project)) return undefined
  const backend = url.searchParams.get('backend')
  if (backend !== null && !validBackendUrl(backend)) return undefined
  return {
    projectId: project,
    workflowId,
    ...(backend !== null ? { backendUrl: backend } : {}),
  }
}

/** The first parseable dinkster:// link in a process argument list, if any. */
export function deepLinkFromArgv(argv: readonly string[]): DesktopDeepLink | undefined {
  for (const argument of argv) {
    if (!argument.startsWith('dinkster://')) continue
    const link = parseDeepLink(argument)
    if (link) return link
  }
  return undefined
}
