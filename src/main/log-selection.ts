export interface DiagnosticLogChunk {text:string;label:string}
export function selectDiagnosticLog(chunks:DiagnosticLogChunk[]):{text:string;selectedErrors:boolean} {
  const blocks=chunks.filter(c=>c.text).filter((c,index,all)=>!all.slice(0,index).some(previous=>previous.text.endsWith(c.text)))
  const lines=blocks.map(chunk=>chunk.text.split(/\r?\n/))
  const selected=lines.map(()=>new Set<number>())
  let budget=220,selectedErrors=false
  const add=(block:number,start:number,end:number):void=>{for(let i=Math.max(0,start);i<Math.min(lines[block].length,end)&&budget>0;i++)if(!selected[block].has(i)){selected[block].add(i);budget--}}
  lines.forEach((block,index)=>{
    const trace=block.findIndex(line=>/Traceback \(most recent call last\)|Exception in thread/i.test(line))
    if(trace>=0){selectedErrors=true;add(index,trace-2,trace+55)}
    const errors=block.flatMap((line,i)=>/\b(?:error|exception|failed|failure)\b|out of memory|CUDA error|ModuleNotFound|FileNotFound/i.test(line)?[i]:[]).slice(0,5)
    if(errors.length)selectedErrors=true
    errors.forEach(i=>add(index,i-4,i+9))
  })
  if(lines.length)add(lines.length-1,Math.max(0,lines.at(-1)!.length-70),lines.at(-1)!.length)
  const output:string[]=[];let bytes=0
  for(let b=0;b<blocks.length;b++){
    const indices=[...selected[b]].sort((a,c)=>a-c)
    if(!indices.length)continue
    output.push(`[采集片段：${blocks[b].label}；以下行号相对本片段，省略处不代表日志连续]`)
    let last=-1
    for(const index of indices){
      if(output.length>=238)break
      const line=lines[b][index].slice(0,1000),size=Buffer.byteLength(line+'\n')
      if(bytes+size>63000)break
      if(last>=0&&index!==last+1)output.push('[中间日志已省略]')
      output.push(line);bytes+=size;last=index
    }
  }
  return {text:output.slice(0,240).join('\n'),selectedErrors}
}
