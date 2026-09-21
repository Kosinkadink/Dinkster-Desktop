import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RotatingLog } from '../src/rotating-log.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('rotating diagnostics', () => {
  it('serializes concurrent appends and retains bounded generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dinkster-log-test-'))
    roots.push(root)
    const log = new RotatingLog(join(root, 'engine.log'), 13, 2)
    await Promise.all(['first', 'second', 'third', 'fourth'].map((line) => log.append(line)))
    const lines = await log.readTail()
    expect(lines).toEqual(['first', 'second', 'third', 'fourth'])
    expect(await log.readTail(2)).toEqual(['third', 'fourth'])
  })
})
