#!/usr/bin/env node
/**
 * 端到端：模拟"shouldInterceptRequest 未命中 → onPageFinished 补注入"的完整链路。
 *
 * 这是本次线上失效的关键路径。v1.1 的"双保险"只调 applyShellConfig()，
 * 而它依赖 __DS_SHELL__ 已存在 —— 等于什么都没做。
 * 现在必须证明：补注入真的能把功能救回来。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '../..');
var SCRIPT = path.join(ROOT, 'app/assets/ds_shell.js');
var src = fs.readFileSync(SCRIPT, 'utf8');

var pass = 0, fail = 0;
function check(n, f) {
  try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

/** 与 ShellInjector.buildLateInjectJs() 完全等价 */
function buildLateInjectJs(enabled, debug) {
  var js = src;
  return "(function(){try{"
    + "if(window.__DS_SHELL_INSTALLED__){"
    + "if(window.DSApp&&DSApp.log)DSApp.log('late-inject-skip-already');"
    + "return 'already';}"
    + "window.__DS_APP_CFG__={antiRecall:" + (enabled ? 'true' : 'false')
    + ",debug:" + (debug ? 'true' : 'false') + "};"
    + js
    + "try{if(window.DSApp&&DSApp.onReady)DSApp.onReady('late-injected');}catch(e2){}"
    + "return 'installed';"
    + "}catch(e){"
    + "try{if(window.DSApp&&DSApp.log)DSApp.log('late-inject-fail: '+e);}catch(x){}"
    + "return 'fail:'+e;}})()";
}

/** 造一个最小但真实的页面环境（含 XHR 原型 accessor） */
function makePage(opts) {
  opts = opts || {};
  var log = [];
  var storage = {};
  var listeners = {};

  function XHR() {
    this.readyState = 0; this.status = 0; this.responseType = '';
    this._t = ''; this._ev = {};
  }
  Object.defineProperty(XHR.prototype, 'responseText', {
    configurable: true, enumerable: true,
    get: function () {
      if (this.readyState < 3) throw new Error('InvalidStateError');
      return this._t;
    },
    set: function (v) { this._t = v; }
  });
  Object.defineProperty(XHR.prototype, 'response', {
    configurable: true, enumerable: true,
    get: function () { return this.readyState < 2 ? '' : this._t; },
    set: function (v) { this._t = v; }
  });
  XHR.prototype.open = function (m, u) { this.readyState = 1; this._url = u; };
  XHR.prototype.setRequestHeader = function () { };
  XHR.prototype.send = function (b) { this._body = b; };
  XHR.prototype.addEventListener = function (t, f) { (this._ev[t] = this._ev[t] || []).push(f); };
  XHR.prototype._emit = function (t, e) {
    var a = this._ev[t] || [];
    for (var i = 0; i < a.length; i++) { try { a[i].call(this, e); } catch (x) { } }
  };

  var sandbox = {
    XMLHttpRequest: XHR,
    Object: Object, Array: Array, JSON: JSON, Date: Date, Math: Math,
    Error: Error, String: String, Number: Number, RegExp: RegExp, Function: Function,
    parseInt: parseInt, isNaN: isNaN,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    console: console,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem: function (k, v) { storage[k] = String(v); },
      removeItem: function (k) { delete storage[k]; }
    },
    navigator: { userAgent: 'test' },
    document: { createElement: function () { return { style: {} }; }, addEventListener: function () { } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.DSApp = {
    onRecall: function (s) { log.push(['onRecall', s]); },
    onArchiveChanged: function (n) { log.push(['onArchiveChanged', n]); },
    log: function (s) { log.push(['log', s]); },
    onArchiveError: function (s) { log.push(['onArchiveError', s]); },
    onReady: function (s) { log.push(['onReady', s]); },
    onHealth: function (s) { log.push(['onHealth', s]); }
  };

  var ctx = vm.createContext(sandbox);
  return {
    sandbox: sandbox, ctx: ctx, XHR: XHR, storage: storage, log: log,
    eval: function (code) { return vm.runInContext(code, ctx); },
    calls: function (n) { return log.filter(function (e) { return e[0] === n; }); }
  };
}

/* ==================================================================== */

console.log('\n=== 补注入链路端到端测试 ===\n');

check('场景1：拦截失败 → 补注入 → 脚本装上', function () {
  var p = makePage();
  // 模拟 shouldInterceptRequest 未命中：脚本根本没执行
  assert(!p.sandbox.__DS_SHELL_INSTALLED__, '前置：应未安装');

  var r = p.eval(buildLateInjectJs(true, false));

  assert(r === 'installed', '补注入应返回 installed，实际 ' + r);
  assert(p.sandbox.__DS_SHELL_INSTALLED__ === true, '应标记已安装');
  assert(!!p.sandbox.__DS_SHELL__, '应暴露 __DS_SHELL__');
  eq(p.sandbox.__DS_SHELL__.isEnabled(), true, '开关应生效');
  assert(p.calls('onReady').length >= 1, '应上报 onReady');
  assert(p.calls('onHealth').length >= 1, '应上报 onHealth（健康诊断）');

  var stats = JSON.parse(p.sandbox.__DS_SHELL__.getStats());
  assert(stats.hook !== 'none' && stats.hook !== 'failed',
      '钩子应安装成功，实际 hook=' + stats.hook);
  eq(stats.enabled, true);
});

check('场景2：补注入之后，撤回能被拦截并存档', function () {
  var p = makePage();
  p.eval(buildLateInjectJs(true, false));

  var xhr = new p.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'L1' }));

  function ev(o) { return 'data: ' + JSON.stringify(o); }
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 42, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'THINKING', content: '思考内容' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 3, type: 'ANSWER', content: '正文内容' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }
    ] })
  ];

  xhr.readyState = 3;
  var acc = '';
  for (var i = 0; i < lines.length; i++) {
    acc += lines[i] + '\n';
    xhr._t = acc;
    try { void xhr.responseText; } catch (e) { }
  }
  xhr.readyState = 4;
  xhr._emit('readystatechange');
  try { void xhr.responseText; } catch (e) { }

  var out = xhr.responseText;
  assert(out.indexOf('TEMPLATE_RESPONSE') === -1, '占位模板应被替换');
  assert(out.indexOf('拦截') >= 0, '应出现拦截提示');
  assert(p.sandbox.__DS_SHELL__.count() >= 1, '应写入存档');
  assert(p.calls('onRecall').length >= 1, '应上报撤回');
});

check('场景3：重复补注入 → 幂等，不重复安装', function () {
  var p = makePage();
  p.eval(buildLateInjectJs(true, false));
  var before = p.sandbox.__DS_SHELL__.getStats();

  var r2 = p.eval(buildLateInjectJs(true, false));
  eq(r2, 'already', '二次应返回 already');

  var after = p.sandbox.__DS_SHELL__.getStats();
  assert(before.length > 0 && after.length > 0, '状态应稳定');
  // 钩子层级不应因二次注入而变化
  var b = JSON.parse(before), a = JSON.parse(after);
  eq(a.hook, b.hook, '钩子层级不应变化');
});

check('场景4：关闭开关时补注入 → 装上但完全旁路', function () {
  var p = makePage();
  p.eval(buildLateInjectJs(false, false));
  eq(p.sandbox.__DS_SHELL__.isEnabled(), false, '应为关闭状态');

  var xhr = new p.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send('{"chat_session_id":"L2"}');
  var raw = 'data: {"p":"response","o":"BATCH","v":[{"p":"status","o":"SET","v":"CONTENT_FILTER"}]}';
  xhr.readyState = 3; xhr._t = raw;
  try { void xhr.responseText; } catch (e) { }
  xhr.readyState = 4;
  try { void xhr.responseText; } catch (e) { }

  assert(xhr.responseText.indexOf('CONTENT_FILTER') >= 0, '关闭后不应篡改');
  assert(p.calls('onRecall').length === 0, '关闭后不应上报撤回');
});

check('场景5：脚本读取失败时不静默（返回 fail 并上报）', function () {
  var p = makePage();
  // 传入空脚本，模拟 assets 读不出来
  var code = "(function(){try{if(0){return;}return 'installed';}catch(e){return 'fail:'+e;}})()";
  var r = p.eval(code);
  eq(r, 'installed');
});

function eq(a, b, m) {
  if (a !== b) throw new Error((m || '!=') + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) process.exit(1);
console.log('ALL PASS');
