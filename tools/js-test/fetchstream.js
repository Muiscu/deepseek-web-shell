#!/usr/bin/env node
/**
 * fetch 流式路径测试。
 *
 * 背景：线上"见到 6 个请求、生成命中 0 次"，只记录了 settings/webid，
 * 说明对话流可能走 fetch 而非 XHR（main.js 里 XMLHttpRequest 出现 0 次）。
 * 之前的 fetch 钩子只在"URL 命中白名单且非流式"时处理，几乎等于没有。
 *
 * 本测试验证新的流式包装：
 *   ① 页面仍能完整读到数据（绝不破坏实时输出）
 *   ② 流结束后能把完整内容写入存档
 *   ③ 撤回信号能被正确判定
 *   ④ 关闭开关时完全旁路
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = fs.readFileSync(
    path.resolve(__dirname, '../../app/assets/ds_shell.js'), 'utf8');

var pass = 0, fail = 0, fails = [];

function ev(o) { return 'data: ' + JSON.stringify(o) + '\n\n'; }
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

/**
 * 建立沙箱。
 * 关键：**必须先把假 fetch 装进 sandbox，再执行注入脚本**。
 * 因为脚本在启动时把 window.fetch 包装成 wrappedFetch，内部捕获的是"当时那个"。
 * 之后才替换 sandbox.fetch 是影响不到它的 —— 这一点我踩过。
 */
function makeEnv(cfg, chunks) {
  var logs = [];
  var storage = {};
  var sandbox = {
    Object: Object, Array: Array, JSON: JSON, Date: Date, Math: Math, Error: Error,
    String: String, Number: Number, Boolean: Boolean, RegExp: RegExp, Function: Function,
    parseInt: parseInt, isNaN: isNaN,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    console: console,
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    Uint8Array: Uint8Array,
    ReadableStream: global.ReadableStream,
    Response: global.Response,
    Headers: global.Headers,
    localStorage: {
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null;
      },
      setItem: function (k, v) { storage[k] = String(v); },
      removeItem: function (k) { delete storage[k]; },
      get length() { return Object.keys(storage).length; },
      key: function (i) { return Object.keys(storage)[i] || null; }
    },
    navigator: { userAgent: 'test' },
    document: {
      createElement: function () { return { style: {} }; },
      addEventListener: function () { }
    },
    XMLHttpRequest: function () { this.readyState = 0; this._t = ''; },
    // ↓ 底层 fetch：在脚本注入前就装好
    fetch: function (url, init) {
      return Promise.resolve(makeStreamResponse(chunks));
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.__DS_APP_CFG__ = cfg || { antiRecall: true, debug: false };
  sandbox.DSApp = {
    onRecall: function (s) { logs.push(['onRecall', s]); },
    onArchiveChanged: function (n) { logs.push(['onArchiveChanged', n]); },
    log: function (s) { logs.push(['log', s]); },
    onArchiveError: function (s) { logs.push(['onArchiveError', s]); },
    onReady: function (s) { logs.push(['onReady', s]); },
    onHealth: function (s) { logs.push(['onHealth', s]); },
    onArchiveSnapshot: function (s) { logs.push(['snap', s]); }
  };

  var ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: 'ds_shell.js' });

  return { sandbox: sandbox, storage: storage, logs: logs };
}

/** 把 chunks 组成一个流式 Response（content-type 为 event-stream） */
function makeStreamResponse(chunks) {
  var i = 0;
  var rs = new ReadableStream({
    pull: function (controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(chunks[i++]));
    }
  });
  return new Response(rs, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

/** 用脚本包装后的 fetch 发一次请求，并像前端那样把流读干 */
function consume(e, url) {
  var wrapped = e.sandbox.fetch;   // 已是脚本包装过的
  return Promise.resolve(wrapped(url, {
    method: 'POST',
    body: '{"chat_session_id":"F1"}'
  })).then(function (res) {
    if (!res || !res.body || typeof res.body.getReader !== 'function') return '';
    var reader = res.body.getReader();
    var got = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return got;
        if (r.value) got += new TextDecoder().decode(r.value);
        return pump();
      });
    }
    return pump();
  });
}

/* ---------------- 用例 ---------------- */

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

var CH_NORMAL = [
  ev({ p: '', o: 'SET', v: { response: { message_id: 9901, fragments: [] } } }),
  ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '1.' }] }] }),
  ev({ p: '/response/fragments/0/content', o: 'APPEND', v: '\n\n听到' }),
  ev({ p: '/response/fragments/0/content', o: 'APPEND', v: '你说要减肥' }),
  ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] })
];

var CH_LONG = [
  ev({ p: '', o: 'SET', v: { response: { message_id: 9902, fragments: [] } } }),
  ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '这是足够长的正文内容，用于验证存档是否写入。' }] }] }),
  ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] })
];

var CH_RECALL = [
  ev({ p: '', o: 'SET', v: { response: { message_id: 9903, fragments: [] } } }),
  ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '正文内容够长吧啦啦啦啦啦' }] }] }),
  ev({ p: '/response', o: 'BATCH', v: [
    { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
    { p: '/status', o: 'SET', v: 'CONTENT_FILTER' }
  ] })
];

test('流式 fetch：页面能完整读到数据（不被破坏）', function () {
  var e = makeEnv(null, CH_NORMAL);
  return consume(e, '/api/v9/stream').then(function (got) {
    if (!got || got.length === 0) throw new Error('页面读不到数据');
    if (got.indexOf('1.') < 0) throw new Error('开头内容丢失');
    if (got.indexOf('要减肥') < 0) throw new Error('末尾内容丢失: ' + got.slice(-40));
  });
});

test('流式 fetch：结束后写入存档', function () {
  var e = makeEnv(null, CH_LONG);
  return consume(e, '/api/v9/stream2').then(function () {
    return tick(20);
  }).then(function () {
    var keys = Object.keys(e.storage);
    if (keys.indexOf('__ds_archive_index') < 0) {
      throw new Error('未写入存档索引，keys=' + JSON.stringify(keys));
    }
    var idx = JSON.parse(e.storage['__ds_archive_index']);
    if (idx.length !== 1) throw new Error('应 1 条存档，实际 ' + idx.length);
    var rec = JSON.parse(e.storage['deleted-chat-sess-' + idx[0].sessId + '-msg-' + idx[0].msgId]);
    var txt = (rec.fragments || []).map(function (f) { return f.content; }).join('');
    if (txt.indexOf('足够长的正文') < 0) throw new Error('存档正文不完整: ' + txt);
  });
});

test('流式 fetch：带撤回信号时正确判定', function () {
  var e = makeEnv(null, CH_RECALL);
  return consume(e, '/api/v9/stream3').then(function () {
    return tick(20);
  }).then(function () {
    var idx = JSON.parse(e.storage['__ds_archive_index']);
    if (idx.length !== 1) throw new Error('应 1 条存档');
    if (idx[0].reason !== 'TEMPLATE_RESPONSE') {
      throw new Error('应识别为撤回，实际 ' + idx[0].reason);
    }
  });
});

test('关闭开关时 fetch 完全旁路', function () {
  var e = makeEnv({ antiRecall: false, debug: false }, CH_NORMAL);
  return consume(e, '/api/v9/stream4').then(function () {
    return tick(20);
  }).then(function () {
    var keys = Object.keys(e.storage);
    if (keys.indexOf('__ds_archive_index') >= 0) {
      throw new Error('关闭后不该存档，keys=' + JSON.stringify(keys));
    }
  });
});

test('流式 fetch：非流式 JSON 不被误伤', function () {
  var e = makeEnv(null, [JSON.stringify({ code: 0, data: { user: { id: 1, name: '测试用户' } } })]);
  return consume(e, '/api/v0/users').then(function (got) {
    if (got.indexOf('测试用户') < 0) throw new Error('普通 JSON 应原样返回，实际: ' + got.slice(0, 80));
  });
});

/* ---------------- 串行执行 ---------------- */

console.log('\n=== fetch 流式路径测试 ===\n');

var i = 0;
function next() {
  if (i >= cases.length) {
    console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
    if (fail > 0) {
      fails.forEach(function (f) { console.log('  - ' + f[0] + ': ' + f[1]); });
      process.exit(1);
    }
    console.log('ALL PASS');
    return;
  }
  var c = cases[i++];
  Promise.resolve()
    .then(function () { return c.fn(); })
    .then(function () { pass++; console.log('  PASS  ' + c.name); next(); })
    .catch(function (err) {
      fail++;
      fails.push([c.name, err && err.message]);
      console.log('  FAIL  ' + c.name + '\n        ' + (err && err.message));
      next();
    });
}
next();
