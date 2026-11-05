#!/usr/bin/env node
/**
 * 诊断可见性测试。
 *
 * 事故背景：线上出现"见到 6 个请求、生成命中 0 次、最近命中路径为空"。
 * 原因是 noteUrl 只在 classify 命中白名单时才记录 ——
 * 于是诊断信息在最需要它的场景（全部不命中）恰好是空的。
 * 这类"诊断本身失效"比功能失效更难排查，必须测住。
 */
'use strict';
var fs=require('fs'), path=require('path');
var env=require('./mock/env');
var src=fs.readFileSync(path.resolve(__dirname,'../../app/assets/ds_shell.js'),'utf8');

var pass=0,fail=0,fails=[];
function check(n,f){ try{f();pass++;console.log('  PASS  '+n);}catch(e){fail++;fails.push([n,e.message]);console.log('  FAIL  '+n+'\n        '+e.message);} }
function assert(c,m){ if(!c) throw new Error(m||'assert'); }
function eq(a,b,m){ if(a!==b) throw new Error((m||'!=')+' got='+JSON.stringify(a)+' want='+JSON.stringify(b)); }
function ev(o){ return 'data: '+JSON.stringify(o); }

function issue(e, url, body){
  var x=new e.XHR(); x.open('POST',url); x.send(body||'{}');
  x._receiveHeaders(200); x.readyState=3;
  x._responseText='';
  x._emit('progress',{}); x._emit('readystatechange');
  try{ void x.responseText; }catch(err){}
  return x;
}

console.log('\n=== 诊断可见性测试 ===\n');

check('完全不上白名单：最近路径仍然被记录（核心回归）', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var urls=['/api/v9/conversation/stream','/api/v9/session/list','/api/v1/user/profile'];
  urls.forEach(function(u){ issue(e,u); });
  var st=JSON.parse(e.shell.getStats());
  assert(st.xhrSeen>=urls.length, '应见到至少 '+urls.length+' 个请求，实际 '+st.xhrSeen);
  assert(st.lastUrls.length>=urls.length, '所有请求都应被记录，实际 '+JSON.stringify(st.lastUrls));
  assert(st.lastUrls.indexOf('/api/v9/conversation/stream')>=0,'应记录到未知路径');
});

check('未知路径但内容是对话流 → 靠内容自识别处理', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var x=new e.XHR(); x.open('POST','/api/v9/whatever'); x.send('{"chat_session_id":"D1"}');
  x._receiveHeaders(200); var acc='';
  var lines=[ev({p:'',o:'SET',v:{response:{message_id:9601,fragments:[]}}}),
    ev({p:'response',o:'BATCH',v:[{p:'fragments',o:'APPEND',v:[{id:2,type:'ANSWER',content:'正文A'}]}]}),
    ev({p:'/response/fragments/0/content',o:'APPEND',v:'B'})];
  for(var i=0;i<lines.length;i++){ acc+=lines[i]+'\n'; x._responseText=acc; x.readyState=3;
    x._emit('progress',{}); x._emit('readystatechange'); try{void x.responseText;}catch(err){} }
  var st=JSON.parse(e.shell.getStats());
  eq(st.generateHits>=1, true, '应通过内容特征命中，实际 generateHits='+st.generateHits);
  eq(x.__dsState.fields.response.fragments[0].content,'正文AB','内容应完整累积');
});

check('普通业务 JSON 不被误判（宁可漏判不可误判）', function(){
  var e=env.createEnv(src,{cfg:{antiRecall:true}});
  var x=new e.XHR(); x.open('GET','/api/v0/users/current_user_info'); x.send(null);
  x.status=200; x.readyState=4;
  x._responseText=JSON.stringify({code:0,data:{user:{id:1,name:'测试'}}});
  x._emit('readystatechange'); try{void x.responseText;}catch(err){}
  eq(x.responseText.indexOf('测试')>=0,true,'普通 JSON 应原样返回');
  var st=JSON.parse(e.shell.getStats());
  eq(st.generateHits,0,'不该被识别为对话流');
  eq(st.historyHits,0,'不该被识别为历史接口');
});

check('脚本版本号与 APK 一致（防误判"装的是旧包"）', function(){
  var m=fs.readFileSync(path.resolve(__dirname,'../../app/AndroidManifest.xml'),'utf8');
  var mv=/android:versionName\s*=\s*"([^"]+)"/.exec(m);
  var sv=/var VERSION = '([^']*)';/.exec(src);
  assert(mv&&sv,'应都能解析出版本号');
  eq(sv[1],mv[1],'脚本 VERSION 必须等于 manifest versionName');
});

console.log('\n=== '+pass+' passed, '+fail+' failed ===');
if(fail>0){ fails.forEach(function(f){console.log('  - '+f[0]+': '+f[1]);}); process.exit(1); }
console.log('ALL PASS');
