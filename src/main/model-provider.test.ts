import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseModelJson, requestModel, validateEndpoint } from './model-provider'
const settings={enabled:true,endpoint:'https://example.com/v1',model:'test-model'}
afterEach(()=>vi.unstubAllGlobals())
describe('model transport',()=>{
  it.each(['http://remote.example/v1','https://user:pass@example.com/v1','https://example.com/v1?key=secret','https://example.com/v1#fragment','file:///tmp/model'])('rejects unsafe credential transport: %s',url=>expect(()=>validateEndpoint(url)).toThrow())
  it('accepts HTTPS and local development endpoints',()=>{
    expect(validateEndpoint('https://example.com/v1/')).toBe('https://example.com/v1')
    expect(validateEndpoint('http://127.0.0.1:11434/v1')).toContain('127.0.0.1')
  })
  it('parses JSON and fenced JSON but rejects prose',()=>{
    expect(parseModelJson('```json\n{"ok":true}\n```')).toEqual({ok:true})
    expect(()=>parseModelJson('Here is the answer: {"ok":true}')).toThrow()
  })
  it('sends redacted evidence and never follows redirects',async()=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}),{status:200}))
    vi.stubGlobal('fetch',fetch)
    expect(await requestModel(settings,'provider-secret','system',{log:'password=log-secret'})).toEqual({ok:true})
    const call=fetch.mock.calls[0] as unknown as [string,RequestInit]
    expect(call[0]).toBe('https://example.com/v1/chat/completions')
    expect(call[1].redirect).toBe('error')
    expect(call[1].body).not.toContain('log-secret')
    expect(call[1].body).not.toContain('provider-secret')
  })
  it('forwards cancellation to the actual HTTP transport',async()=>{
    const controller=new AbortController()
    vi.stubGlobal('fetch',vi.fn(async(_url:string,options:RequestInit)=>{
      const signal=options.signal as AbortSignal
      controller.abort();expect(signal.aborted).toBe(true);signal.throwIfAborted();return new Response('')
    }))
    await expect(requestModel(settings,'','system',{},controller.signal)).rejects.toThrow()
  })
  it('does not echo provider error bodies or keys',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('api-key=provider-secret',{status:401})))
    await expect(requestModel(settings,'provider-secret','system',{})).rejects.toThrow('HTTP 401')
  })
})

// Structured calls must leave enough room for the JSON body and never hide retries.
describe('structured model output budgets',()=>{
  it('leaves repository analysis uncapped and adapts only the official DeepSeek API',async()=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"ready":true}'},finish_reason:'stop'}]}),{status:200}))
    vi.stubGlobal('fetch',fetch)
    await requestModel({enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash'},'','JSON',{},undefined,undefined,{purpose:'repository'})
    const body=JSON.parse((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body as string)
    expect(body).toMatchObject({thinking:{type:'disabled'},response_format:{type:'json_object'}})
    expect(body).not.toHaveProperty('max_tokens')
    await requestModel({...settings,model:'deepseek-flash'},'','JSON',{})
    const other=JSON.parse((fetch.mock.calls[1] as unknown as [string,RequestInit])[1].body as string)
    expect(other.max_tokens).toBe(4096)
    expect(other).not.toHaveProperty('thinking')
    expect(other).not.toHaveProperty('response_format')
  })
  it('reports truncation even when reasoning consumed the whole response and content is null',async()=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({usage:{completion_tokens:8192,total_tokens:9000},choices:[{message:{content:null,reasoning_content:'not a final answer'},finish_reason:'length'}]}),{status:200}))
    vi.stubGlobal('fetch',fetch)
    const usage=vi.fn()
    await expect(requestModel(settings,'','JSON',{},undefined,usage,{purpose:'repository'})).rejects.toThrow('服务端截断')
    expect(fetch).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requests:1,completionTokens:8192,totalTokens:9000}))
  })
  it('never accepts or repairs a truncated JSON object as a valid result',async()=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"ready":true}'},finish_reason:'length'}]}),{status:200}))
    vi.stubGlobal('fetch',fetch)
    await expect(requestModel(settings,'','JSON',{})).rejects.toThrow('截断')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('explains empty final output without exposing reasoning content',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'',reasoning_content:'private reasoning'},finish_reason:'stop'}]}),{status:200})))
    await expect(requestModel(settings,'','JSON',{})).rejects.toThrow('没有返回可用的 JSON')
  })
})
