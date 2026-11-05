#!/usr/bin/env node
/**
 * 实例级降级层专项测试（C8 系列）——单独成文件，避免与 adversarial2 的长块纠缠。
 *
 * 场景：站点若用自定义 XHR 垫片（responseText 是数据属性、无原型 accessor），
 * 实现会走 installInstanceLevelHook 降级路径。这是"原型钩子装不上"时的最后一道防线。
 *
 * 用法：node tools/js-test/audit/fallback.js    退出码 1 = 有缺陷
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '../../..');
var src = fs.readFileSync(path.join(ROOT, 'app/assets/ds_shell.js'), 'utf8');
var NL = String.fromCharCode(10);

var pass = 0, fail = 0, bugs = [];
function ev(o) { return 'data: ' + JSON.stringify(o); }
function probe(id, title, fn) {
  try {
    var n = fn();
    pass++;
    console.log('  OK    [' + id + '] ' + title + (n ? '   — ' + n : ''));
  } catch (e) {
    fail++; bugs.push([id, title, e && e.message]);
    console.log('  BUG   [' + id + '] ' + title);
    console.log('        ' + (e && e.message));
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) {
  if (a !== b) throw new Error((m || 'ne') + ' (got ' + JSON.stringify(a)
    + ', want ' + JSON.stringify(b) + ')');
}

/** 造一个"垫片 XHR"环境：responseText/response 是实例数据属性 */
function makeShimEnv() {
  function Shim() {
    this.readyState = 0; this.status = 0; this.responseType = '';
    this.responseText = ''; this.response = ''; this._l = {};
  }
  Shim.prototype.open = function (m, u) { this._url = u; this.readyState = 1; };
  Shim.prototype.send = function () { };
  Shim.prototype.setRequestHeader = function () { };
  Shim.prototype.addEventListener = function (t, f) {
    (this._l[t] || (this._l[t] = [])).push(f);
  };
  Shim.prototype._emit = function (t) {
    var a = this._l[t] || [];
    for (var i = 0; i < a.length; i++) { try { a[i].call(this, {}); } catch (e) { } }
  };

  var d = {};
  var bridgeLog = [];
  var sb = {
    Object: Object, Array: Array, JSON: JSON, Math: Math, Date: Date, Error: Error,
    String: String, Number: Number, Boolean: Boolean, RegExp: RegExp, Function: Function,
    parseInt: parseInt, isNaN: isNaN, setTimeout: setTimeout, clearTimeout: clearTimeout,
    console: console, XMLHttpRequest: Shim,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem: function (k, v) { d[k] = String(v); },
      removeItem: function (k) { delete d[k]; }
    },
    document: { createElement: function () { return {}; }, addEventListener: function () { } },
    DSApp: {
      onRecall: function (s) { bridgeLog.push(['onRecall', s]); },
      onArchiveChanged: function (n) { bridgeLog.push(['onArchiveChanged', n]); },
      log: function (s) { bridgeLog.push(['log', s]); },
      onReady: function (s) { bridgeLog.push(['onReady', s]); },
      onArchiveError: function (s) { bridgeLog.push(['onArchiveError', s]); }
    }
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.runInContext(src, vm.createContext(sb), { filename: 'ds_shell.js' });
  return { sb: sb, data: d, bridgeLog: bridgeLog, Shim: Shim };
}

console.log('\n=== 实例级降级层专项 ===');
console.log('script: ' + src.length + ' bytes\n');

/* ------------------------------------------------------------------ */
probe('F1', '降级层：SSE 撤回能否篡改 + 存档 + bridge 上报', function () {
  var env = makeShimEnv();
  var xhr = new env.sb.XMLHttpRequest();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'SB' }));

  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 8001, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '降级层的正文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ];
  var body = lines.join(NL);
  xhr.readyState = 3; xhr.responseText = body; xhr._emit('progress');
  var at3 = String(xhr.responseText || '');
  xhr.readyState = 4;
  var at4 = String(xhr.responseText || '');

  assert(at3.indexOf('TEMPLATE_RESPONSE') === -1,
    '降级层 readyState=3 未篡改: ' + JSON.stringify(at3.substring(0, 100)));
  assert(at4.indexOf('TEMPLATE_RESPONSE') === -1,
    '降级层 readyState=4 未篡改: ' + JSON.stringify(at4.substring(0, 100)));
  assert(env.sb.__DS_SHELL__.count() >= 1, '降级层未产生存档');
  var recalls = env.bridgeLog.filter(function (r) { return r[0] === 'onRecall'; });
  assert(recalls.length >= 1, '降级层未上报 onRecall');
  return 'hook=' + JSON.parse(env.sb.__DS_SHELL__.getStats()).hook
    + ', count=' + env.sb.__DS_SHELL__.count();
});

/* ------------------------------------------------------------------ */
probe('F2', '降级层：history 还原是否生效', function () {
  var env = makeShimEnv();
  // 先造存档
  var x1 = new env.sb.XMLHttpRequest();
  x1.open('POST', '/api/v0/chat/completion');
  x1.send(JSON.stringify({ chat_session_id: 'SB' }));
  x1.readyState = 3;
  x1.responseText = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 8101, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '历史原文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ].join(NL);
  x1._emit('progress'); x1.readyState = 4; void x1.responseText;
  eq(env.sb.__DS_SHELL__.count(), 1, '前置存档失败');

  var hist = JSON.stringify({ data: { biz_data: { chat_session: { id: 'SB' },
    chat_messages: [{ message_id: 8101, status: 'CONTENT_FILTER', fragments: [] }] } } });
  var x2 = new env.sb.XMLHttpRequest();
  x2.open('POST', '/api/v0/chat/history_messages');
  x2.send('{}');
  x2.readyState = 4;
  x2.responseText = hist;
  var out = String(x2.responseText || '');
  var j;
  try { j = JSON.parse(out); } catch (e) {
    throw new Error('降级层 history 输出不是合法 JSON: ' + JSON.stringify(out.substring(0, 120)));
  }
  var m = j.data.biz_data.chat_messages[0];
  eq(m.status, 'FINISHED', '降级层 history 未改 status');
  assert(JSON.stringify(m.fragments).indexOf('历史原文') >= 0, '降级层未还原原文');
  return 'restored';
});

/* ------------------------------------------------------------------ */
probe('F3', '降级层：普通接口不得被碰（数据属性原样返回）', function () {
  var env = makeShimEnv();
  var body = '{"biz_code":0,"text":"普通接口"}';
  var x = new env.sb.XMLHttpRequest();
  x.open('GET', '/api/v0/users');
  x.readyState = 3; x.responseText = body;
  x._emit('progress');
  eq(String(x.responseText), body, '降级层改动了普通接口响应');
  eq(env.sb.__DS_SHELL__.count(), 0, '普通接口不应产生存档');
});

/* ------------------------------------------------------------------ */
probe('F4', '降级层：关闭开关后完全旁路', function () {
  var env = makeShimEnv();
  env.sb.__DS_SHELL__.setEnabled(false);
  var x = new env.sb.XMLHttpRequest();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'SB' }));
  var body = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 8201, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '正文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ].join(NL);
  x.readyState = 3; x.responseText = body; x._emit('progress');
  x.readyState = 4;
  eq(String(x.responseText), body, '关闭后降级层仍篡改');
  eq(env.sb.__DS_SHELL__.count(), 0, '关闭后降级层仍存档');
});

/* ------------------------------------------------------------------ */
probe('F5', '降级层：XHR 复用（第二次请求）不串内容', function () {
  var env = makeShimEnv();
  var x = new env.sb.XMLHttpRequest();
  function run(msgId, content, recall) {
    x.open('POST', '/api/v0/chat/completion');
    x.send(JSON.stringify({ chat_session_id: 'SB' }));
    var lines = [
      ev({ p: '', o: 'SET', v: { response: { message_id: msgId, fragments: [] } } }),
      ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
        v: [{ id: 2, type: 'ANSWER', content: content }] }] }),
      ev({ p: 'response', o: 'BATCH', v: recall
        ? [{ p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }]
        : [{ p: 'status', o: 'SET', v: 'FINISHED' }] }),
      ''
    ].join(NL);
    x.readyState = 3; x.responseText = lines; x._emit('progress');
    x.readyState = 4; void x.responseText;
  }
  run(8301, '第一条', true);
  run(8302, '第二条-更长的内容-用来错开偏移量-++++++++++++++++++++++', false);
  var out = String(x.responseText);
  assert(out.indexOf('echo') < 0, 'unreachable');
  // 第二次是正常流，不能被上一次的 TIP 改写污染
  var tail = out.substring(Math.max(0, out.length - 160));
  assert(out.indexOf('此回复已被拦截') === -1,
    '降级层复用实例时，上一次请求的 TIP 改写串进了第二次响应: '
    + JSON.stringify(tail));
  assert(out.indexOf('第二条') >= 0, '第二次正文丢失');
  return 'clean';
});

console.log('\n=== ' + pass + ' ok, ' + fail + ' bug(s) ===');
if (fail) {
  bugs.forEach(function (b) { console.log('  [' + b[0] + '] ' + b[1] + '\n      ' + b[2]); });
  process.exit(1);
}
console.log('no defects');
