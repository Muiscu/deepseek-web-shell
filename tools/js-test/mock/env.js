/**
 * 测试用环境：把注入脚本跑在一个受控沙箱里。
 *
 * 不用 jsdom —— 我们要测的是 XHR getter 钩子的语义细节，
 * 手写 mock 能精确模拟 readyState 时序、InvalidStateError、prototype accessor，
 * 这些是 jsdom 容易糊弄过去的地方。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var XHRMock = require('./xhr');

/** 极简 localStorage，可配置配额 */
function makeStorage(opts) {
  opts = opts || {};
  var data = {};
  var quota = opts.quota || 5 * 1024 * 1024; // 5MB，与浏览器默认接近
  var used = 0;
  var failAfter = (opts.failAfter === undefined) ? Infinity : opts.failAfter;
  var attempt = 0;

  return {
    get length() { return Object.keys(data).length; },
    key: function (i) { return Object.keys(data)[i] || null; },
    getItem: function (k) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem: function (k, v) {
      var sv = String(v);
      // failAfter 表示"前 N 次写入成功，之后全部抛配额错误"
      if (attempt >= failAfter) {
        var e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      attempt++;
      if (!Object.prototype.hasOwnProperty.call(data, k)) {
        used += sv.length;
        if (used > quota) {
          var e2 = new Error('QuotaExceededError');
          e2.name = 'QuotaExceededError';
          throw e2;
        }
      }
      data[k] = sv;
    },
    removeItem: function (k) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        used -= data[k].length;
        delete data[k];
      }
    },
    clear: function () { data = {}; used = 0; },
    // 测试辅助
    _dump: function () { return Object.assign({}, data); },
    _raw: function () { return data; }
  };
}

/** 记录 bridge 调用 */
function makeBridge(log) {
  return {
    onRecall: function (s) { log.push({ m: 'onRecall', v: s }); },
    onArchiveChanged: function (n) { log.push({ m: 'onArchiveChanged', v: n }); },
    log: function (s) { log.push({ m: 'log', v: s }); },
    onArchiveError: function (s) { log.push({ m: 'onArchiveError', v: s }); },
    onReady: function (s) { log.push({ m: 'onReady', v: s }); },
    openExternal: function (s) { log.push({ m: 'openExternal', v: s }); },
    exportArchive: function (s) { log.push({ m: 'exportArchive', v: s }); }
  };
}

/**
 * 每个沙箱必须拿到**独立**的 XHR 原型。
 *
 * 原因（真实踩到的坑）：注入脚本会 Object.defineProperty 改写
 * XMLHttpRequest.prototype 的 response/responseText getter。若多个 env 共用
 * 同一个 mock 类，第二个 env 会在"已被 hook 过"的原型上再包一层，
 * 导致改写被重复应用（文本不断膨胀）且 proc 状态互相污染。
 * 浏览器里每个页面只有一个 XHR 原型，所以"每次测试一个干净原型"才等价于真实语义。
 */
function makeFreshXhr() {
  function XHR() {
    XHRMock.call(this);
  }
  // 关键：不能只用 Object.create(XHRMock.prototype)。
  // 注入脚本在 XMLHttpRequest.prototype 上用 getOwnPropertyDescriptor 找
  // response/responseText 的 getter；若 accessor 只在父原型上，它会判定"没有 getter"
  // 从而跳过安装 hook。所以必须把 accessor **复制到自己的原型上**（own property），
  // 这样每个 env 都有自己的可被独立改写的原型，语义也更接近浏览器。
  var proto = XHR.prototype;
  var names = Object.getOwnPropertyNames(XHRMock.prototype);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (name === 'constructor') continue;
    var d = Object.getOwnPropertyDescriptor(XHRMock.prototype, name);
    if (!d) continue;
    Object.defineProperty(proto, name, d);
  }
  return XHR;
}

/**
 * 建立一个沙箱环境并执行注入脚本。
 * @param {string} scriptSrc  ds_shell.js 内容
 * @param {object} options    {cfg, storageOpts, withBridge}
 */
function createEnv(scriptSrc, options) {
  options = options || {};
  var log = [];
  var storage = makeStorage(options.storageOpts || {});
  var sandbox = {
    // 让 vm 里的代码看到真实全局的最小集合
    Object: Object,
    Array: Array,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Error: Error,
    String: String,
    Number: Number,
    Boolean: Boolean,
    RegExp: RegExp,
    Function: Function,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: console,
    XMLHttpRequest: makeFreshXhr(),
    localStorage: storage,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 5.1) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Version/4.0 Chrome/37.0.0.0 Mobile Safari/537.36' },
    document: {
      createElement: function () { return { style: {}, appendChild: function () {} }; },
      documentElement: { appendChild: function () {} },
      addEventListener: function () {}
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  if (options.cfg) sandbox.__DS_APP_CFG__ = options.cfg;
  if (options.withBridge !== false) sandbox.DSApp = makeBridge(log);

  var ctx = vm.createContext(sandbox);
  vm.runInContext(scriptSrc, ctx, { filename: 'ds_shell.js' });

  return {
    sandbox: sandbox,
    log: log,
    storage: storage,
    XHR: sandbox.XMLHttpRequest,
    shell: sandbox.__DS_SHELL__,
    bridgeCalls: function (name) {
      return log.filter(function (e) { return e.m === name; });
    },
    globals: sandbox
  };
}

module.exports = { createEnv: createEnv, makeStorage: makeStorage, XHRMock: XHRMock };
