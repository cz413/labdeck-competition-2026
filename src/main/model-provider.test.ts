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
