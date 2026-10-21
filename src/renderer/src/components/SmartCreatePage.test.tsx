import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerProfile } from '@shared/types'
import { SmartCreatePage } from './SmartCreatePage'

const server: ServerProfile = {
  id: '22222222-2222-4222-8222-222222222222', name: '验证节点', host: '192.0.2.8', port: 22,
  username: 'fixture', authType: 'password', mode: 'real', monitorPolicy: 'manual', hasSecret: false,
  tags: [], group: 'test', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
}

describe('smart create start view', () => {
  it('asks only for a project location and an intent', () => {
    const html = renderToStaticMarkup(<SmartCreatePage
      active tasks={[]} servers={[server]} modelEnabled seed={null}
      onModelSettings={() => {}} onExit={() => {}} onManualCreate={() => {}} onChanged={() => {}}
      onCreated={() => {}} onOpenTask={() => {}} onEditFullConfig={() => {}}
      notify={() => {}} confirm={async () => true} onTrusted={async () => {}}
    />)
    expect(html).toContain('项目位置')
    expect(html).toContain('想做什么')
    expect(html).toContain('分析项目并准备实验')
    expect(html).toContain('实验目标')
    expect(html).not.toContain('aria-label="任务名称"')
    expect(html).not.toContain('aria-label="数据目录"')
    expect(html).not.toContain('实验配置')
  })
})
