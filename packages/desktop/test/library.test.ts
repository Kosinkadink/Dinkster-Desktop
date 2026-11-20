import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EnvironmentClient } from '../src/environment.js'
import { DesktopLibrary } from '../src/library.js'
import { writeProjects } from '../src/projects.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('browses only saved local installations and keeps project pages separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-library-'))
  roots.push(root)
  await writeProjects(root, { version: 1, projects: [
    { id: 'local', name: 'Local studio', root: join(root, 'install'), channel: 'stable', engines: [{ id: 'main', name: 'Main', kind: 'local', gpus: [] }] },
    { id: 'remote', name: 'Remote studio', channel: 'nightly', engines: [{ id: 'server', name: 'Server', kind: 'remote', url: 'https://example.test' }] },
  ] })
  const script = join(root, 'command.cjs')
  const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'Image', size: 19, mediaType: 'image/png' }
  await writeFile(script, `
    const args=process.argv.slice(2), kind=args[3], project=args[args.indexOf('--project')+1];
    if(args.includes('--yes') || args.includes('--plan') || args[2]!=='library-list') process.exit(2);
    const library={kind,cursor:args.includes('--cursor=next') ? null : 'next',
      ...(kind==='projects' ? {items:[{id:'beta',name:'Beta'}]} :
      kind==='workflows' ? {records:[{id:'workflow-b',name:'Workflow B',scope:'local',project,mediaType:'application/x-dinkster-workflow+json'}]} :
      {assets:[{asset:${JSON.stringify(asset)},observations:[{project}],aliases:['Image']}]})};
    console.log(JSON.stringify({format:'dinkster.environment-result/1',operation:'library-list',status:'clean',root:args[1],current:null,plan:[],library}));
  `)
  const client = new EnvironmentClient(process.execPath, [script])
  const library = new DesktopLibrary(root, client)
  expect(await library.installations()).toEqual([{ id: 'local', name: 'Local studio' }])
  expect(await library.projects('local', null)).toEqual({ items: [{ id: 'beta', name: 'Beta' }], cursor: 'next' })
  expect(await library.workflows('local', 'beta', 'next')).toEqual({ items: [{ id: 'workflow-b', name: 'Workflow B' }], cursor: null })
  expect(await library.assets('local', 'beta', null)).toEqual({ items: [{ id: asset.digest, name: 'Image' }], cursor: 'next' })
  const notice = 'By the way, these projects and files cannot be shown with the installed tools.'
  await expect(library.projects(join(root, 'install'), null)).rejects.toThrow(notice)
  await expect(library.projects('remote', null)).rejects.toThrow(notice)
  await expect(library.assets('local', '../beta', null)).rejects.toThrow(notice)
  const original = await readFile(script, 'utf8')
  await writeFile(script, original.replace('scope:\'local\',project,', 'scope:\'local\',project:\'other\','))
  await expect(library.workflows('local', 'beta', null)).rejects.toThrow(notice)
  await writeFile(script, original.replace('observations:[{project}]', "observations:[{project:'other'}]"))
  await expect(library.assets('local', 'beta', null)).rejects.toThrow(notice)
  await writeFile(script, original.replace('blake3:', 'sha256:'))
  await expect(library.assets('local', 'beta', null)).rejects.toThrow(notice)
  await client.dispose()
})

it.each([
  'bound', 'unbound', 'missing', 'ambiguous', 'other-library', 'stale-project',
  'stale-snapshot', 'incompatible', 'unavailable-library', 'broken-tools', 'changed-source', 'changed-settings',
] as const)('prepares project opening without activation: %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-project-open-'))
  roots.push(root)
  const first = join(root, 'first'), second = join(root, 'second'), unrelated = join(root, 'unrelated')
  const installations = [first, second, unrelated].map((path, index) => ({
    id: ['first', 'second', 'unrelated'][index]!, name: `Studio ${index}`, root: path,
    channel: 'stable' as const, engines: [{ id: 'main', name: 'Main', kind: 'local' as const, gpus: [] }],
  }))
  await writeProjects(root, { version: 1, projects: installations })
  const before = await readFile(join(root, 'projects.json'), 'utf8')
  const script = join(root, 'command.cjs')
  const project = {
    id: 'beta', uid: '30c30841-e92d-4f49-bbbd-e90a3a3f4140', name: 'Beta', revision: 7, deleted: false,
    environment: scenario === 'unbound' ? null : { id: 'b'.repeat(32), lastSnapshot: '2', lastRunAt: '2026-11-19T20:00:00Z' },
  }
  await writeFile(script, `
    const fs=require('node:fs'), path=require('node:path');
    const args=process.argv.slice(2), root=args[1], operation=args[2], scenario=${JSON.stringify(scenario)};
    if(!['project-get','project-check'].includes(operation) || args[3]!=='beta' || args.includes('--yes') || args.includes('--plan')) process.exit(2);
    const project=${JSON.stringify(project)};
    let error;
    if(root===${JSON.stringify(unrelated)}) error=scenario==='broken-tools' ? 'unsupported dinkster-env response' : 'project is unavailable';
    if(root===${JSON.stringify(second)} && scenario==='unavailable-library') error='project library is unavailable';
    let id=root===${JSON.stringify(first)} ? '${'a'.repeat(32)}' : '${'b'.repeat(32)}';
    if(scenario==='missing' && root===${JSON.stringify(second)}) id='${'c'.repeat(32)}';
    if(scenario==='ambiguous') id='${'b'.repeat(32)}';
    if(scenario==='other-library' && root===${JSON.stringify(second)}) project.uid='b3ec9782-25ea-43f1-9fd7-564a4b577167';
    if(operation==='project-check' && scenario==='stale-project') project.revision++;
    if(operation==='project-check' && scenario==='incompatible') error='library compatibility refused';
    const marker=${JSON.stringify(join(root, 'checked'))};
    if(operation==='project-check') {
      fs.writeFileSync(marker,'checked');
      if(scenario==='changed-settings') fs.writeFileSync(${JSON.stringify(join(root, 'projects.json'))},JSON.stringify({version:1,projects:[]}));
    }
    if(scenario==='changed-source' && root===${JSON.stringify(first)} && fs.existsSync(marker)) project.revision++;
    console.log(JSON.stringify({format:'dinkster.environment-result/1',operation,status:error?'error':'clean',root,
      current:operation==='project-check' && scenario==='stale-snapshot'?4:3,plan:[],
      ...(error?{error}:{project,environment:{id,snapshot:operation==='project-check' && scenario==='stale-snapshot'?'4':'3'}})}));
  `)
  const client = new EnvironmentClient(process.execPath, [script])
  try {
    const library = new DesktopLibrary(root, client)
    if (scenario === 'bound' || scenario === 'unbound') {
      const prepared = await library.prepareOpen('first', 'beta')
      expect(prepared).toEqual({
        installation: installations[scenario === 'bound' ? 1 : 0], project,
        environment: { id: (scenario === 'bound' ? 'b' : 'a').repeat(32), snapshot: '3' },
      })
      expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(before)
    } else {
      const message = {
        missing: 'missing or ambiguous', ambiguous: 'missing or ambiguous', 'other-library': 'library binding changed',
        'stale-project': 'project or environment changed', 'stale-snapshot': 'project or environment changed',
        incompatible: 'library compatibility refused', 'unavailable-library': 'missing or ambiguous',
        'broken-tools': 'unsupported dinkster-env response', 'changed-source': 'library binding changed',
        'changed-settings': 'saved environments changed',
      }[scenario]
      await expect(library.prepareOpen('first', 'beta')).rejects.toThrow(message)
    }
    await expect(library.prepareOpen(first, 'beta')).rejects.toThrow('no saved local environment')
    await expect(library.prepareOpen('first', '../beta')).rejects.toThrow('invalid library selection')
  } finally { await client.dispose() }
})
