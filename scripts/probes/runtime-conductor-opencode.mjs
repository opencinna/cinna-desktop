import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { ConductorMcpServer } from '../../src/main/services/conductorMcpServer.ts'
// node --experimental-strip-types scripts/probes/runtime-conductor-opencode.mjs /path/to/opencode
// Local SSE fake provider only; HOME/config/data/cwd are temporary and removed.
const binary=process.argv[2]
if(!binary)throw new Error('Pass the installed OpenCode executable path as the only argument.')
const home = mkdtempSync(join(tmpdir(), 'cinna-opencode-conductor-probe-'))
const cwd = join(home, 'chat-one'), secondCwd=join(home,'chat-two'), utilityCwd=join(home,'utility'), configDir=join(home,'config')
for(const dir of [cwd,secondCwd,utilityCwd,configDir])mkdirSync(dir)
writeFileSync(join(cwd,'AGENTS.md'),'Chat mode instructions. CHAT_ONE_ONLY_MARKER. No file access.\n')
writeFileSync(join(secondCwd,'AGENTS.md'),'Chat mode instructions. CHAT_TWO_ONLY_MARKER. No file access.\n')
writeFileSync(join(utilityCwd,'AGENTS.md'),'Utility instructions only.\n')
const evidence={binaryVersion:null,isolatedHome:true,isolatedCwd:true,apiCredentialEnvInherited:false,realProviderRequests:0,initialize:null,sessionNew:null,models:[],providerResolutions:0,mcpCalls:[],updates:[],refresh:null,utility:null,stderrSummary:[]}
let generation=0,turn=0,slowPrompt,slowSessionId,markSlowStarted;const slowStarted=new Promise(r=>markSlowStarted=r);evidence.callMetadata=[];evidence.toolCallShapes=[];evidence.cancel={signalObserved:false};
const toolName=()=>generation===2?'probe_slow':generation?'probe_refresh':'probe'
const mcp=new ConductorMcpServer()
const session=await mcp.ensureSession('probe',{beforeCall:ctx=>{evidence.callMetadata.push({name:ctx.name,metaKeys:Object.keys(ctx.meta??{})})},getProviders:()=>{evidence.providerResolutions++;return[{providerType:'mcp',displayName:'Probe',getTools:()=>[{name:toolName(),description:'Return deterministic OK.',inputSchema:{type:'object',properties:{}},mcpProviderId:'probe',providerType:'mcp'}],callTool:async(name,_input,options)=>{evidence.mcpCalls.push({name});if(name==='probe_slow'){markSlowStarted();await new Promise(resolve=>{const timer=setTimeout(resolve,5000);options.signal.addEventListener('abort',()=>{evidence.cancel.signalObserved=true;clearTimeout(timer);resolve()},{once:true})})}return {content:'OK'}}}]}})
const model=createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part
 let body;try{body=JSON.parse(raw)}catch{res.writeHead(400);res.end();return}
 const names=(body.tools??[]).map(t=>t.function?.name??t.name)
 const messages=body.messages??[]
 const last=messages.at(-1)
 evidence.models.push({path:req.url,toolNames:names,messageRoles:messages.map(m=>m.role),hasChatOneMarker:JSON.stringify(messages).includes('CHAT_ONE_ONLY_MARKER'),hasChatTwoMarker:JSON.stringify(messages).includes('CHAT_TWO_ONLY_MARKER'),hasChatInstructions:messages.some(m=>typeof m.content==='string'&&m.content.includes('Chat mode instructions')),hasUtilityInstructions:messages.some(m=>typeof m.content==='string'&&m.content.includes('Utility instructions only'))})
 const expected=names.find(name=>name.endsWith(toolName()))
 const useTool=expected&&last?.role!=='tool'&&!JSON.stringify(last).includes('without tools')
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
 const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'chatcmpl-probe',object:'chat.completion.chunk',created:1,model:'probe-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`)
 if(useTool){chunk({role:'assistant',tool_calls:[{index:0,id:`call_${++turn}`,type:'function',function:{name:expected,arguments:'{}'}}]});chunk({},'tool_calls')}
 else {chunk({role:'assistant',content:'OK'});chunk({},'stop')}
 res.end('data: [DONE]\n\n')
})
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve))
const port=model.address().port
const config={enabled_providers:['probe'],model:'probe/probe-model',provider:{probe:{npm:'@ai-sdk/openai-compatible',name:'Loopback fake model',options:{baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'not-a-real-key'},models:{'probe-model':{name:'Probe',limit:{context:32000,output:1000}}}}},agent:{chat:{mode:'primary',prompt:'Chat mode instructions.',permission:{'*':'deny','cinna_*':'allow'}},utility:{mode:'primary',prompt:'Utility instructions only.',permission:{'*':'deny'}}}}
writeFileSync(join(configDir,'opencode.json'),JSON.stringify(config))
const env=Object.fromEntries(['PATH','USER','LOGNAME','SHELL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
Object.assign(env,{HOME:home,XDG_CONFIG_HOME:join(home,'xdg-config'),XDG_DATA_HOME:join(home,'xdg-data'),XDG_CACHE_HOME:join(home,'xdg-cache'),OPENCODE_CONFIG:join(configDir,'opencode.json'),OPENCODE_CONFIG_DIR:configDir,OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1'})
evidence.binaryVersion=spawnSync(binary,['--version'],{cwd,env,encoding:'utf8',timeout:10000}).stdout?.trim()??null
const child=spawn(binary,['acp'],{cwd,env,stdio:['pipe','pipe','pipe'],detached:true})
let stderr='';child.stderr.on('data',d=>{stderr=(stderr+d).slice(-8000)})
const pending=new Map();let id=0
const lines=createInterface({input:child.stdout})
lines.on('line',line=>{let msg;try{msg=JSON.parse(line)}catch{return}
 if(msg.id!==undefined&&(msg.result!==undefined||msg.error)){const p=pending.get(msg.id);if(p){clearTimeout(p.timer);pending.delete(msg.id);p.resolve(msg)}}
 else if(msg.method==='session/update'){const update=msg.params?.update;const kind=update?.sessionUpdate;if(kind==='tool_call')evidence.toolCallShapes.push(Object.fromEntries(['sessionUpdate','toolCallId','title','kind','status','rawInput','_meta'].filter(k=>update[k]!==undefined).map(k=>[k,update[k]])));if(kind&&!evidence.updates.includes(kind))evidence.updates.push(kind)}
 else if(msg.id!==undefined)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{outcome:{outcome:'cancelled'}}})+'\n')
})
function rpc(method,params){const requestId=++id;return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(requestId);resolve({error:{code:'timeout',message:method}})},25000);pending.set(requestId,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n')})}
function result(value){return value.error?{errorCode:value.error.code,errorMessage:String(value.error.message).replaceAll(home,'<throwaway>')}:{success:true,...(value.result.stopReason?{stopReason:value.result.stopReason}:{})}}
try{
 const init=await rpc('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'cinna-conductor-probe',version:'1'}});evidence.initialize=result(init)
 if(!init.error){
 const made=await rpc('session/new',{cwd,mcpServers:[session.descriptor]});evidence.sessionNew=result(made)
 if(!made.error){const sid=made.result.sessionId;evidence.mode=result(await rpc('session/set_config_option',{sessionId:sid,configId:'mode',value:'chat'}));
 evidence.prompt=result(await rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'Call the probe tool once, then return OK.'}]}))
 generation=1;await session.refreshTools();await new Promise(r=>setTimeout(r,500))
 evidence.refresh=result(await rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'Call the probe_refresh tool once, then return OK.'}]}))
 generation=2;await session.refreshTools();await new Promise(r=>setTimeout(r,300));slowSessionId=sid;slowPrompt=rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'Call probe_slow.'}]});await Promise.race([slowStarted,new Promise(r=>setTimeout(r,5000))])
 }
 const madeUtility=await rpc('session/new',{cwd:utilityCwd,mcpServers:[]});evidence.utility={sessionNew:result(madeUtility)}
 if(!madeUtility.error){const sid=madeUtility.result.sessionId;evidence.utility.mode=result(await rpc('session/set_config_option',{sessionId:sid,configId:'mode',value:'utility'}));evidence.utility.prompt=result(await rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'Return OK.'}]}))}
 }
 if(slowPrompt){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'session/cancel',params:{sessionId:slowSessionId}})+'\n');evidence.cancel.prompt=result(await slowPrompt);await new Promise(r=>setTimeout(r,250));}
 const second=await rpc('session/new',{cwd:secondCwd,mcpServers:[session.descriptor]});evidence.secondChat={sessionNew:result(second)};if(!second.error){const sid=second.result.sessionId;await rpc('session/set_config_option',{sessionId:sid,configId:'mode',value:'chat'});evidence.secondChat.prompt=result(await rpc('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'Return OK without tools.'}]}))}
 evidence.stderrSummary=stderr.split('\n').filter(l=>/error|failed/i.test(l)).map(l=>l.replaceAll(home,'<throwaway>').replaceAll(String(port),'<loopback-port>')).slice(-5)
 console.log(JSON.stringify(evidence,null,2))
}finally{for(const {timer}of pending.values())clearTimeout(timer);try{process.kill(-child.pid,'SIGTERM')}catch{};await mcp.dispose();model.closeAllConnections();await new Promise(r=>model.close(r));lines.close();await new Promise(r=>{child.once('exit',r);setTimeout(r,1500).unref()});try{process.kill(-child.pid,'SIGKILL')}catch{};rmSync(home,{recursive:true,force:true})}
