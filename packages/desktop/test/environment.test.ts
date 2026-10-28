import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvironmentClient, type EnvironmentOperation } from '../src/environment.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function commandFixture(): Promise<{ root: string; client: EnvironmentClient }> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-env-'))
  roots.push(root)
  const script = join(root, 'command.cjs')
  await writeFile(script, `
    const fs = require('node:fs'); const path = require('node:path');
    const args = process.argv.slice(2);
    const root = args[args.indexOf('--root') + 1]; const operation = args[args.indexOf('--root') + 2];
    fs.writeFileSync(path.join(root, 'arguments.json'), JSON.stringify(args));
    const error = args.includes('--repair') ? 'generation drift needs offline repair' : undefined;
    console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,
      status:error ? 'error' : args.includes('--plan') ? 'planned' : operation === 'doctor' ? 'clean' : 'applied',
      root, current: 2, plan: ['reuse the shared wheel store'],
      url: 'http://127.0.0.1:44001', ...(error ? {error} : {})}));
    if (error) process.exitCode = 1;
  `)
  return { root, client: new EnvironmentClient(process.execPath, [script]) }
}

describe('Desktop dinkster-env command client', () => {
  it('plans by default and passes explicit confirmation without changing artifact formats', async () => {
    const { root, client } = await commandFixture()
    const request = { root, operation: 'setup' as const, channel: 'main' as const, variant: 'win-nvidia-cu126', mirrors: [join(root, 'offline mirror'), 'https://releases.dinkster.org'], data: join(root, 'wheel store'), port: 44000 }
    const plan = await client.run(request)
    expect(plan.status).toBe('planned')
    expect(plan.plan).toEqual(['reuse the shared wheel store'])
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'setup', '--channel', 'main', '--variant', 'win-nvidia-cu126',
      '--mirror', join(root, 'offline mirror'), '--mirror', 'https://releases.dinkster.org',
      '--data', join(root, 'wheel store'), '--port', '44000', '--json', '--plan',
    ])
    const applied = await client.run(request, true)
    expect(applied.status).toBe('applied')
    expect(applied.url).toBe('http://127.0.0.1:44001')
    const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
    expect(args).toContain('--yes')
    expect(args).not.toContain('--plan')
  })

  it('delegates update, rollback and move, while doctor stays read-only', async () => {
    const { root, client } = await commandFixture()
    for (const operation of ['update', 'rollback', 'move', 'doctor'] as const) {
      const result = await client.run({ root, operation, ...(operation === 'move' ? { destination: join(root, 'moved project') } : {}) }, true)
      expect(result.operation).toBe(operation)
      expect(result.status).toBe(operation === 'doctor' ? 'clean' : 'applied')
      const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
      expect(args.includes('--yes')).toBe(operation !== 'doctor')
      if (operation === 'move') expect(args[3]).toBe(join(root, 'moved project'))
    }
    await expect(client.run({ root, operation: 'doctor', repair: true }, true)).rejects.toThrow('generation drift needs offline repair')
  })

  it('rejects unsafe requests and malformed responses instead of treating them as applied', async () => {
    const { root, client } = await commandFixture()
    await expect(client.run({ root: 'relative', operation: 'setup' })).rejects.toThrow('must be absolute')
    await expect(client.run({ root, operation: 'move' })).rejects.toThrow('absolute destination')
    await expect(client.run({ root, operation: 'setup', variant: '--cpu' })).rejects.toThrow('invalid environment variant')
    await expect(client.run({ root, operation: 'setup', port: 0 })).rejects.toThrow('invalid supervisor port')
    await expect(client.run({ root, operation: 'other' as EnvironmentOperation })).rejects.toThrow('unsupported')
    const malformed = new EnvironmentClient(process.execPath, ['-e', 'console.log(JSON.stringify({format:"other"}));', '--'])
    await expect(malformed.run({ root, operation: 'doctor' })).rejects.toThrow('unsupported dinkster-env response')
    await expect(new EnvironmentClient(join(root, 'absent-command')).run({ root, operation: 'doctor' })).rejects.toThrow('not installed')
  })
})
