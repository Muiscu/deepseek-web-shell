#!/usr/bin/env node
/**
 * 诊断真实性测试。
 *
 * 事故背景：线上诊断页显示「见到8次请求、生成命中0次」，但网络总账里有 40 条
 * 且包含 /api/v0/chat/edit_message 与 /api/v0/chat/history_messages。
 * 两者矛盾 —— 根因是脚本只在启动时上报一次健康状态，
 * 之后 40 个请求发生了，诊断页读到的仍是「启动那一刻」的旧快照。
 *
 * 结果是：用户看到的永远是过期数据，「其实命中了」被误判成「从未命中」。
 * 这类"诊断说谎"比功能失效更难排查，必须测住。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var src = fs.readFileSync(
    path.resolve(__dirname, '../../app/assets/ds_shell.js'), 'utf8');

var pass = 0, fail = 0, fails = [];
function check(n, f) {
  try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; fails.push([n, e.message]); console.log('  FAIL  ' + n + '\n        ' + e.message); }
}
function eq(a, b, m) {
  if (a !== b) throw new Error((m || '!=') + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

function makeEnv() {
  var healthReports = [];
  function X() { this.readyState = 0; this._t = ''; }
  Object.defineProperty(X.prototype, 'responseText', {
    configurable: true, enumerable: true,
    get: function () { if (this.readyState < 3) throw new Error('E'); return this._t; },
    set: function (v) { this._t = v; }
  });
  Object.defineProperty(X.prototype, 'response', {
    configurable: true, enumerable: true,
    get: function () { return this.readyState < 2 ? '' : this._t; },
    set: function (v) { this._t = v; }
  });
  X.prototype.open = function (m, u) { this.readyState = 1; this._u = u; };
  X.prototype.send = function (b) { this._b = b; };
  X.prototype.setRequestHeader = function () { };
  X.prototype.addEventListener = function () { };

  var sb = {
    Object: Object, Array: Array, JSON: JSON, Date: Date, Math: Math, Error: Error,
    String: String, Number: Number, Boolean: Boolean, RegExp: RegExp, Function: Function,
    parseInt: parseInt, isNaN: isNaN,
    setTimeout: setTimeout, clearTimeout: clearTimeout, console: console,
    navigator: { userAgent: 'x' },
    document: {
      createElement: function () { return { style: {} }; },
      addEventListener: function () { }
    },
    XMLHttpRequest: X,
    localStorage: {
      getItem: function () { return null; },
      setItem: function () { },
      removeItem: function () { },
      get length() { return 0; },
      key: function () { return null; }
    }
  };
  sb.window = sb; sb.globalThis = sb; sb.self = sb;
  sb.__DS_APP_CFG__ = { antiRecall: true, debug: false };
  sb.DSApp = {
    onRecall: function () { },
    onArchiveChanged: function () { },
    log: function () { },
    onArchiveError: function () { },
    onReady: function () { },
    onHealth: function (s) { healthReports.push(s); },
    onArchiveSnapshot: function () { }
  };
  var ctx = vm.createContext(sb);
  vm.runInContext(src, ctx, { filename: 'ds_shell.js' });
  return { sb: sb, X: X, health: healthReports };
}

console.log('\n=== 诊断真实性测试 ===\n');

check('getStats 反映实时计数（不是启动快照）', function () {
  var e = makeEnv();
  // 发 10 个请求
  for (var i = 0; i < 10; i++) {
    var x = new e.X();
    x.open('POST', '/api/v0/chat/edit_message');
  }
  var st = JSON.parse(e.sb.__DS_SHELL__.getStats());
  assert(st.xhrSeen >= 10, 'xhrSeen 应 >= 10，实际 ' + st.xhrSeen);
  assert(st.net.length >= 10, 'netLog 应 >= 10，实际 ' + st.net.length);
});

check('命中 generate 时计数递增且立刻上报', function () {
  var e = makeEnv();
  var x = new e.X();
  x.open('POST', '/api/v0/chat/edit_message');
  x.send('{"chat_session_id":"G1"}');
  x.readyState = 3;
  x._t = 'data: {"p":"","o":"SET","v":{"response":{"message_id":1,"fragments":[]}}}\n';
  try { void x.responseText; } catch (err) { }

  var st = JSON.parse(e.sb.__DS_SHELL__.getStats());
  assert(st.generateHits >= 1, 'generateHits 应 >= 1，实际 ' + st.generateHits);
  assert(e.health.length >= 2, '应多次上报健康状态，实际 ' + e.health.length);
});

check('命中 history 时计数递增', function () {
  var e = makeEnv();
  var x = new e.X();
  x.open('POST', '/api/v0/chat/history_messages');
  x.send('{}');
  x.readyState = 4;
  x._t = JSON.stringify({ data: { biz_data: { chat_session: { id: 's' }, chat_messages: [] } } });
  try { void x.responseText; } catch (err) { }

  var st = JSON.parse(e.sb.__DS_SHELL__.getStats());
  assert(st.historyHits >= 1, 'historyHits 应 >= 1，实际 ' + st.historyHits);
});

check('每 5 个请求上报一次（避免诊断长期过期）', function () {
  var e = makeEnv();
  var before = e.health.length;
  for (var i = 0; i < 5; i++) {
    var x = new e.X();
    x.open('GET', '/api/v0/client/settings');
  }
  assert(e.health.length > before,
      '5 个请求后应至少上报一次，实际 ' + e.health.length);
});

check('真实路径 edit_message / history_messages 都被正确分类', function () {
  var e = makeEnv();
  var I = e.sb.__DS_SHELL__._internals;
  eq(I.classify('/api/v0/chat/edit_message'), 'generate');
  eq(I.classify('/api/v0/chat/history_messages'), 'history');
  eq(I.classify('api/v0/chat/edit_message'), 'generate', '相对路径也要识别');
});

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) {
  fails.forEach(function (f) { console.log('  - ' + f[0] + ': ' + f[1]); });
  process.exit(1);
}
console.log('ALL PASS');
