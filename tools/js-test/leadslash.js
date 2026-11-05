#!/usr/bin/env node
/**
 * 路径前导斜杠回归测试。
 *
 * 事故背景：线上真实 SSE 的 p 字段带前导斜杠（"/response/fragments/0/content"），
 * 而实现用 path + '/' + op.p 拼接，得到 "response//fragments/..."，
 * split 后出现空段 → 路径断掉 → 后续帧全写不进去。
 * 用户看到的现象是"只保存了 1.\n\n听到"（正好前两帧）。
 *
 * 同一个 bug 还让撤回信号（p="/response"）永远匹配不上，
 * 所以"没替换抱歉内容"也是它造成的。
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
function drive(e,lines){
  var x=new e.XHR(); x.open('POST','/api/v0/chat/completion'); x.send('{"chat_session_id":"L"}');
  x._receiveHeaders(200); var acc='';
  for(var i=0;i<lines.length;i++){ acc+=lines[i]+'\n'; x._responseText=acc; x.readyState=3;
    x._emit('progress',{}); x._emit('readystatechange'); try{void x.responseText;}catch(err){} }
  x._finish(); try{void x.responseText;}catch(err){}
  return x;
}

console.log('\n=== 路径前导斜杠回归测试 ===\n');

check('顶层 p 带前导斜杠：增量内容仍能累积（核心回归）', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:9001,fragments:[]}}}),
    ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[{id:2,type:'ANSWER',content:'1.'}]}]}),
    ev({p:'/response/fragments/0/content',o:'APPEND',v:'\n\n听到'}),
    ev({p:'/response/fragments/0/content',o:'APPEND',v:'你说'}),
    ev({p:'/response/fragments/0/content',o:'APPEND',v:'要减肥'})];
  var x=drive(e,lines);
  var fr=x.__dsState.fields.response.fragments;
  eq(fr.length,1,'应仍为 1 个片段');
  eq(fr[0].content,'1.\n\n听到你说要减肥','增量必须全部累积，实际 '+JSON.stringify(fr[0].content));
});

check('BATCH 子操作 p 带前导斜杠：同样累积', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:9002,fragments:[]}}}),
    ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[{id:2,type:'ANSWER',content:'A'}]}]}),
    ev({p:'response',o:'BATCH',v:[{p:'/fragments/0/content',o:'APPEND',v:'B'}]}),
    ev({p:'response',o:'BATCH',v:[{p:'/fragments/0/content',o:'APPEND',v:'C'}]})];
  var x=drive(e,lines);
  eq(x.__dsState.fields.response.fragments[0].content,'ABC');
});

check('撤回信号 p="/response" 必须命中（这曾导致"没替换抱歉内容"）', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:9003,fragments:[]}}}),
    ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[{id:2,type:'ANSWER',content:'正文'}]}]}),
    ev({p:'/response',o:'BATCH',v:[
      {p:'fragments',o:'SET',v:[{id:2,type:'TEMPLATE_RESPONSE',content:''}]},
      {p:'/status',o:'SET',v:'CONTENT_FILTER'}]})];
  var x=drive(e,lines);
  assert(x.responseText.indexOf('TEMPLATE_RESPONSE')===-1,'占位模板应被替换');
  assert(x.responseText.indexOf('拦截')>=0,'应出现拦截提示');
  var idx=JSON.parse(e.storage.getItem('__ds_archive_index')||'[]');
  eq(idx.length,1);
  eq(idx[0].reason,'TEMPLATE_RESPONSE','原因应是信号检测（不能被 LIVE_SETTLED 覆盖）');
});

check('路径规范化：多余斜杠折叠', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:9004,fragments:[]}}}),
    ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[{id:2,type:'ANSWER',content:'X'}]}]}),
    ev({p:'response//fragments//0//content',o:'APPEND',v:'Y'})];
  var x=drive(e,lines);
  eq(x.__dsState.fields.response.fragments[0].content,'XY');
});

check('回归：普通无斜杠路径仍正常', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:9005,fragments:[]}}}),
    ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[{id:2,type:'ANSWER',content:'正常'}]}]})];
  var x=drive(e,lines);
  eq(x.__dsState.fields.response.fragments[0].content,'正常');
});

console.log('\n=== '+pass+' passed, '+fail+' failed ===');
if(fail>0){ fails.forEach(function(f){console.log('  - '+f[0]+': '+f[1]);}); process.exit(1); }
console.log('ALL PASS');
