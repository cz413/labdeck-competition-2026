import { describe, expect, it } from 'vitest'
import { userFacingError } from './user-facing-error'

describe('user-facing errors', () => {
  it('retains a concrete actionable reason after removing the IPC wrapper', () => {
    expect(userFacingError(new Error("Error invoking remote method 'research:removeBatch': Error: 本批任务正在运行，请先取消运行"))).toBe('本批任务正在运行，请先取消运行')
    expect(userFacingError('参数 --epoch 不受支持，请改为 --num_epochs。')).toContain('--num_epochs')
  })
  it('replaces internal validation payloads with the supplied operation message', () => {
    expect(userFacingError(`Error invoking remote method 'research:create': [{"code":"invalid_type","expected":"boolean"}]`, '方案未能生成，请检查配置。')).toBe('方案未能生成，请检查配置。')
  })
  it.each(['异常退出：启动命令返回退出码 1', 'Process exited with code 2', 'exitCode=1', 'exit_code=1'])('does not expose runtime codes: %s', text => {
    expect(userFacingError(text, '运行遇到问题，请查看诊断。')).toBe('运行遇到问题，请查看诊断。')
  })
  it('keeps actionable details when only a technical suffix is removed', () => {
    expect(userFacingError('数据文件不存在；退出码 1')).toBe('数据文件不存在；')
  })
  it('translates known file and connection errors without exposing stacks', () => {
    expect(userFacingError("ENOENT: no such file or directory, open '/private/file'" )).toBe('文件或目录不存在，请检查所选路径。')
    expect(userFacingError('connect ECONNREFUSED 127.0.0.1:7897')).toContain('连接未成功')
    expect(userFacingError('EACCES: permission denied')).toContain('没有权限')
  })
  it('does not mistake an experiment value for an HTTP error', () => {
    expect(userFacingError('上限为 429 组，请调整数量')).toBe('上限为 429 组，请调整数量')
    expect(userFacingError('HTTP 429 Too Many Requests')).toContain('请求过于频繁')
  })
})
