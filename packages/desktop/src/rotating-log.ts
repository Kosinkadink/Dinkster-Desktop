import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export class RotatingLog {
  private tail = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly maxBytes = 2 * 1024 * 1024,
    private readonly backups = 3,
  ) {}

  append(line: string): Promise<void> {
    const result = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      let bytes = 0
      try { bytes = (await stat(this.path)).size } catch { /* The first write creates the file. */ }
      if (bytes + Buffer.byteLength(line) + 1 > this.maxBytes) await this.rotate()
      await appendFile(this.path, `${line}\n`, 'utf8')
    })
    this.tail = result.catch(() => undefined)
    return result
  }

  async readTail(maxLines = 500): Promise<readonly string[]> {
    await this.tail
    const sources: string[] = []
    for (let index = this.backups; index >= 1; index -= 1) sources.push(`${this.path}.${index}`)
    sources.push(this.path)
    const lines: string[] = []
    for (const source of sources) {
      try { lines.push(...(await readFile(source, 'utf8')).split(/\r?\n/).filter(Boolean)) } catch { /* Missing generations are normal. */ }
    }
    return lines.slice(-maxLines)
  }

  private async rotate(): Promise<void> {
    await rm(`${this.path}.${this.backups}`, { force: true })
    for (let index = this.backups - 1; index >= 1; index -= 1) {
      try { await rename(`${this.path}.${index}`, `${this.path}.${index + 1}`) } catch { /* Missing generations are normal. */ }
    }
    try { await rename(this.path, `${this.path}.1`) } catch { /* The first generation may not exist. */ }
  }
}
