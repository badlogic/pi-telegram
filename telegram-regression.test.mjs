import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function waitFor(predicate, timeoutMs=3000) {
 const end=Date.now()+timeoutMs;
 while(Date.now()<end){ if(predicate()) return; await new Promise(r=>setTimeout(r,10)); }
 throw new Error('condition timed out');
}

async function setup() {
 const home=await mkdtemp(join(tmpdir(),'pi-telegram-')); process.env.HOME=home;
 const dir=join(home,'.pi','agent'); await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'telegram.json'),JSON.stringify({botToken:'test',allowedUserId:7,lastUpdateId:0}));
 const calls=[]; let updates=[];
 globalThis.fetch=async (url, init={})=>{ const method=String(url).split('/').pop(); let body={}; try{body=JSON.parse(init.body)}catch{}
 calls.push({method,body});
 if(method==='getUpdates'){ const batch=updates; updates=[]; await new Promise(resolve=>{const timer=setTimeout(resolve,3); init.signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true});}); if(init.signal?.aborted) throw new DOMException('aborted','AbortError'); return Response.json({ok:true,result:batch}); }
 return Response.json({ok:true,result: method==='sendMessage'?{message_id:99}:true}); };
 const {default:extension}=await import('./index.ts?test='+Math.random());
 const handlers={}, commands={}, sent=[], effects={models:[],thinking:[]};
 let idle=true, currentSessionFile='/parent.json', thinkingLevel='medium';
 const models=[{provider:'test-provider',id:'model-a',contextWindow:4096},{provider:'test-provider',id:'model-b',contextWindow:8192}];
 const ctx={isIdle:()=>idle, model:models[0], modelRegistry:{find:(provider,id)=>models.find(m=>m.provider===provider&&m.id===id),getAvailable:()=>models,isUsingOAuth:()=>false}, getContextUsage:()=>({tokens:123,contextWindow:4096,percent:3}), sessionManager:{getEntries:()=>[],getSessionFile:()=>currentSessionFile}, ui:{theme:{fg:(_c,s)=>s},setStatus(){}}, newSession:async()=>({cancelled:false})};
 const pi={on:(n,fn)=>handlers[n]=fn, registerCommand:(n,c)=>commands[n]=c, registerTool(){}, sendUserMessage:(content,opts)=>sent.push({content,opts}), setModel:async model=>{ctx.model=model;effects.models.push(`${model.provider}/${model.id}`);return true}, getThinkingLevel:()=>thinkingLevel, setThinkingLevel:level=>{thinkingLevel=level;effects.thinking.push(level)}};
 extension(pi); await handlers.session_start({},ctx); await new Promise(r=>setTimeout(r,20));
 return {home,calls,handlers,commands,ctx,sent,effects,connect:()=>commands['telegram-connect'].handler('',ctx),setIdle(v){idle=v},setSessionFile(v){currentSessionFile=v},setUpdates(v){updates=v},cleanup:()=>rm(home,{recursive:true,force:true})};
}
const message=(id,text)=>({message_id:id,chat:{id:7,type:'private'},from:{id:7,is_bot:false,first_name:'A'},text});

test('Telegram /new preserves parent and reconnects poller after shutdown/reload/start',async()=>{
 const h=await setup(); try { await h.connect();
  let switched=0; h.ctx.newSession=async opts=>{switched++; assert.deepEqual(opts,{parentSession:'/parent.json'}); await h.handlers.session_shutdown({},h.ctx);
   const {default:extension}=await import('./index.ts?reload='+Math.random()); extension({on:(n,fn)=>h.handlers[n]=fn,registerCommand:(n,c)=>h.commands[n]=c,registerTool(){},sendUserMessage(){}});
   h.setSessionFile('/new-session.json'); await h.handlers.session_start({},h.ctx); return {cancelled:false};};
  h.setUpdates([{update_id:1,message:message(1,'/new')}]); await waitFor(()=>switched===1 && h.calls.filter(x=>x.method==='deleteWebhook').length>=2);
  assert.equal(switched,1); assert.ok(h.calls.filter(x=>x.method==='deleteWebhook').length>=2);
  const config=JSON.parse(await readFile(join(h.home,'.pi','agent','telegram.json'),'utf8'));
  assert.equal(config.currentSessionFile,'/new-session.json');
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('connecting registers Telegram command menu entries',async()=>{
 const h=await setup(); try {
  await h.connect();
  const registration=h.calls.find(x=>x.method==='setMyCommands');
  assert.ok(registration,'setMyCommands must be called when the bridge connects');
  assert.deepEqual(registration.body.commands.map(command=>command.command),['new','status','context','compact','model','think','help','stop']);
  assert.equal(registration.body.scope.type,'all_private_chats');
  const menuButton=h.calls.find(x=>x.method==='setChatMenuButton');
  assert.ok(menuButton,'the private-chat menu button must expose bot commands');
  assert.deepEqual(menuButton.body.menu_button,{type:'commands'});
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('Telegram /think updates Pi thinking level without forwarding it as a prompt',async()=>{
 const h=await setup(); try {
  await h.connect(); h.setUpdates([{update_id:1,message:message(10,'/think high')}]);
  await waitFor(()=>h.calls.some(x=>x.method==='sendMessage'));
  assert.deepEqual(h.effects.thinking,['high']); assert.equal(h.sent.length,0);
  const reply=h.calls.find(x=>x.method==='sendMessage').body.text; assert.match(reply,/high/i);
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('Telegram /model selects a configured provider/model',async()=>{
 const h=await setup(); try {
  await h.connect(); h.setUpdates([{update_id:1,message:message(11,'/model test-provider/model-b')}]);
  await waitFor(()=>h.calls.some(x=>x.method==='sendMessage'));
  assert.deepEqual(h.effects.models,['test-provider/model-b']); assert.equal(h.sent.length,0);
  assert.match(h.calls.find(x=>x.method==='sendMessage').body.text,/model-b/);
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('Telegram /model opens a provider menu, then a model picker',async()=>{
 const h=await setup(); try {
  await h.connect(); h.setUpdates([{update_id:1,message:message(20,'/model')}]);
  await waitFor(()=>h.calls.some(x=>x.method==='sendMessage'));
  const providerMenu=h.calls.find(x=>x.method==='sendMessage').body;
  assert.match(providerMenu.text,/provider/i);
  const providers=providerMenu.reply_markup.inline_keyboard.flat(); assert.equal(providers.length,1);
  h.setUpdates([{update_id:2,callback_query:{id:'cb-provider',from:{id:7,is_bot:false,first_name:'A'},message:message(99,'Choose a provider'),data:providers[0].callback_data}}]);
  await waitFor(()=>h.calls.some(x=>x.method==='editMessageText'));
  const modelMenu=h.calls.filter(x=>x.method==='editMessageText').at(-1).body;
  assert.match(modelMenu.text,/test-provider/);
  const models=modelMenu.reply_markup.inline_keyboard.flat().filter(button=>button.callback_data.startsWith('model:select:'));
  assert.equal(models.length,2);
  h.setUpdates([{update_id:3,callback_query:{id:'cb-model',from:{id:7,is_bot:false,first_name:'A'},message:message(99,'Choose a model'),data:models[1].callback_data}}]);
  await waitFor(()=>h.effects.models.length===1);
  assert.deepEqual(h.effects.models,['test-provider/model-b']);
  assert.equal(h.calls.filter(x=>x.method==='answerCallbackQuery').length,2);
  assert.equal(h.calls.filter(x=>x.method==='editMessageText').at(-1).body.reply_markup.inline_keyboard.length,0);
  const poll=h.calls.find(x=>x.method==='getUpdates'); assert.ok(poll.body.allowed_updates.includes('callback_query'));
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('Telegram model picker rejects callbacks from another user',async()=>{
 const h=await setup(); try {
  await h.connect(); h.setUpdates([{update_id:1,message:message(30,'/model')}]);
  await waitFor(()=>h.calls.some(x=>x.method==='sendMessage'));
  const button=h.calls.find(x=>x.method==='sendMessage').body.reply_markup.inline_keyboard[0][0];
  h.setUpdates([{update_id:2,callback_query:{id:'cb-unauthorized',from:{id:8,is_bot:false,first_name:'B'},message:message(99,'Choose a model'),data:button.callback_data}}]);
  await waitFor(()=>h.calls.some(x=>x.method==='answerCallbackQuery'&&x.body.callback_query_id==='cb-unauthorized'));
  assert.deepEqual(h.effects.models,[]);
  assert.equal(h.calls.find(x=>x.method==='answerCallbackQuery'&&x.body.callback_query_id==='cb-unauthorized').body.show_alert,true);
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('Telegram /context reports current token use and context window',async()=>{
 const h=await setup(); try {
  await h.connect(); h.setUpdates([{update_id:1,message:message(12,'/context')}]);
  await waitFor(()=>h.calls.some(x=>x.method==='sendMessage'));
  assert.match(h.calls.find(x=>x.method==='sendMessage').body.text,/123\/4\.1k \(3\.0%\)/);
  assert.equal(h.sent.length,0);
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('Telegram response cleanup does not publish a blank streaming draft',async()=>{
 const h=await setup(); try {
  await h.connect(); h.setUpdates([{update_id:1,message:message(40,'hello')}]);
  await waitFor(()=>h.sent.length===1);
  await h.handlers.agent_start({},h.ctx);
  await h.handlers.message_update({message:{role:'assistant',content:[{type:'text',text:'reply'}]}},h.ctx);
  await h.handlers.agent_end({messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'reply'}]}]},h.ctx);
  const emptyDrafts=h.calls.filter(x=>x.method==='sendMessageDraft'&&x.body.text==='');
  assert.equal(emptyDrafts.length,0,'completion must not create an empty draft bubble in the Telegram chat');
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});

test('two queued Telegram messages hand off using followUp exactly once',async()=>{
 const h=await setup(); try { await h.connect();
  h.setIdle(false);
  h.setUpdates([{update_id:1,message:message(1,'first')},{update_id:2,message:message(2,'second')}]);
  await new Promise(r=>setTimeout(r,80));
  await h.handlers.agent_start({},h.ctx);
  await h.handlers.agent_end({messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}]},h.ctx);
  assert.equal(h.sent.length,1); assert.equal(h.sent[0].opts?.deliverAs,'followUp');
  assert.match(JSON.stringify(h.sent[0].content),/second/); assert.doesNotMatch(JSON.stringify(h.sent[0].content),/first/);
  await h.handlers.agent_start({},h.ctx);
  await h.handlers.agent_end({messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'second reply'}]}]},h.ctx);
  const replies=h.calls.filter(x=>x.method==='sendMessage').map(x=>x.body.text);
  assert.ok(replies.includes('done')); assert.ok(replies.includes('second reply'));
 } finally { await h.handlers.session_shutdown({},h.ctx); await h.cleanup(); }
});
