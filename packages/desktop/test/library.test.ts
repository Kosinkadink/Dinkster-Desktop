import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EnvironmentClient } from '../src/environment.js'
import { DesktopLibrary } from '../src/library.js'
import { readProjects, saveProject, writeProjects } from '../src/projects.js'

it.each(['bound', 'empty', 'changed-project', 'changed-identity', 'changed-snapshot', 'changed-settings'] as const)(
  'reads only authoritative environment software history: %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-library-history-'))
    roots.push(root)
    const first = join(root, 'first'), second = join(root, 'second')
    await writeProjects(root, { version: 1, projects: [first, second].map((path, index) => ({
      id: index === 0 ? 'first' : 'second', name: index === 0 ? 'First' : 'Second', root: path,
      channel: 'stable', engines: [{ id: 'main', name: 'Main', kind: 'local', gpus: [] }],
    })) })
    const before = await readFile(join(root, 'projects.json'), 'utf8')
    const entry = { format: 'dinkster.install-history/1', id: 7, generation: 12,
      timestamp: '2026-11-22T22:00:00Z', reason: 'update', exact: true, kind: 'activation',
      snapshot: { engine: { version: '0.2.3', release: 'recorded-release' }, base: { id: 'cpu', variant: 'cpu' } } }
    const notice = 'Snapshot 12 cannot open the migrated library without library-helper/1.'
    const script = join(root, 'command.cjs')
    await writeFile(script, `
      const fs=require('node:fs');
      const args=process.argv.slice(2), root=args[1], operation=args[2], scenario=${JSON.stringify(scenario)};
      if(!['project-get','project-check','history'].includes(operation) || args.includes('--yes') || args.includes('--plan')) process.exit(2);
      const marker=${JSON.stringify(join(root, 'history-read'))};
      const changed=fs.existsSync(marker), target=root===${JSON.stringify(second)};
      const project={id:'beta',uid:'30c30841-e92d-4f49-bbbd-e90a3a3f4140',name:'Beta',revision:7,deleted:false,
        environment:{id:'${'b'.repeat(32)}',lastSnapshot:null,lastRunAt:null}};
      if(changed && scenario==='changed-project') project.revision++;
      if(changed && scenario==='changed-identity') project.uid='b3ec9782-25ea-43f1-9fd7-564a4b577167';
      const result={format:'dinkster.environment-result/1',operation,status:'clean',root,current:3,plan:[]};
      if(operation==='history') {
        if(!target) process.exit(3);
        fs.writeFileSync(marker,'read');
        const entry=${JSON.stringify(entry)};
        entry.snapshot.metadata={'private-state':'not-for-renderer'};
        result.history=scenario==='empty'?[]:[entry];
        result.plan=[${JSON.stringify(notice)}];
        if(scenario==='changed-snapshot') result.current=4;
        if(scenario==='changed-settings') fs.writeFileSync(${JSON.stringify(join(root, 'projects.json'))},JSON.stringify({version:1,projects:[]}));
      } else {
        if(args[3]!=='beta') process.exit(4);
        result.project=project;
        result.environment={id:(target?'b':'a').repeat(32),snapshot:'3'};
      }
      console.log(JSON.stringify(result));
    `)
    const client = new EnvironmentClient(process.execPath, [script])
    try {
      const library = new DesktopLibrary(root, client)
      if (scenario === 'bound' || scenario === 'empty') {
        expect(await library.history('first', 'beta')).toEqual({
          installation: { id: 'second', name: 'Second' },
          project: { id: 'beta', uid: '30c30841-e92d-4f49-bbbd-e90a3a3f4140', name: 'Beta', revision: 7, deleted: false,
            environment: { id: 'b'.repeat(32), lastSnapshot: null, lastRunAt: null } },
          environment: { id: 'b'.repeat(32), snapshot: '3' }, entries: scenario === 'empty' ? [] : [entry], notices: [notice],
        })
        expect(await readFile(join(root, 'projects.json'), 'utf8')).toBe(before)
        await expect(library.history(first, 'beta')).rejects.toThrow('no saved local environment')
        await expect(library.history('first', '../beta')).rejects.toThrow('invalid library selection')
      } else {
        await expect(library.history('first', 'beta')).rejects.toThrow(scenario === 'changed-settings' ? 'no saved local environment' : 'changed')
      }
    } finally { await client.dispose() }
  },
)

it.each(['every-project', 'only-project', 'stale-project', 'stale-snapshot', 'stale-settings', 'document-changed', 'changed-after-retain', 'settings-during-precheck', 'expires-during-precheck', 'unknown-substitution', 'malformed-description', 'bad-choice', 'activation-failed'] as const)(
  'retains project software consent and refuses unsafe apply: %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-library-restore-'))
    roots.push(root)
    const source = { id: 'source', name: 'Studio', root: join(root, 'source'), channel: 'stable' as const,
      engines: [{ id: 'main', name: 'Main', kind: 'local' as const, gpus: [] }] }
    const target = { ...source, id: 'isolated', name: 'Film environment', root: join(root, 'isolated') }
    await mkdir(source.root)
    await writeProjects(root, { version: 1, projects: [source] })
    const state = join(root, 'state.json'), applied = join(root, 'applied.json'), script = join(root, 'command.cjs')
    await writeFile(state, '{}')
    const project = { id: 'film', uid: 'film-global', name: 'Film', revision: 7, deleted: false,
      environment: { id: 'a'.repeat(32), lastSnapshot: null, lastRunAt: null } }
    const sibling = { ...project, id: 'sibling', uid: 'sibling-global', name: 'Sibling', revision: 3 }
    const notice = 'Snapshot 12 cannot open this migrated library; choose a snapshot with library helper support.'
    await writeFile(script, `
      const fs=require('node:fs'), args=process.argv.slice(2), root=args[1], operation=args[2];
      const state=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')), applied=${JSON.stringify(applied)};
      const isolated=root===${JSON.stringify(target.root)}, done=fs.existsSync(applied);
      const project=${JSON.stringify(project)};
      if(state.changed) project.revision++;
      if(done && JSON.parse(fs.readFileSync(applied,'utf8')).includes('fork')) { project.revision=8; project.environment.id='b'.repeat(32); }
      const snapshot=isolated?1:done?3:state.snapshot?4:2;
      const result={format:'dinkster.environment-result/1',root,operation,status:'clean',current:snapshot,plan:[],
        project,environment:{id:(isolated?'b':'a').repeat(32),snapshot:String(snapshot)}};
      if(operation==='restore' || operation==='fork') {
        const scope=args[args.indexOf('--scope')+1], fork=operation==='fork';
        const before=${JSON.stringify(project)};
        result.restorePlan={format:'dinkster.restore-plan/1',entry:7,exact:false,missing:[],scope,
          projectReview:{library:'private-library-path',environment:before.environment.id,project:before,
            projects:[before,${JSON.stringify(sibling)}].map(project=>({project,needs:{}}))},
          alternatives:['c','d'].map((key,index)=>({approval:'sha256:'+key.repeat(64),
            snapshot:{engine:{version:index?'0.3.0':'0.2.0',release:index?'release-b':'release-a'},
              base:{id:'cpu',variant:'cpu'},metadata:{private:'private-software-recovery'}},substitutions:[
              {field:'engine',before:{version:'0.1.0',release:'recorded-release'},after:{version:index?'0.3.0':'0.2.0',release:index?'release-b':'release-a'}},
              {field:'base',before:{id:'old-cpu',variant:'old-variant'},after:{id:'cpu',variant:'cpu'}},
              {field:'constraints',before:'sha256:'+'e'.repeat(64),after:'sha256:'+'f'.repeat(64)},
              {field:'source',before:'published',after:'local'},
              {field:'inProcessPacks',before:['healthy'],after:[]},
              {field:'isolatedInferencePacks',before:[],after:['healthy']},
              {field:'metadata.dinkster.lock',before:JSON.stringify({format:'dinkster.lock/1',packs:[{pack:'healthy',version:'1.0',artifactDigest:'blake3:'+'1'.repeat(64),source:'local:/private-source'}]}),
                after:JSON.stringify({format:'dinkster.lock/1',packs:[{pack:'healthy',version:'2.0',artifactDigest:'blake3:'+'2'.repeat(64),source:'git:private-source'}]})},
              {field:'metadata.packs/healthy~render/pack-lock.json',before:null,
                after:JSON.stringify({format:'dinkster.pack-lock/3',pack:'healthy',part:'render',variant:'cpu',engine:'>=0.2,<0.4',indexes:['https://private-token@example.test'],
                  packages:[{name:'pillow',version:'12.0',wheels:[{filename:'pillow-12.0-py3-none-any.whl',sha256:'3'.repeat(64),url:'https://private-token@example.test/wheel'}]}]})},
              {field:'metadata.packs/healthy~render/installed-wheels.json',before:JSON.stringify({format:'dinkster.installed-wheels/1',wheels:[],inherited:['pillow']}),
                after:JSON.stringify({format:'dinkster.installed-wheels/1',wheels:[{filename:'pillow-12.0-py3-none-any.whl',sha256:'3'.repeat(64),registry:'https://private-token@example.test'}],inherited:[]})},
            ]})),
          ...(fork?{fork:{source:root,destination:${JSON.stringify(target.root)}}}:{})};
        if(${JSON.stringify(scenario)}==='unknown-substitution') result.restorePlan.alternatives[0].substitutions=[{field:'metadata.private-state',before:null,after:null}];
        if(${JSON.stringify(scenario)}==='malformed-description') result.restorePlan.alternatives[0].substitutions=[{field:'metadata.dinkster.lock',before:'private-raw-invalid-json',after:'{}'}];
        result.status=args.includes('--approve')?'applied':'approval-required'; result.restoredFrom=7;
        result.plan=[${JSON.stringify(notice)},'private-software-recovery','substitute metadata.dinkster.lock: private-library-helper/1-token'];
        if(fork) result.destination=${JSON.stringify(target.root)};
        if(args.includes('--approve')) {
          if(args[args.indexOf('--approve')+1]!=='sha256:'+'d'.repeat(64)) process.exit(3);
          if(fork && !JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'projects.json'))},'utf8')).projects.some(p=>p.id==='isolated')) process.exit(4);
          if(fork) fs.mkdirSync(${JSON.stringify(target.root)});
          fs.writeFileSync(applied,JSON.stringify(args));
          result.current=fork?1:3;result.engines=[];
          if(fork) {result.project={...before,revision:8,environment:{...before.environment,id:'b'.repeat(32)}};
            result.environment={id:'b'.repeat(32),snapshot:'1'};}
        } else {result.current=fork?null:2;delete result.environment;delete result.project;}
      }
      if(operation==='project-check' && state.settingsDuringCheck) {
        const path=${JSON.stringify(join(root, 'projects.json'))};
        const saved=JSON.parse(fs.readFileSync(path,'utf8'));saved.projects[0].name='Changed';fs.writeFileSync(path,JSON.stringify(saved));
      }
      console.log(JSON.stringify(result));
    `)
    const client = new EnvironmentClient(process.execPath, [script])
    let trusted = true, activation = ''
    const check = () => { if (!trusted) throw new Error('document changed') }
    const library = new DesktopLibrary(root, client, {
      fork: async () => ({ installation: target, destination: target.root, retain: async () => {
        await writeProjects(root, saveProject(await readProjects(root), target))
        if (scenario === 'changed-after-retain') await writeFile(state, '{"changed":true}')
        if (scenario === 'settings-during-precheck') await writeFile(state, '{"settingsDuringCheck":true}')
        if (scenario === 'expires-during-precheck') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900_000)
      } }),
      activate: async (installation, identifier, result, trust) => {
        trust()
        expect(identifier).toBe('film')
        expect(result.status).toBe('applied')
        if (scenario === 'activation-failed') throw new Error('activation failed')
        activation = installation.id
      },
    })
    const scope = ['only-project', 'changed-after-retain', 'settings-during-precheck', 'expires-during-precheck'].includes(scenario) ? 'only-project' : 'every-project'
    try {
      if (scenario === 'unknown-substitution' || scenario === 'malformed-description') {
        await expect(library.reviewRestore('source', 'film', 7, scope, check)).rejects.toThrow('unsupported restore software description')
        await expect(readFile(applied, 'utf8')).rejects.toThrow()
        return
      }
      const review = await library.reviewRestore('source', 'film', 7, scope, check)
      expect(review.projects.map((item) => item.name)).toEqual(scope === 'only-project' ? ['Film'] : ['Film', 'Sibling'])
      expect(review.alternatives.map((item) => item.snapshot.engine.release)).toEqual(['release-a', 'release-b'])
      expect(review.notices).toEqual([notice])
      expect(JSON.stringify(review)).not.toMatch(/private-|sha256:c{64}|sha256:d{64}|command.cjs/)
      expect(review.alternatives[1]!.changes.slice(0, 6)).toEqual([
        { field: 'engine', before: ['Version: 0.1.0', 'Release: recorded-release'], after: ['Version: 0.3.0', 'Release: release-b'] },
        { field: 'base', before: ['Base: old-cpu', 'Variant: old-variant'], after: ['Base: cpu', 'Variant: cpu'] },
        { field: 'constraints', before: [`sha256:${'e'.repeat(64)}`], after: [`sha256:${'f'.repeat(64)}`] },
        { field: 'source', before: ['published'], after: ['local'] },
        { field: 'inProcessPacks', before: ['healthy'], after: [] },
        { field: 'isolatedInferencePacks', before: [], after: ['healthy'] },
      ])
      const metadata = review.alternatives[1]!.changes.slice(6)
      expect(metadata[0]!.before).toContain(`healthy 1.0 (blake3:${'1'.repeat(64)})`)
      expect(metadata[0]!.after).toContain(`healthy 2.0 (blake3:${'2'.repeat(64)})`)
      expect(metadata[0]!.before[0]).toMatch(/^Software record SHA-256: [a-f0-9]{64}$/)
      expect(metadata[0]!.before[0]).not.toBe(metadata[0]!.after[0])
      expect(metadata[1]!.before).toEqual(['Not recorded'])
      expect(metadata[1]!.after.slice(1)).toEqual(['Pack: healthy', 'Variant: cpu', 'Part: render', 'Engine: >=0.2,<0.4', 'pillow 12.0', `pillow-12.0-py3-none-any.whl (${'3'.repeat(64)})`])
      expect(metadata[2]!.before.slice(1)).toEqual(['Provided by environment: pillow'])
      expect(metadata[2]!.after.slice(1)).toEqual([`pillow-12.0-py3-none-any.whl (${'3'.repeat(64)})`])
      expect((await readProjects(root)).projects).toHaveLength(1)
      if (scenario === 'stale-project') await writeFile(state, '{"changed":true}')
      if (scenario === 'stale-snapshot') await writeFile(state, '{"snapshot":true}')
      if (scenario === 'stale-settings') await writeProjects(root, { version: 1, projects: [{ ...source, name: 'Changed' }] })
      if (scenario === 'document-changed') trusted = false
      if (scenario === 'every-project' || scenario === 'only-project') {
        await library.applyRestore(review.token, 1, check)
        expect(activation).toBe(scope === 'only-project' ? 'isolated' : 'source')
        const args: string[] = JSON.parse(await readFile(applied, 'utf8'))
        expect(args.slice(args.indexOf('--approve'), args.indexOf('--approve') + 2)).toEqual(['--approve', `sha256:${'d'.repeat(64)}`])
      } else {
        await expect(library.applyRestore(review.token, scenario === 'bad-choice' ? 2 : 1, check)).rejects.toThrow()
        expect(activation).toBe('')
        if (scenario !== 'activation-failed') await expect(readFile(applied, 'utf8')).rejects.toThrow()
      }
      trusted = true
      await expect(library.applyRestore(review.token, 1, check)).rejects.toThrow('expired')
    } finally { vi.restoreAllMocks(); await client.dispose() }
  },
)

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
