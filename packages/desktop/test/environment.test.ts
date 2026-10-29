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
      url: operation === 'update' ? 'http://127.0.0.1:44002' : 'http://127.0.0.1:44001',
      engines: [{name:'main',generation:2,state:operation === 'stop' ? 'stopped' : 'ready',
        url:operation === 'update' ? 'http://127.0.0.1:44002' : 'http://127.0.0.1:44001'}], ...(error ? {error} : {})}));
    if (error) process.exitCode = 1;
  `)
  return { root, client: new EnvironmentClient(process.execPath, [script]) }
}

describe('Desktop dinkster-env command client', () => {
  it('plans by default and passes explicit confirmation without changing artifact formats', async () => {
    const { root, client } = await commandFixture()
    const request = { root, operation: 'setup' as const, channel: 'main' as const, variant: 'win-nvidia-cu126', mirrors: [join(root, 'offline mirror'), 'https://releases.dinkster.org'], data: join(root, 'wheel store'), port: 44000, engine: 'compute', gpus: ['1'] }
    const plan = await client.run(request)
    expect(plan.status).toBe('planned')
    expect(plan.plan).toEqual(['reuse the shared wheel store'])
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'setup', '--channel', 'main', '--variant', 'win-nvidia-cu126',
      '--mirror', join(root, 'offline mirror'), '--mirror', 'https://releases.dinkster.org',
      '--data', join(root, 'wheel store'), '--port', '44000', '--engine', 'compute', '--gpu', '1', '--json', '--plan',
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

  it('reads catalog discovery without confirmation and preserves producer manifests', async () => {
    const { root } = await commandFixture()
    const base = `sha256:${'a'.repeat(64)}`
    const manifest = { format: 'dinkster.base/1', id: base, variant: 'custom-base', platform: { os: 'windows', arch: 'x86_64' },
      nvidia: { minimumDriver: '580.10.1', minimumComputeCapability: '7.5', maximumExclusiveComputeCapability: null }, parts: [], python: '3.14.10' }
    const response = { format: 'dinkster.environment-result/1', operation: 'catalog', status: 'clean', root, current: null, plan: [], channel: 'main',
      channelManifest: { format: 'dinkster.channel/1', base: { 'custom-base': base } }, variants: [{ variant: 'custom-base', base, manifest, downloadBytes: 123456789 }] }
    const script = join(root, 'catalog.cjs')
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'catalog-args.json'))},JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(response))});`)
    const client = new EnvironmentClient(process.execPath, [script])
    expect(await client.run({ root, operation: 'catalog', channel: 'main', mirrors: [join(root, 'mirror')] }, true)).toEqual(response)
    expect(JSON.parse(await readFile(join(root, 'catalog-args.json'), 'utf8'))).toEqual(['--root', root, 'catalog', '--channel', 'main', '--mirror', join(root, 'mirror'), '--json'])
    for (const invalid of [
      { ...manifest, platform: undefined },
      { ...manifest, nvidia: { ...manifest.nvidia, minimumDriver: 580 } },
      { ...manifest, nvidia: { ...manifest.nvidia, maximumExclusiveComputeCapability: '10.x' } },
      { ...manifest, id: `sha256:${'b'.repeat(64)}` },
    ]) {
      await writeFile(script, `console.log(${JSON.stringify(JSON.stringify({ ...response, variants: [{ ...response.variants[0], manifest: invalid }] }))});`)
      await expect(client.run({ root, operation: 'catalog' })).rejects.toThrow('unsupported dinkster-env catalog response')
    }
  })

  it('starts and stops named engines with scoped devices and consumes new supervisor URLs', async () => {
    const { root, client } = await commandFixture()
    const started = await client.run({ root, operation: 'start', engine: 'main', port: 44000, gpus: ['1', 'GPU-1234-abcd'] }, true)
    expect(started.engines).toEqual([{ name: 'main', generation: 2, state: 'ready', url: 'http://127.0.0.1:44001' }])
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual([
      '--root', root, 'start', '--port', '44000', '--engine', 'main', '--gpu', '1', '--gpu', 'GPU-1234-abcd', '--json', '--yes',
    ])
    const updated = await client.run({ root, operation: 'update' }, true)
    expect(updated.url).toBe('http://127.0.0.1:44002')
    expect(updated.engines?.[0]?.url).toBe('http://127.0.0.1:44002')
    await client.run({ root, operation: 'status' })
    expect(JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))).toEqual(['--root', root, 'status', '--json'])
    const stopped = await client.run({ root, operation: 'stop', engine: 'main' }, true)
    expect(stopped.engines?.[0]?.state).toBe('stopped')
    await expect(client.run({ root, operation: 'start', engine: '--other' }, true)).rejects.toThrow('invalid engine name')
    await expect(client.run({ root, operation: 'start', gpus: ['display adapter'] }, true)).rejects.toThrow('invalid GPU device')
  })

  it('rejects nonzero responses even when their status claims success, and surfaces drift details', async () => {
    const { root } = await commandFixture()
    for (const status of ['applied', 'drift']) {
      const client = new EnvironmentClient(process.execPath, ['-e', `console.log(JSON.stringify({
        format:'dinkster.environment-result/1',operation:'doctor',status:'${status}',
        root:${JSON.stringify(root)},current:2,plan:[],changes:['constraints.txt has drifted']
      }));process.exitCode=1;`, '--'])
      await expect(client.run({ root, operation: 'doctor' })).rejects.toThrow('constraints.txt has drifted')
    }
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
