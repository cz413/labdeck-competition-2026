import { describe, expect, it } from 'vitest'
import { commandDataPath, projectConfigurationKey, projectDraftPatch, projectLaunchIssue, syncCommandDataPath } from './project-task'
import { experimentTaskDraftSchema } from './schemas'
import type { RepositoryGuide } from './repository-guide'

const serverId='22222222-2222-4222-8222-222222222222'
const draft=experimentTaskDraftSchema.parse({title:'我的基线',objective:'手动目标',serverId,accessRouteId:'direct',notes:'已处理数据',dataPath:'/data/existing'})
const guide:RepositoryGuide={status:'needs_info',summary:'训练基线',launchCommand:'python train.py --data /data/new',workingDirectory:'./src/../training',environmentName:'vision',dataPath:'/data/new',missingInputs:['数据是否处理完成？'],questions:[],warnings:[],checks:[{path:'training/train.py',expected:'file',status:'confirmed',message:'exists'}],launchOrigin:'documented',launchCitations:[{path:'README.md',startLine:2,endLine:2,quote:'python train.py'}],steps:[],launchSources:['README.md'],snapshot:{input:{source:'remote',serverId,accessRouteId:'direct',path:'/repo/'},files:[],excerpts:[],warnings:[],collectedAt:new Date().toISOString()}}
describe('project suggestions in a shared task draft',()=>{
  it('applies config without replacing manual task information or adding an identity',()=>{
    const next={...draft,...projectDraftPatch(guide,draft)}
    expect(next).toMatchObject({title:'我的基线',objective:'手动目标',notes:'已处理数据',codePath:'/repo/training',launchMode:'command',launchCommand:guide.launchCommand})
    expect(next.id).toBeUndefined()
    expect(next.projectPreparation?.questions).toEqual(['数据是否处理完成？'])
    expect(experimentTaskDraftSchema.parse(next).projectPreparation).toEqual(next.projectPreparation)
    expect(next.projectPreparation).not.toHaveProperty('snapshot')
  })
  it('scopes old checks to server, route, launch config, data and environment',()=>{
    const next={...draft,...projectDraftPatch(guide,draft)},key=next.projectPreparation!.configurationKey
    expect(projectConfigurationKey(next)).toBe(key)
    for(const patch of [{serverId:'other'},{accessRouteId:'jump'},{codePath:'/other'},{dataPath:'/other'},{launchCommand:'python eval.py'},{condaEnvironment:{manager:'conda' as const,environmentName:'other'}}])expect(projectConfigurationKey({...next,...patch})).not.toBe(key)
  })
  it('supports the remote root and bounds saved evidence',()=>{
    const next=projectDraftPatch({...guide,workingDirectory:'.',snapshot:{...guide.snapshot,input:{...guide.snapshot.input,path:'/'}}},draft)
    expect(next.codePath).toBe('/')
    const large=projectDraftPatch({...guide,launchCitations:Array.from({length:30},()=>({...guide.launchCitations[0],quote:'a'.repeat(5000)}))},draft)
    expect(large.projectPreparation!.citations).toHaveLength(12)
    expect(large.projectPreparation!.citations[0].quote).toHaveLength(3000)
  })
  it('permits incomplete named drafts and older tasks without project evidence',()=>{
    expect(experimentTaskDraftSchema.parse({title:'待整理'}).launchCommand).toBe('')
    expect(experimentTaskDraftSchema.parse({title:'旧任务'}).projectPreparation).toBeUndefined()
  })
})
describe('explicit data binding and launch readiness',()=>{
  it('finds only explicit absolute data directory arguments',()=>{
    expect(commandDataPath('python train.py --data-dir="/data/old set" --lr .1')?.path).toBe('/data/old set')
    expect(commandDataPath('python train.py --dataset imagenet')).toBeUndefined()
    expect(commandDataPath('python train.py --data relative/path')).toBeUndefined()
    expect(commandDataPath('python train.py --data /one --data-dir /two')).toBeUndefined()
    expect(commandDataPath('python train.py --data /one && echo done')).toBeUndefined()
    expect(commandDataPath('python train.py --data "$HOME/data"')).toBeUndefined()
  })
  it('updates only the chosen command argument and quotes shell characters',()=>{
    expect(syncCommandDataPath('python train.py --data /old --lr .1',"/new user's data")).toBe("python train.py --data '/new user'\\''s data' --lr .1")
  })
  it('round trips quoted paths and preserves simple parameter-engine-compatible paths',()=>{
    const command='python train.py --data /old --lr .1'
    expect(syncCommandDataPath(command,'/new/data')).toBe('python train.py --data /new/data --lr .1')
    for(const path of ["/new user's data",'/data/a b','/data/$literal'])expect(commandDataPath(syncCommandDataPath(command,path))?.path).toBe(path)
  })
  it('blocks unresolved launch placeholders only when asked to run',()=>{
    expect(projectLaunchIssue({launchCommand:'python train.py --data <DATA_PATH>'})).toContain('占位符')
    expect(projectLaunchIssue({codePath:'/path/to/project'})).toContain('占位符')
    expect(projectLaunchIssue({launchCommand:'python train.py --lr 0.01',codePath:'/workspace/train'})).toBeUndefined()
  })
})
