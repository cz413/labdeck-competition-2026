import { describe, expect, it } from 'vitest'
import type { RepositoryGuide, RepositorySnapshot } from './repository-guide'
import {
  createExperimentPlan, experimentDraftChanges, experimentModeFromGoal, markUserFields,
  planEntryOptions, planGaps, planLaunchCitations, projectSignals, recommendProjectFiles,
  resolvePlanGap, switchPlanMode
} from './experiment-plan'
import type { CondaEnvironmentInfo } from './types'
import { projectConfigurationKey } from './project-task'

const serverId = '22222222-2222-4222-8222-222222222222'
const now = new Date('2026-03-04T05:06:07Z')
const files = ['README.md', 'requirements.txt', 'environment.yml', 'configs/base.yaml', 'train.py', 'evaluate.py', 'utils/data.py']
const readme = [
  '# Demo',
  '',
  '## 训练',
  '```bash',
  'python train.py --config configs/base.yaml --data /data/train --epochs 100',
  '```',
  '',
  '## 评估',
  '```bash',
  'python evaluate.py --checkpoint weights/model.pth --data /data/val',
  '```',
  '',
  '本地数据放在 data/raw 目录。',
  '评估指标包括 Accuracy、F1 和 Loss。'
].join('\n')
const environment = 'name: vision\nchannels: [defaults]\ndependencies:\n  - python=3.10\n'
const snapshot: RepositorySnapshot = {
  input: { source: 'remote', serverId, accessRouteId: 'direct', path: '/repo/' },
  files: files.map(path => ({ path, sizeBytes: 100 })),
  excerpts: [
    { path: 'README.md', startLine: 1, text: readme, truncated: false },
    { path: 'environment.yml', startLine: 1, text: environment, truncated: false }
  ],
  warnings: [],
  collectedAt: now.toISOString()
}
const guide: RepositoryGuide = {
  status: 'ready_for_review', summary: '项目提供训练与评估两种方式。',
  steps: [], launchCommand: 'python train.py --config configs/base.yaml --data /data/train --epochs 100',
  launchOrigin: 'documented', launchCitations: [{ path: 'README.md', startLine: 5, endLine: 5, quote: 'python train.py --config configs/base.yaml --data /data/train --epochs 100' }],
  launchSources: ['README.md'], workingDirectory: '', environmentName: 'vision', dataPath: '/data/train',
  missingInputs: [], questions: ['是否已经准备好预训练权重？'], warnings: ['环境名从 environment.yml 读取，仍需在任务池核对', '数据目录从启动命令参数读取：/data/train，仍需核对'],
  checks: [
    { path: '.', expected: 'directory', status: 'confirmed', message: 'exists' },
    { path: 'train.py', expected: 'file', status: 'confirmed', message: 'exists' }
  ], snapshot
}
const plan = (envs: CondaEnvironmentInfo[] = []) => createExperimentPlan({ guide, goal: '先跑一次基线', environments: envs, now })
const environments: CondaEnvironmentInfo[] = [{ name: 'vision', prefix: '/opt/conda/envs/vision' }, { name: 'torch24', prefix: '/opt/conda/envs/torch24' }]

describe('project signals', () => {
  it('reads entries, configs, dependencies, data hints and explicit metrics', () => {
    const signals = projectSignals(snapshot)
    expect(signals.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'train.py', kind: 'train' }),
      expect.objectContaining({ path: 'evaluate.py', kind: 'evaluate' })
    ]))
    expect(signals.configs).toContain('configs/base.yaml')
    expect(signals.dependencyFiles).toEqual(expect.arrayContaining(['environment.yml', 'requirements.txt']))
    expect(signals.metrics.map(metric => metric.key)).toEqual(expect.arrayContaining(['accuracy', 'f1', 'loss']))
    expect(signals.metrics.find(metric => metric.key === 'accuracy')?.citation.path).toBe('README.md')
    expect(signals.dataDirs).toEqual(expect.arrayContaining(['data/raw']))
    expect(signals.hasReadme).toBe(true)
  })
  it('defaults the reading scope to explanations, entry points and configs', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ path: `experiments/exp${index}/notes.md`, sizeBytes: 10 }))
    const picked = recommendProjectFiles([...snapshot.files, ...many], '评估已有权重')
    expect(picked).toContain('README.md')
    expect(picked).toContain('evaluate.py')
    expect(picked).toContain('configs/base.yaml')
    expect(picked.length).toBeLessThanOrEqual(40)
  })
})

describe('building the plan', () => {
  it('recognizes an absolute Conda prefix without treating it as an environment name', () => {
    const value = createExperimentPlan({guide: {...guide, environmentName: environments[0].prefix}, goal: '训练', environments, now})
    expect(value.draft.condaEnvironment).toMatchObject({environmentPrefix: environments[0].prefix})
    expect(value.draft.condaEnvironment?.environmentName).toBeUndefined()
    expect(value.fields.environment?.source).toBe('server')
  })

  it('turns the analysis into a reviewed draft with sources', () => {
    const value = plan()
    expect(value.mode).toBe('train')
    expect(value.draft).toMatchObject({
      title: 'repo · 训练基线', project: 'repo', objective: '先跑一次基线', codePath: '/repo',
      launchCommand: guide.launchCommand, dataPath: '/data/train', artifactPath: expect.stringContaining('/repo/runs/exp-')
    })
    expect(value.fields.launchCommand?.source).toBe('file')
    expect(value.fields.codePath?.source).toBe('server')
    expect(value.fields.dataPath?.source).toBe('file')
    expect(value.fields.environment?.source).toBe('file')
    expect(value.draft.projectPreparation?.summary).toBe(guide.summary)
    expect(value.draft.projectPreparation?.configurationKey).toBe(projectConfigurationKey(value.draft))
  })
  it('offers a documented evaluation entry with a reason', () => {
    const options = planEntryOptions(snapshot, guide, '先跑一次基线')
    const evaluate = options.find(option => option.mode === 'evaluate')
    expect(evaluate).toMatchObject({ command: 'python evaluate.py --checkpoint weights/model.pth --data /data/val', origin: 'documented' })
    expect(evaluate?.reason).toContain('评估')
    expect(evaluate?.citation?.startLine).toBe(10)
  })
  it('does not pair an evaluation goal with the training command from the analysis', () => {
    const evaluate = createExperimentPlan({ guide, goal: '评估已有权重', now })
    expect(evaluate.mode).toBe('evaluate')
    expect(evaluate.draft.launchCommand).toBe('python evaluate.py --checkpoint weights/model.pth --data /data/val')
    expect(evaluate.draft.title).toBe('repo · 评估已有权重')
    expect(planLaunchCitations(evaluate)[0]?.path).toBe('README.md')
  })
  it('switches between training and evaluation without a model call', () => {
    const value = plan()
    const switched = switchPlanMode(value, 'evaluate')
    expect(switched.mode).toBe('evaluate')
    expect(switched.draft.launchCommand).toBe('python evaluate.py --checkpoint weights/model.pth --data /data/train')
    expect(switched.draft.title).toBe('repo · 评估已有权重')
    expect(switched.draft.objective).toBe('评估已有权重')
    expect(switched.draft.projectPreparation?.configurationKey).toBe(projectConfigurationKey(switched.draft))
    expect(switched.draft.projectPreparation?.citations[0]?.startLine).toBe(10)
    expect(switched.change?.summary).toContain('评估已有权重')
    const back = switchPlanMode({ ...value, mode: switched.mode, draft: switched.draft, fields: switched.fields }, 'train')
    expect(back.draft.objective).toBe('先跑一次基线')
  })
  it('keeps manual edits and asks before replacing them', () => {
    const value = plan()
    const edited = { ...value, draft: { ...value.draft, launchCommand: 'python custom.py' }, fields: markUserFields(value.fields, [{ field: 'launchCommand', label: '启动命令', before: '', after: 'python custom.py' }]) }
    const result = switchPlanMode(edited, 'evaluate')
    expect(result.mode).toBe('train')
    expect(result.conflict).toBeDefined()
    expect(result.conflict!).toMatchObject({ label: '运行方式', current: 'python custom.py' })
    expect(result.conflict!.suggestedMode).toBe('evaluate')
    expect({ ...edited.draft, ...result.conflict!.suggestedDraft }.launchCommand).toBe('python evaluate.py --checkpoint weights/model.pth --data /data/train')
  })
})

describe('gaps and focused questions', () => {
  it('asks only for the missing pieces', () => {
    const value = plan(environments)
    const withoutData = { ...value, draft: { ...value.draft, dataPath: '' }, fields: { ...value.fields, dataPath: undefined } }
    const gaps = planGaps(withoutData, { environments, dataCandidates: [{ path: '/data/train', source: 'server', note: '已确认存在' }] })
    expect(gaps.map(gap => gap.kind)).toEqual(['data'])
    expect(gaps[0].options[0]).toMatchObject({ label: '/data/train', source: 'server' })
    expect(gaps[0].allowBrowse).toBe(true)
  })
  it('offers environments from the server and a no-conda option', () => {
    const value = plan()
    const gap = planGaps({ ...value, draft: { ...value.draft, condaEnvironment: undefined } }, { environments }).find(item => item.kind === 'environment')!
    expect(gap.options.map(option => option.value)).toEqual(['vision', 'torch24', ''])
    expect(gap.detail).toContain('Conda')
  })
  it('does not ask again after the user explicitly chooses the server default', () => {
    const value = plan()
    const withoutEnvironment = { ...value, draft: { ...value.draft, condaEnvironment: undefined }, fields: { ...value.fields, environment: undefined } }
    const gap = planGaps(withoutEnvironment, { environments }).find(item => item.kind === 'environment')!
    const resolved = resolvePlanGap(withoutEnvironment, gap, { id: 'env-none', label: '服务器默认环境', value: '', source: 'suggested' })
    expect(planGaps({ ...withoutEnvironment, draft: resolved.draft, fields: resolved.fields }, { environments }).some(item => item.kind === 'environment')).toBe(false)
  })
  it('applies a data answer and keeps the command argument in sync', () => {
    const value = plan(environments)
    const gap = planGaps({ ...value, draft: { ...value.draft, dataPath: '' } }, { environments }).find(item => item.kind === 'data')!
    const resolved = resolvePlanGap(value, gap, { id: 'data', label: '/data/actual', value: '/data/actual', source: 'server' })
    expect(resolved.draft.dataPath).toBe('/data/actual')
    expect(resolved.draft.launchCommand).toContain('--data /data/actual')
    expect(resolved.change.summary).toContain('同步')
  })
})

describe('draft changes', () => {
  it('reports changes between drafts so user edits can be kept', () => {
    const value = plan()
    const after = { ...value.draft, dataPath: '/data/actual', launchCommand: 'python custom.py' }
    const changes = experimentDraftChanges(value.draft, after)
    expect(changes.map(change => change.field)).toEqual(['launchCommand', 'dataPath'])
    const fields = markUserFields(value.fields, changes)
    expect(fields.launchCommand?.source).toBe('user')
    expect(fields.dataPath?.source).toBe('user')
  })
})
