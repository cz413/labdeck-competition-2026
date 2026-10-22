import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreparationTimeline } from './PreparationTimeline'
import type { PreparationView } from '@shared/preparation'

const base:PreparationView={id:'22222222-2222-4222-8222-222222222222',input:{serverId:'22222222-2222-4222-8222-222222222222',accessRouteId:'direct',path:'/repo',goal:'训练基线'},createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',revision:1,files:[],environments:[],dataCandidates:[],phase:'review',busy:false,pending:['wait'],trace:[]}
describe('preparation timeline measurements',()=>{
  it('does not replace unknown lifetime token usage with a partial recent trace',()=>{
    const view:PreparationView={...base,usage:{requests:2,elapsedMs:500},trace:[{id:'measured',kind:'model',name:'生成方案',status:'completed',startedAt:base.createdAt,summary:'已完成',usage:{requests:1,elapsedMs:100,promptTokens:100,completionTokens:30,totalTokens:130}}]}
    const html=renderToStaticMarkup(<PreparationTimeline view={view}/>)
    expect(html).toContain('Token <strong>未提供</strong>')
    expect(html).toContain('模型请求 <strong>2</strong>')
  })
  it('shows references and measured duration with details collapsed by default',()=>{
    const view:PreparationView={...base,trace:[{id:'read',kind:'tool',name:'读取项目文件',status:'completed',startedAt:base.createdAt,elapsedMs:12,summary:'已读取 README',references:[{path:'README.md',startLine:2,endLine:5}]}]}
    const html=renderToStaticMarkup(<PreparationTimeline view={view}/>)
    expect(html).toContain('README.md:2–5');expect(html).toContain('12 ms');expect(html).not.toContain('<details open')
  })
})
