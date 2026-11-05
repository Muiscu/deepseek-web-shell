#!/usr/bin/env node
/**
 * URL 路径形式兼容性测试。
 *
 * 事故背景：线上「见到16次请求、生成命中0次」，但 create_pow_challenge
 * 被抓到了、chat/completion 完全没抓到。原因是前者用绝对 URL、
 * 后者用相对路径 "api/v0/chat/completion"，而 pathOf 不补前导斜杠，
 * 于是永远匹配不上白名单 "/api/v0/chat/completion"。
 *
 * 这个 bug 极隐蔽：功能完全静默失效，而诊断显示「钩子正常」。
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

function makeEnv() {
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
    XMLHttpRequest: function () { },
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
    onRecall: function () { }, onArchiveChanged: function () { }, log: function () { },
    onArchiveError: function () { }, onReady: function () { }, onHealth: function () { },
    onArchiveSnapshot: function () { }
  };
  var ctx = vm.createContext(sb);
  vm.runInContext(src, ctx, { filename: 'ds_shell.js' });
  return sb.__DS_SHELL__._internals;
}

console.log('\n=== URL 路径形式兼容性测试 ===\n');
var I = makeEnv();

check('相对路径（无前导斜杠）→ 正确识别 generate（核心回归）', function () {
  eq(I.classify('api/v0/chat/completion'), 'generate',
      '相对路径必须被识别，这是线上失效的直接原因');
});

check('相对路径 → 正确识别 history', function () {
  eq(I.classify('api/v0/chat/history_messages'), 'history');
});

check('绝对路径（有前导斜杠）仍正常', function () {
  eq(I.classify('/api/v0/chat/completion'), 'generate');
});

check('完整域名仍正常', function () {
  eq(I.classify('https://chat.deepseek.com/api/v0/chat/completion'), 'generate');
});

check('带查询串仍正常', function () {
  eq(I.classify('api/v0/chat/completion?x=1'), 'generate');
});

check('pathOf 统一补前导斜杠', function () {
  eq(I.pathOf('api/v0/x'), '/api/v0/x');
  eq(I.pathOf('/api/v0/x'), '/api/v0/x');
  eq(I.pathOf('https://h/api/v0/x'), '/api/v0/x');
});

check('相邻接口不误判（前缀边界仍有效）', function () {
  eq(I.classify('/api/v0/chat/completion_quota'), null, 'completion_quota 不该被误判');
  eq(I.classify('/api/v0/chat/history_messages_meta'), null, 'history_messages_meta 不该被误判');
});

check('普通接口不误判', function () {
  eq(I.classify('/api/v0/users/current'), null);
  eq(I.classify('/list'), null);
  eq(I.classify('/query'), null);
});

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) {
  fails.forEach(function (f) { console.log('  - ' + f[0] + ': ' + f[1]); });
  process.exit(1);
}
console.log('ALL PASS');
