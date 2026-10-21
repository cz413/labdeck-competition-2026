import { useEffect, useState } from 'react'
import type { ModelSettings } from '@shared/intelligence'

export function ModelSettingsPanel(): React.JSX.Element {
  const [settings,setSettings]=useState<ModelSettings|null>(null)
  const [apiKey,setApiKey]=useState(''),[clearKey,setClearKey]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  useEffect(()=>{let live=true;void window.labApi.intelligence.settings().then(s=>{if(live)setSettings(s)}).catch(e=>{if(live)setMessage(String(e))});return()=>{live=false}},[])
  async function save(test=false):Promise<void>{
    if(!settings)return
    setBusy(true);setMessage('')
    try{const saved=await window.labApi.intelligence.saveSettings({...settings,apiKey:apiKey||undefined,clearApiKey:clearKey});setSettings(saved);setApiKey('');setClearKey(false);setMessage(test?await window.labApi.intelligence.testModel():'模型配置已保存')}
    catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  return <section className="panel settings-panel project-model-settings"><div className="panel-title"><div><h3>模型服务</h3><p>用于从项目生成配置与对照实验分析，调用由你主动发起。</p></div></div>
    {!settings?<p role="status">{message||'正在读取模型配置…'}</p>:<fieldset disabled={busy}><label className="experiment-conda-toggle"><input type="checkbox" checked={settings.enabled} onChange={e=>setSettings({...settings,enabled:e.target.checked})}/><span>启用模型辅助</span></label><div className="form-grid">
      <label className="field"><span>API 基础地址</span><input value={settings.endpoint} onChange={e=>setSettings({...settings,endpoint:e.target.value})} placeholder="https://模型服务地址/v1"/><small>应用自动追加 /chat/completions。</small></label>
      <label className="field"><span>模型名称</span><input value={settings.model} onChange={e=>setSettings({...settings,model:e.target.value})}/></label>
      <label className="field field-wide"><span>API 密钥</span><input type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={settings.hasApiKey?'已保存密钥；留空保留':'无认证的本机服务可留空'}/></label>
      {settings.hasApiKey&&<label className="experiment-conda-toggle field-wide"><input type="checkbox" checked={clearKey} onChange={e=>setClearKey(e.target.checked)}/><span>清除已保存密钥</span></label>}
    </div><div className="project-assistant-actions"><button className="primary-button" onClick={()=>void save()}>保存模型配置</button><button className="secondary-button" disabled={!settings.enabled} onClick={()=>void save(true)}>保存并测试连接</button></div><p role="status">{message}</p></fieldset>}
  </section>
}
