import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'
import type { GenerationSwapJournal, GenerationSwapStage } from './generation-swap.js'
import { validProjectId } from './window-layout.js'

function requireProjectId(projectId: string): void {
  if (!validProjectId(projectId)) throw new Error(`invalid project id: ${JSON.stringify(projectId)}`)
}

export function defaultProjectInstallRoot(dataDirectory: string, projectId: string): string {
  requireProjectId(projectId)
  return resolve(dataDirectory, 'engine-projects', projectId)
}

export function defaultProjectDataRoot(dataDirectory: string, projectId: string): string {
  requireProjectId(projectId)
  return resolve(dataDirectory, 'project-data', projectId)
}

function journalPath(dataDirectory: string, projectId: string): string {
  requireProjectId(projectId)
  return join(dataDirectory, 'engine-operations', `${projectId}.json`)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stage(value: unknown): value is GenerationSwapStage {
  return value === 'building' || value === 'switching' || value === 'failed'
}

export function decodeGenerationSwapJournal(value: unknown): GenerationSwapJournal | undefined {
  const body = record(value)
  if (!body || body['format'] !== 1 || !stage(body['stage'])) return undefined
  for (const field of ['operationId', 'projectId', 'previousGeneration', 'targetGeneration', 'startedAt']) {
    if (typeof body[field] !== 'string' || body[field].length === 0) return undefined
  }
  if (!validProjectId(body['projectId'])) return undefined
  if (body['failedAt'] !== undefined && typeof body['failedAt'] !== 'string') return undefined
  if (body['error'] !== undefined && typeof body['error'] !== 'string') return undefined
  return body as unknown as GenerationSwapJournal
}

export async function readGenerationSwapJournal(
  dataDirectory: string,
  projectId: string,
): Promise<GenerationSwapJournal | undefined> {
  try {
    const decoded = decodeGenerationSwapJournal(JSON.parse(await readFile(journalPath(dataDirectory, projectId), 'utf8')))
    return decoded?.projectId === projectId ? decoded : undefined
  } catch {
    return undefined
  }
}

export async function writeGenerationSwapJournal(
  dataDirectory: string,
  journal: GenerationSwapJournal,
): Promise<void> {
  const decoded = decodeGenerationSwapJournal(journal)
  if (!decoded) throw new Error('cannot persist an invalid generation swap journal')
  await writeFileAtomic(journalPath(dataDirectory, decoded.projectId), `${JSON.stringify(decoded, null, 2)}\n`)
}

export async function clearGenerationSwapJournal(dataDirectory: string, projectId: string): Promise<void> {
  await rm(journalPath(dataDirectory, projectId), { force: true })
}

export async function deleteConfirmedProjectData(dataRoot: string, confirmedDataRoot: string): Promise<void> {
  const expected = resolve(dataRoot)
  if (confirmedDataRoot !== expected) {
    throw new Error(`data deletion requires exact path confirmation: ${expected}`)
  }
  await rm(expected, { recursive: true, force: true })
}
