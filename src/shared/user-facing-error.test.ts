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
  it('translates stored running notices while preserving their status context',()=>{
    expect(userFacingError('运行中 · 状态暂不可读：Connection lost before handshake')).toBe('运行中 · 状态暂不可读：SSH 连接在握手完成前中断，请检查网络、SSH 端口及跳板机连接后重试。')
    expect(userFacingError('运行中 · 状态暂不可读：Unexpected protocol failure')).not.toContain('Unexpected')
  })
  it('does not mistake an experiment value for an HTTP error', () => {
    expect(userFacingError('上限为 429 组，请调整数量')).toBe('上限为 429 组，请调整数量')
    expect(userFacingError('HTTP 429 Too Many Requests')).toContain('请求过于频繁')
  })
  it.each([
    ['Connection lost before handshake','SSH 连接在握手完成前中断'],
    ['连接失败：Connection lost before handshake','SSH 连接在握手完成前中断'],
    ['Timed out while waiting for handshake','SSH 连接握手超时'],
    ['连接失败：Timed out while waiting for handshake','SSH 连接握手超时'],
    ['Error invoking remote method \'monitor:snapshot\': Error: Timed out while waiting for handshake','SSH 连接握手超时'],
    ['All configured authentication methods failed','SSH 认证失败'],
    ['Permission denied (publickey,password)','SSH 认证失败'],
    ['Host key verification failed','服务器身份校验未通过'],
    ['Handshake failed: no matching key exchange algorithm','SSH 加密协商失败'],
    ['EPIPE: write failed','连接已中断'],
    ['No route to host','无法访问服务器'],
    ['EnvironmentNameNotFound: Could not find conda environment: myenv','Conda 环境不存在'],
    ['bash: conda: command not found','所需命令未找到'],
    ['读取失败：request timed out','请求超时']
  ])('translates operational warnings including mixed Chinese/English: %s',(raw,expected)=>{
    expect(userFacingError(raw)).toContain(expected)
  })
  it('hides unknown English details even when prefixed by a Chinese error label',()=>{
    expect(userFacingError('连接失败：Unexpected protocol failure','请检查连接配置。')).toBe('请检查连接配置。')
    expect(userFacingError('请先安装 PyTorch，再运行 python main.py。')).toBe('请先安装 PyTorch，再运行 python main.py。')
  })

})
