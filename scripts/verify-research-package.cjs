const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{spawnSync}=require('node:child_process'),{createHash}=require('node:crypto')
async function main(){
 const root=path.resolve(__dirname,'..'),resources=path.join(root,'release/win-unpacked/resources'),asar=path.join(resources,'app.asar'),requirePack=createRequire(path.join(asar,'package.json'))
 const pkg=requirePack('./package.json')
 if(pkg.version!==JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version)throw new Error('Wrong packaged version')
 const graphPath=requirePack.resolve('@langchain/langgraph')
 if(!graphPath.startsWith(asar+path.sep))throw new Error('LangGraph loaded outside the package')
 const {StateGraph,Annotation,START,END}=requirePack('@langchain/langgraph')
 const state=Annotation.Root({value:Annotation()})
 const graph=new StateGraph(state).addNode('step',s=>({value:s.value+1})).addEdge(START,'step').addEdge('step',END).compile()
 const result=await graph.invoke({value:1})
 if(result.value!==2)throw new Error('Packaged LangGraph could not execute')
 const engine=path.join(resources,'cangjie/parameter-engine.exe')
 const environment={...process.env};delete environment.CANGJIE_HOME
 const native=spawnSync(engine,[],{cwd:path.dirname(engine),input:'4\npython\ttrain.py\t--lr\t0.01\n--lr\t0.001\t0.0001\n--seed\t42\t43\n',encoding:'utf8',env:environment,windowsHide:true,timeout:10000})
 if(native.status!==0)throw new Error('Packaged Cangjie engine failed: '+native.stderr)
 const output=JSON.parse(native.stdout)
 if(output.count!==4||output.commands[3]!=='python train.py --lr 0.0001 --seed 43')throw new Error('Packaged expansion mismatch')
 const excess=spawnSync(engine,[],{cwd:path.dirname(engine),input:'1\npython\ttrain.py\n--seed\t1\t2\n',encoding:'utf8',env:environment,windowsHide:true,timeout:10000})
 if(excess.status!==1||!excess.stderr.includes('budget'))throw new Error('Native budget validation failed')
 const files=['out/main/index.js','out/preload/index.js','out/renderer/index.html',...fs.readdirSync(path.join(root,'out/renderer/assets')).map(name=>'out/renderer/assets/'+name)]
 for(const file of files){const source=fs.readFileSync(path.join(root,file)),packed=fs.readFileSync(path.join(asar,file));if(!source.equals(packed))throw new Error('Packaged file differs: '+file)}
 const verification={status:'passed',version:pkg.version,packagedLangGraph:true,nativeCangjieWithoutSdk:true,nativeBudgetCheck:true,matchedBuildFiles:files.length,engineSha256:createHash('sha256').update(fs.readFileSync(engine)).digest('hex')}
 fs.writeFileSync(path.join(root,'artifacts/research-package-verification.json'),JSON.stringify(verification,null,2));console.log(JSON.stringify(verification,null,2))
}
if(process.versions.electron){
 main().catch(error=>{console.error(error);process.exitCode=1})
}else{
 const root=path.resolve(__dirname,'..');
 const result=spawnSync(path.join(root,'release/win-unpacked/LabDeck Competition.exe'),[__filename],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true,timeout:30000});
 if(result.stdout)process.stdout.write(result.stdout);
 if(result.stderr)process.stderr.write(result.stderr);
 if(result.error)console.error(result.error);
 process.exitCode=result.status===0?0:1;
}

