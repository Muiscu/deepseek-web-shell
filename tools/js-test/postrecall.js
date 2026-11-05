#!/usr/bin/env node
/**
 * "事后撤回"还原测试。
 *
 * 真实场景：消息生成时一切正常（无任何撤回信号），
 * 过一段时间后 history 接口把它标成 CONTENT_FILTER。
 * 如果生成阶段没存，这里就永远还原不出来 —— 这正是用户遇到的
 * "依旧被撤回、存档为空"。
 */
'use strict';
var fs=require('fs'), path=require('path');
var env=require('./mock/env');
var src=fs.readFileSync(path.resolve(__dirname,'../../app/assets/ds_shell.js'),'utf8');

var pass=0, fail=0, fails=[];
function check(n,f){ try{f();pass++;console.log('  PASS  '+n);}catch(e){fail++;fails.push([n,e.message]);console.log('  FAIL  '+n+'\n        '+e.message);} }
function assert(c,m){ if(!c) throw new Error(m||'assert'); }
function eq(a,b,m){ if(a!==b) throw new Error((m||'!=')+' got='+JSON.stringify(a)+' want='+JSON.stringify(b)); }
function ev(o){ return 'data: '+JSON.stringify(o); }

function fakeTimers(e){
  var t=[],id=1;
  e.sandbox.setTimeout=function(fn){t.push(fn);return id++;};
  e.sandbox.clearTimeout=function(){};
  return {run:function(){ t.forEach(function(f){try{f();}catch(x){}}); }};
}

console.log('\n=== 事后撤回还原测试 ===\n');

check('生成阶段正常完成（无撤回信号）→ 暂存/存档已就位', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}}), T=fakeTimers(e);
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:1234,fragments:[]}}})];
  for(var i=0;i<5;i++) lines.push(ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[
    {id:2+i,type:i===0?'THINKING':'ANSWER',content:'第'+i+'段完整正文内容'}]}]}));
  lines.push(ev({p:'response',o:'BATCH',v:[{p:'status',o:'SET',v:'FINISHED'}]}));

  var x=new e.XHR(); x.open('POST','/api/v0/chat/completion'); x.send('{"chat_session_id":"P1"}');
  x._receiveHeaders(200); var acc='';
  for(var j=0;j<lines.length;j++){
    acc+=lines[j]+'\n'; x._responseText=acc; x.readyState=3;
    x._emit('progress',{}); x._emit('readystatechange'); try{void x.responseText;}catch(err){}
  }
  x._finish(); try{void x.responseText;}catch(err){}
  T.run();

  assert(e.shell.count()>=1,'生成完成后应有存档，实际 '+e.shell.count());
});

check('事后撤回：history 标 CONTENT_FILTER → 用存档还原出原文', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}}), T=fakeTimers(e);
  // 先生成一条完整消息
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:2222,fragments:[]}}})];
  for(var i=0;i<3;i++) lines.push(ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[
    {id:2+i,type:'ANSWER',content:'重要正文'+i}]}]}));
  lines.push(ev({p:'response',o:'BATCH',v:[{p:'status',o:'SET',v:'FINISHED'}]}));
  var x1=new e.XHR(); x1.open('POST','/api/v0/chat/completion'); x1.send('{"chat_session_id":"P2"}');
  x1._receiveHeaders(200); var acc='';
  for(var j=0;j<lines.length;j++){
    acc+=lines[j]+'\n'; x1._responseText=acc; x1.readyState=3;
    x1._emit('progress',{}); x1._emit('readystatechange'); try{void x1.responseText;}catch(err){}
  }
  x1._finish(); try{void x1.responseText;}catch(err){}
  T.run();

  // 事后：history 返回这条消息被标成 CONTENT_FILTER，且 fragments 已被清空
  var hist=JSON.stringify({data:{biz_data:{
    chat_session:{id:'P2'},
    chat_messages:[{message_id:2222,status:'CONTENT_FILTER',fragments:[]}]
  }}});
  var x2=new e.XHR(); x2.responseType='text';
  x2.open('POST','/api/v0/chat/history_messages'); x2.send('{}');
  x2.status=200; x2.readyState=4; x2._responseText=hist;
  x2._emit('readystatechange'); try{void x2.responseText;}catch(err){}

  var out=x2.responseText;
  assert(out.indexOf('重要正文0')>=0,'应还原出原文，实际: '+out.slice(0,200));
  var j2=JSON.parse(out);
  var msg=j2.data.biz_data.chat_messages[0];
  eq(msg.status,'FINISHED','状态应改为 FINISHED 才能正常显示');
  assert(msg.fragments[msg.fragments.length-1].type==='TIP','末尾应有提示');
});

check('事后撤回：只有暂存（未定稿）也能还原', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var T=fakeTimers(e);
  // 生成中（不触发定稿：不跑定时器）
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:3333,fragments:[]}}}),
    ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[{id:2,type:'ANSWER',content:'暂存里的正文'}]}]})];
  var x1=new e.XHR(); x1.open('POST','/api/v0/chat/completion'); x1.send('{"chat_session_id":"P3"}');
  x1._receiveHeaders(200); var acc='';
  for(var j=0;j<lines.length;j++){
    acc+=lines[j]+'\n'; x1._responseText=acc; x1.readyState=3;
    x1._emit('progress',{}); x1._emit('readystatechange'); try{void x1.responseText;}catch(err){}
  }
  // 不 _finish、不跑定时器 → 只有暂存

  var hist=JSON.stringify({data:{biz_data:{
    chat_session:{id:'P3'},
    chat_messages:[{message_id:3333,status:'CONTENT_FILTER',fragments:[]}]
  }}});
  var x2=new e.XHR(); x2.responseType='text';
  x2.open('POST','/api/v0/chat/history_messages'); x2.send('{}');
  x2.status=200; x2.readyState=4; x2._responseText=hist;
  x2._emit('readystatechange'); try{void x2.responseText;}catch(err){}

  var out=x2.responseText;
  assert(out.indexOf('暂存里的正文')>=0,'应从暂存放还原，实际: '+out.slice(0,200));
});

check('无任何存档/暂存 → 仍诚实显示未找到', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var hist=JSON.stringify({data:{biz_data:{
    chat_session:{id:'P4'},
    chat_messages:[{message_id:4444,status:'CONTENT_FILTER',fragments:[]}]
  }}});
  var x=new e.XHR(); x.responseType='text';
  x.open('POST','/api/v0/chat/history_messages'); x.send('{}');
  x.status=200; x.readyState=4; x._responseText=hist;
  x._emit('readystatechange'); try{void x.responseText;}catch(err){}
  var out=x.responseText;
  assert(out.indexOf('未找到')>=0,'应诚实提示未找到');
});

console.log('\n=== '+pass+' passed, '+fail+' failed ===');
if(fail>0){ fails.forEach(function(f){console.log('  - '+f[0]+': '+f[1]);}); process.exit(1); }
console.log('ALL PASS');
