import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { ConductorMcpServer } from '../../src/main/services/conductorMcpServer.ts'
// node --experimental-strip-types scripts/probes/handover-folder-opencode.mjs /path/to/opencode
// Local SSE fake provider only; HOME/config/data/cwd are temporary and removed.
const binary=process.argv[2]
if(!binary)throw new Error('Pass the installed OpenCode executable path as the only argument.')
const home = mkdtempSync(join(tmpdir(), 'cinna-opencode-conductor-probe-'))
const cwd = join(home, 'work'), configDir = join(home, 'config')
for (const directory of [cwd, configDir]) mkdirSync(directory)
writeFileSync(join(cwd, 'AGENTS.md'), 'Native folder handover probe.\n')
const evidence = { binaryVersion: null, models: [], mcpCalls: [], toolCallShapes: [] }
let turn = 0
const mcp = new ConductorMcpServer()
const session = await mcp.ensureSession('handover-probe', { getProviders: () => [{
  providerType: 'mcp', displayName: 'Handover probe',
  getTools: () => [{ name: 'probe', description: 'Return deterministic OK.', inputSchema: { type: 'object', properties: {} }, mcpProviderId: 'probe', providerType: 'mcp' }],
  callTool: async (name) => { evidence.mcpCalls.push(name); return { content: 'OK' } }
}] })
const model=createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part
 let body;try{body=JSON.parse(raw)}catch{res.writeHead(400);res.end();return}
 const names=(body.tools??[]).map(t=>t.function?.name??t.name)
 const messages=body.messages??[]
 const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block=>block.text??'').join('\n') : ''
 const last=messages.at(-1)
 evidence.models.push({toolNames:names})
 const writing = contentText(last?.content).includes('OUTSIDE_WRITE')
 const expected=names.find(name=>writing ? name === 'write' : name.endsWith('probe'))
 const useTool=expected&&last?.role!=='tool'&&!JSON.stringify(last).includes('without tools')
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
 const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'chatcmpl-probe',object:'chat.completion.chunk',created:1,model:'probe-model',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`)
 if(useTool){chunk({role:'assistant',tool_calls:[{index:0,id:`call_${++turn}`,type:'function',function:{name:expected,arguments:writing ? JSON.stringify({filePath:join(home,'outside.txt'),content:'HANDOVER_WRITE_OK'}) : '{}'}}]});chunk({},'tool_calls')}
 else {chunk({role:'assistant',content:'OK'});chunk({},'stop')}
 res.end('data: [DONE]\n\n')
})
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve))
const port=model.address().port
const config = {
 enabled_providers: ['probe'], model: 'probe/probe-model',
 provider: { probe: { npm: '@ai-sdk/openai-compatible', name: 'Loopback fake model', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'not-a-real-key' }, models: { 'probe-model': { name: 'Probe', limit: { context: 32000, output: 1000 } } } } },
 agent: { chat: { mode: 'primary', prompt: 'Native folder handover probe.', permission: { '*': 'ask', 'cinna_*': 'allow' } } }
}
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
 else if(msg.method==='session/update'){const update=msg.params?.update;const kind=update?.sessionUpdate;if(kind==='tool_call')evidence.toolCallShapes.push(Object.fromEntries(['sessionUpdate','toolCallId','title','kind','status','rawInput','_meta'].filter(k=>update[k]!==undefined).map(k=>[k,update[k]])));}
 else if(msg.id!==undefined){evidence.permissions??=[];evidence.permissions.push({method:msg.method,kind:msg.params?.toolCall?.kind,title:String(msg.params?.toolCall?.title??'').replaceAll(home,'<throwaway>')});const option=msg.params?.options?.find(o=>o.kind==='allow_once');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:option?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}}})+'\n')}
})
function rpc(method,params){const requestId=++id;return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(requestId);resolve({error:{code:'timeout',message:method}})},25000);pending.set(requestId,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n')})}
function result(value){return value.error?{errorCode:value.error.code,errorMessage:String(value.error.message).replaceAll(home,'<throwaway>')}:{success:true,...(value.result.stopReason?{stopReason:value.result.stopReason}:{})}}
try {
 const init=await rpc('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'cinna-handover-probe',version:'1'}})
 assert.ok(!init.error)
 const made=await rpc('session/new',{cwd,mcpServers:[session.descriptor]})
 assert.ok(!made.error)
 const sessionId=made.result.sessionId
 await rpc('session/set_config_option',{sessionId,configId:'mode',value:'chat'})
 evidence.writePrompt=result(await rpc('session/prompt',{sessionId,prompt:[{type:'text',text:'OUTSIDE_WRITE: use write to create the sibling file.'}]}))
 evidence.outsideWritten=existsSync(join(home,'outside.txt'))&&readFileSync(join(home,'outside.txt'),'utf8')==='HANDOVER_WRITE_OK'
 evidence.first=result(await rpc('session/prompt',{sessionId,prompt:[{type:'text',text:'Call cinna probe.'}]}))
 evidence.loaded=result(await rpc('session/load',{sessionId,cwd,mcpServers:[session.descriptor]}))
 await rpc('session/set_config_option',{sessionId,configId:'mode',value:'chat'})
 evidence.afterLoad=result(await rpc('session/prompt',{sessionId,prompt:[{type:'text',text:'Call cinna probe again after loading.'}]}))
 evidence.nativeToolsOffered=evidence.models.some(turn=>turn.toolNames.includes('write')&&turn.toolNames.some(name=>name.endsWith('probe')))
 assert.equal(evidence.outsideWritten,true)
 assert.equal(evidence.nativeToolsOffered,true)
 assert.equal(evidence.mcpCalls.length,2)
 assert.equal(evidence.loaded.success,true)
 // Safe summary only: no paths, bearer, random call ids or model prompt text.
 console.log(JSON.stringify({version:evidence.binaryVersion,isolatedHome:true,realProviderRequests:0,permissions:evidence.permissions,outsideWritten:evidence.outsideWritten,nativeToolsOffered:evidence.nativeToolsOffered,mcpCalls:evidence.mcpCalls.length,loaded:evidence.loaded,afterLoad:evidence.afterLoad},null,2))
} finally {
 for(const {timer} of pending.values()) clearTimeout(timer)
 try {process.kill(-child.pid,'SIGTERM')} catch {}
 await mcp.dispose()
 model.closeAllConnections()
 await new Promise(resolve=>model.close(resolve))
 lines.close()
 await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,1500).unref()})
 try {process.kill(-child.pid,'SIGKILL')} catch {}
 rmSync(home,{recursive:true,force:true})
}
