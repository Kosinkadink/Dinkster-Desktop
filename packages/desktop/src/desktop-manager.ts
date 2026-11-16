import { readdir, stat, statfs, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultDataDirectory(): string {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Dinkster Desktop')
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'dinkster-desktop')
}

export interface SystemCheck {
  readonly platform: string
  readonly architecture: string
  readonly freeBytes: number
  readonly totalBytes: number
  readonly gpu: { readonly available: boolean; readonly name?: string; readonly driver?: string; readonly memoryMiB?: number }
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

export async function desktopStorageBytes(dataDirectory: string): Promise<number> {
  try {
    return await directoryBytes(dataDirectory)
  } catch {
    return 0
  }
}

export async function systemCheck(
  dataDirectory: string,
  gpu: SystemCheck['gpu'],
): Promise<SystemCheck> {
  await mkdir(dataDirectory, { recursive: true })
  const disk = await statfs(dataDirectory, { bigint: true })
  return {
    platform: process.platform,
    architecture: process.arch,
    freeBytes: Number(disk.bavail * disk.bsize),
    totalBytes: Number(disk.blocks * disk.bsize),
    gpu,
  }
}

export function redactDiagnosticText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:token|password|passwd|secret|api[_-]?key|access[_-]?token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:--)?(?:token|password|passwd|secret|api[_-]?key)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:token|password|secret|apiKey|accessToken)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
}
