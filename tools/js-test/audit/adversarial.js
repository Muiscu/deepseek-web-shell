#!/usr/bin/env node
/**
 * ds_shell.js 对抗性测试（只读审查用，不修改 app/）
 *
 * 用法：  node tools/js-test/audit/adversarial.js
 * 退出码：0 = 所有"期望正确行为"都成立；1 = 至少一个真 bug 被确认（下方打印清单）
 *
 * 设计原则：
 *  - 每个 probe 断言的都是"**正确**行为应为怎样"，因此失败 = 确认 bug；
 *  - 全部用 tools/js-test/mock/{env,xhr}.js，不新增 mock，不改 app/；
 *  - 驱动的关键：mock XHR 只在**页面读取 responseText/response** 时才触发钩子，
 *    所以每个 chunk 后必须读一次 responseText（模拟真实 SSE 解析器）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var env = require('../mock/env');

var ROOT = path.resolve(__dirname, '../../..');
var SCRIPT_PATH = path.join(ROOT, 'app/assets/ds_shell.js');
var src = fs.readFileSync(SCRIPT_PATH, 'utf8');

var NL = String.fromCharCode(10);
var pass = 0, fail = 0;
var bugs = [];

function ev(obj) { return 'data: ' + JSON.stringify(obj); }

/* ------------------------------------------------------------------ */
/* 最小 harness                                                       */
/* ------------------------------------------------------------------ */
function probe(id, title, fn) {
  try {
    var note = fn();
    pass++;
    console.log('  OK    [' + id + '] ' + title + (note ? '   — ' + note : ''));
  } catch (e) {
    fail++;
    bugs.push({ id: id, title: title, err: e });
    console.log('  BUG   [' + id + '] ' + title);
    console.log('        ' + (e && e.message ? e.message : e));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ' (got ' + JSON.stringify(a)
      + ', want ' + JSON.stringify(b) + ')');
}

/** 按真实时序喂 SSE：每行一次 progress + 读一次 responseText */
function feed(xhr, lines, offsetStart) {
  xhr._receiveHeaders(200);
  var parts = lines.join(NL).split(NL);
  var acc = '';
  for (var i = 0; i < parts.length; i++) {
    acc += parts[i];
    if (i < parts.length - 1) acc += NL;
    xhr._responseText = acc;
    xhr.readyState = 3;
    xhr._emit('progress', { type: 'progress', loaded: acc.length, total: 0 });
    xhr._emit('readystatechange');
    read(xhr);
  }
  xhr._finish();
  read(xhr);
}

/** 模拟前端 SSE 解析器读取（不抛） */
function read(xhr) {
  try { void xhr.responseText; } catch (e) { }
  try { void xhr.response; } catch (e) { }
}

/** 完成一次 generate 请求 */
function gen(e, url, body, lines) {
  var xhr = new e.XHR();
  xhr.open('POST', url || '/api/v0/chat/completion');
  xhr.setRequestHeader('x-client-locale', 'zh_CN');
  xhr.send(JSON.stringify(body || { chat_session_id: 'S' }));
  feed(xhr, lines);
  return xhr;
}

/** 完成一次 history 请求（readyState 4 时注入 JSON） */
function hist(e, url, json) {
  var xhr = new e.XHR();
  xhr.responseType = 'text';
  xhr.open('POST', url || '/api/v0/chat/history_messages');
  xhr.send('{}');
  xhr.status = 200;
  xhr.readyState = 4;
  xhr._responseText = json;
  xhr._emit('readystatechange');
  read(xhr);
  return xhr;
}

function idx(e) {
  var raw = e.storage.getItem('__ds_archive_index');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (err) { return []; }
}

/** 标准 SSE 重新解析：验证篡改后流结构合法 */
function sseParse(text) {
  var out = [];
  var lines = text.split(NL);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf('data:') !== 0) continue;
    var p = l.substring(5);
    if (p.charAt(0) === ' ') p = p.substring(1);
    if (p === '[DONE]' || p.length === 0) continue;
    out.push(JSON.parse(p));   // 不合法就直接抛
  }
  return out;
}

/* 常用剧本 */
function baseStream(msgId) {
  return [
    ev({ p: '', o: 'SET', v: { response: { message_id: msgId, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'THINKING', content: '思考内容A' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 3, type: 'ANSWER', content: '正文第一段' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 4, type: 'ANSWER', content: '正文第二段' }] }] })
  ];
}

console.log('\n=== ds_shell.js adversarial audit ===');
console.log('script: ' + SCRIPT_PATH + ' (' + src.length + ' bytes)\n');

/* ================================================================== */
/* A1  XHR 实例复用（open 两次）                                        */
/* ================================================================== */
probe('A1', 'XHR 复用：同一实例 open 两次做第二请求，流是否被旧改写污染', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();

  // 第一次请求：命中撤回 → 产生 __dsRewrites 与 __dsState
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S1' }));
  var l1 = [ev({ p: '', o: 'SET', v: { response: { message_id: 101, fragments: [] } } })];
  for (var z = 0; z < 5; z++) {
    l1.push(ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2 + z, type: 'ANSWER',
        content: '第一次请求的第' + z + '段（会被撤回）' }] }] }));
  }
  l1.push(ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
    { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }));
  l1.push('');
  feed(xhr, l1);
  assert(e.shell.count() === 1, '前置：第一次应存档 1 条');

  // 第二次请求：复用**同一个 XHR 实例**（open 重发），内容完全不同且**更长**。
  // 关键：必须让长度不同，否则旧偏移恰好落在合法位置会掩盖缺陷。
  var l2 = [ev({ p: '', o: 'SET', v: { response: { message_id: 202, fragments: [] } } })];
  for (var q = 0; q < 40; q++) {
    l2.push(ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2 + q, type: 'ANSWER',
        content: '第二次请求第' + q + '段正文' }] }] }));
  }
  l2.push(ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }));
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S2' }));
  feed(xhr, l2);

  var out = xhr.responseText;
  var want = l2.join(NL);
  if (out === want) return;
  var at = -1;
  for (var i = 0; i < want.length && i < out.length; i++) {
    if (want.charAt(i) !== out.charAt(i)) { at = i; break; }
  }
  throw new Error('XHR 复用后第二次响应被污染（open 未重置 __dsRewrites/__dsState）；'
      + '首次污染位置=' + at
      + '；该处应为本请求第 ' + Math.floor(at / 140) + ' 段附近正文，'
      + '实际插入了上一次请求的 TIP/FINISHED 改写；'
      + '长度 out=' + out.length + ' want=' + want.length);
});

/* ================================================================== */
/* A2  resume_stream：新实例，重放 + 撤回                               */
/* ================================================================== */
probe('A2', 'resume_stream：正常存档（无复用时不应有问题）', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/resume_stream');
  xhr.send(JSON.stringify({ chat_session_id: 'SR', session_id: 'SR' }));
  assert(xhr.__dsSessId === 'SR', 'resume_stream 应能从 body 取到 sessId');

  var lines = baseStream(77).concat([
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  feed(xhr, lines);

  eq(e.shell.count(), 1);
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-SR-msg-77'));
  assert(rec && rec.fragments.length === 3, '应保留 3 个原始片段');
});

/* ================================================================== */
/* A2b resume_stream 重放：同一实例上再发一次整体 response 对象           */
/* ================================================================== */
probe('A2b', 'resume_stream 重放：第二个整体 response 事件能否更新 state', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/resume_stream');
  xhr.send(JSON.stringify({ chat_session_id: 'SR2' }));

  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 300, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '前半段' }] }] }),
    // 重放：服务器把整体 response 再 SET 一次（新会话段/新 message_id）
    ev({ p: '', o: 'SET', v: { response: { message_id: 301, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '重放后的正文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ];
  feed(xhr, lines);

  var items = idx(e);
  assert(items.length === 1, '应存档 1 条，实际 ' + items.length);
  eq(items[0].msgId, 301, '存档 msgId 应来自最近一次整体 SET');
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-SR2-msg-301'));
  assert(rec, 'msgId=301 的存档不存在（state 未随第二次整体 SET 更新）');
});

/* ================================================================== */
/* A3  response 整体 SET 成 {}                                          */
/* ================================================================== */
probe('A3', 'response 被整体 SET 成 {} 后再 CONTENT_FILTER：原文是否还能存档', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S3' }));

  var lines = baseStream(400).concat([
    // 服务器清空 response（协议里 SET 一个空对象）
    ev({ p: 'response', o: 'SET', v: {} }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  feed(xhr, lines);

  var out = xhr.responseText;
  assert(out.indexOf('CONTENT_FILTER') === -1, 'CONTENT_FILTER 应被改成 FINISHED（当前被改了）');
  assert(e.shell.count() >= 1, '清空 response 后原文应仍被存档（当前存档 ' + e.shell.count() + ' 条）');
  eq(e.bridgeCalls('onRecall').length >= 1, true, '应上报 onRecall');
});

/* ================================================================== */
/* A4  fragments SET 成 [] 后再过滤                                     */
/* ================================================================== */
probe('A4', 'fragments 先被 SET 成 []，随后独立事件 CONTENT_FILTER：是否丢存档', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S4' }));

  var lines = baseStream(500).concat([
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'SET', v: [] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  feed(xhr, lines);

  assert(e.shell.count() >= 1,
      'fragments 被清空后应仍能存档（当前 ' + e.shell.count() + ' 条）—— 清空与过滤分两事件时原文彻底丢失');
});

/* ================================================================== */
/* A5  op.o 缺省（协议默认 SET）                                        */
/* ================================================================== */
probe('A5', 'BATCH 内 fragments 操作省略 o（协议默认 SET）时是否漏检撤回', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S5' }));

  var lines = baseStream(600).concat([
    // 注意：没有 o 字段 —— SSE 协议默认 SET，原脚本对此不区分，照样命中
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  feed(xhr, lines);

  var out = xhr.responseText;
  assert(out.indexOf('TEMPLATE_RESPONSE') === -1,
      'op.o 缺省时占位模板没被替换 → 撤回漏检（原脚本命中，本实现漏检 = 回归）');
  assert(e.shell.count() >= 1, '应存档（当前 ' + e.shell.count() + ' 条）');
});

/* ================================================================== */
/* A6  msgId 缺失                                                      */
/* ================================================================== */
probe('A6', 'msgId 缺失（服务器不发 message_id）时的存档 key / 行为', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S6' }));

  var lines = [
    // 首个整体事件里没有 message_id
    ev({ p: '', o: 'SET', v: { response: { fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '会被拦截的正文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ];
  feed(xhr, lines);

  // 断言：绝不能写出 msgId-undefined 这种 key
  var dump = e.storage._dump();
  var badKey = null;
  for (var k in dump) {
    if (dump.hasOwnProperty(k) && k.indexOf('msgId-undefined') >= 0) badKey = k;
  }
  assert(badKey === null, '写出了非法 key: ' + badKey);

  // 断言：正文必须被存档（否则等于静默丢数据）
  assert(e.shell.count() >= 1,
      'msgId 缺失时未存档 → 正文静默丢失（当前 count=' + e.shell.count()
      + '；key 未变 undefined，但存档被 msgId!==undefined 守卫整段跳过）');
});

/* ================================================================== */
/* A7  末尾行没有换行                                                   */
/* ================================================================== */
probe('A7', '撤回事件位于流末尾且末尾无换行符时是否漏检', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S7' }));

  // 注意：没有末尾 ''，也就是最后一行不以 \n 结束
  var lines = baseStream(700).concat([
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] })
  ]);
  feed(xhr, lines);

  // 流已结束（readyState=4）时，末尾那个"没有换行结尾"的行必须被 flush 处理；
  // 否则服务端不以 \n 收尾、或 xhr.abort()（用户点停止）时，撤回会整段漏掉。
  var out = xhr.responseText;
  assert(out.indexOf('TEMPLATE_RESPONSE') === -1,
      'readyState=4 时末尾无换行的撤回行未被处理 → TIP 未出现、原文未存档');
  assert(e.shell.count() >= 1, '应存档（当前 ' + e.shell.count() + ' 条）');
});

/* ================================================================== */
/* A8  超长单行 1MB 无换行                                             */
/* ================================================================== */
probe('A8', '单行 1MB 无换行：不崩、不卡（只做增量扫描）', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S8' }));

  var big = new Array(1024 * 1024 + 1).join('x');
  var oneLine = ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: big }] }] });

  xhr._receiveHeaders(200);
  var t0 = Date.now();
  // 模拟分 40 次到达的半行数据（每次都没有换行 → 不该被反复重切全部）
  var cut = Math.ceil(oneLine.length / 40);
  for (var i = 1; i <= 40; i++) {
    xhr._responseText = oneLine.substring(0, Math.min(i * cut, oneLine.length));
    xhr.readyState = 3;
    xhr._emit('progress', { type: 'progress', loaded: xhr._responseText.length, total: 0 });
    read(xhr);
  }
  xhr._finish();
  read(xhr);
  var dt = Date.now() - t0;

  assert(xhr.responseText === oneLine, '超长半行不应被改动');
  assert(dt < 2000, '处理 1MB 半行耗时 ' + dt + 'ms，疑似反复重切全长（O(n²)）');
  return dt + 'ms';
});

/* ================================================================== */
/* A9  同一文本重复读取 100 次                                          */
/* ================================================================== */
probe('A9', '同一 SSE 行被 getter 重复读取 100 次：不重复存档 / 不重复上报', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S9' }));

  var lines = baseStream(900).concat([
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  // 一次性喂完（模拟"整段已到"），然后高频读
  xhr._receiveHeaders(200);
  xhr._responseText = lines.join(NL);
  xhr.readyState = 3;
  for (var n = 0; n < 100; n++) read(xhr);
  xhr._finish();
  for (var m = 0; m < 100; m++) read(xhr);

  eq(e.shell.count(), 1, '应只有 1 条存档（重复读导致多条 = 索引污染）');
  eq(e.bridgeCalls('onRecall').length, 1,
      'onRecall 应只上报 1 次（实际 ' + e.bridgeCalls('onRecall').length + ' 次）');
  eq(e.bridgeCalls('onArchiveChanged').length >= 1, true, '应有 onArchiveChanged');
  assert(xhr.responseText.indexOf('TEMPLATE_RESPONSE') === -1, 'TIP 应稳定存在');
  // 100 次高频读取后，改写必须逐次幂等（同一文本连续读两次结果必须相同）
  var a = xhr.responseText;
  read(xhr);
  var b = xhr.responseText;
  eq(b, a, '重复读取导致返回值漂移（rewrite 重放不幂等）');
});

/* ================================================================== */
/* A10  用户主动停止                                                    */
/* ================================================================== */
probe('A10', 'status→STOPPED（用户点停止）不得被误判为撤回', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S10' }));

  var lines = baseStream(1000).concat([
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'STOPPED' }] }),
    ''
  ]);
  feed(xhr, lines);

  eq(xhr.responseText, lines.join(NL), 'STOPPED 流不应被篡改');
  eq(e.shell.count(), 0, 'STOPPED 不应产生存档');
  eq(e.bridgeCalls('onRecall').length, 0, 'STOPPED 不应上报撤回');
});

/* ================================================================== */
/* A11  localStorage 连 getItem 都抛                                    */
/* ================================================================== */
probe('A11', 'localStorage 的 getItem 与 setItem 全部抛异常：不崩、不静默错乱', function () {
  var e = env.createEnv(src);
  // 安装后把 localStorage 换成彻底坏掉的实现（storage() 是懒取的）
  var boom = {
    getItem: function () { var x = new Error('SecurityError'); x.name = 'SecurityError'; throw x; },
    setItem: function () { var x = new Error('SecurityError'); x.name = 'SecurityError'; throw x; },
    removeItem: function () { var x = new Error('SecurityError'); x.name = 'SecurityError'; throw x; }
  };
  e.sandbox.localStorage = boom;

  assert(e.shell.count() === 0, 'count() 在存储全抛时应返回 0 而不是抛');
  assert(typeof e.shell.exportArchive() === 'string', 'exportArchive() 应返回字符串');
  JSON.parse(e.shell.exportArchive());

  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S11' }));
  var lines = baseStream(1100).concat([
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  feed(xhr, lines);   // 不得抛

  assert(xhr.responseText.indexOf('TEMPLATE_RESPONSE') === -1, '存储坏掉也必须给出 TIP');
  assert(e.bridgeCalls('onArchiveError').length >= 1, '应上报 onArchiveError');
  // 内存降级：索引可能在内存里；无论如何 count 不得抛
  assert(e.shell.count() >= 0);
  return 'count=' + e.shell.count();
});

/* ================================================================== */
/* A12  关闭开关后的残留副作用                                          */
/* ================================================================== */
probe('A12', 'setEnabled(false) 后：零篡改、零存档、零 bridge（onRecall/log 不应被调）', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true, debug: true } });
  e.shell.setEnabled(false);
  eq(e.shell.isEnabled(), false);

  var before = e.log.length;

  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.setRequestHeader('x-client-locale', 'zh_CN');
  xhr.send(JSON.stringify({ chat_session_id: 'S12' }));
  var lines = baseStream(1200).concat([
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  feed(xhr, lines);

  eq(xhr.responseText, lines.join(NL), '关闭后流不得被改');
  eq(e.shell.count(), 0, '关闭后不得存档');

  var after = e.log.slice(before);
  var recall = after.filter(function (x) { return x.m === 'onRecall'; });
  eq(recall.length, 0, '关闭后仍上报了 onRecall: ' + JSON.stringify(recall));
  var warns = after.filter(function (x) { return x.m === 'log'; });
  eq(warns.length, 0, '关闭后仍产生了 debug bridge log（应为 0，实际 '
      + warns.length + ': ' + JSON.stringify(warns.slice(0, 2)) + '）');

  // 历史侧也不得改动
  var h = hist(e, '/api/v0/chat/history_messages', JSON.stringify({
    data: { biz_data: { chat_session: { id: 'S12' },
      chat_messages: [{ message_id: 1200, status: 'CONTENT_FILTER', fragments: [] }] } }
  }));
  var j = JSON.parse(h.responseText);
  eq(j.data.biz_data.chat_messages[0].status, 'CONTENT_FILTER', '关闭后 history 不得被改');
});

/* ================================================================== */
/* A13  history 走 responseType=json                                    */
/* ================================================================== */
probe('A13', 'history 用 responseType="json" 时能否还原（真实浏览器 responseText 会抛）', function () {
  var e = env.createEnv(src);

  // 先造存档：msgId 1300 / sess-json
  gen(e, '/api/v0/chat/completion', { chat_session_id: 'sess-json' },
      baseStream(1300).concat([
        ev({ p: 'response', o: 'BATCH', v: [
          { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
        ''
      ]));
  eq(e.shell.count(), 1, '前置存档失败');

  // 历史请求：前端若把 responseType 设为 json（自研库默认 text，但 json 是合法调用）
  var xhr = new e.XHR();
  xhr.responseType = 'json';
  xhr.open('POST', '/api/v0/chat/history_messages');
  xhr.send('{}');
  xhr.status = 200;
  xhr.readyState = 4;
  xhr._responseText = JSON.stringify({
    data: { biz_data: { chat_session: { id: 'sess-json' },
      chat_messages: [{ message_id: 1300, status: 'CONTENT_FILTER',
        fragments: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] } }
  });
  xhr._emit('readystatechange');

  var obj = xhr.response;   // json 模式下页面读的是对象
  assert(obj && typeof obj === 'object', 'json 模式应返回对象');
  eq(obj.data.biz_data.chat_messages[0].status, 'FINISHED',
      'responseType=json 时 history 未被还原（rawText 抛 InvalidStateError → compute 返回 null → 直通）');
  assert(obj.data.biz_data.chat_messages[0].fragments[0].type !== 'TEMPLATE_RESPONSE',
      'json 模式未还原原文片段');
});

/* ================================================================== */
/* A14  历史无存档时是否会破坏已有可见 fragments                         */
/* ================================================================== */
probe('A14', 'history 无存档但服务器仍带着可读 fragments：不得被 TIP 顶掉', function () {
  var e = env.createEnv(src);
  var json = JSON.stringify({
    data: { biz_data: { chat_session: { id: 'S14' },
      chat_messages: [{
        message_id: 1400,
        status: 'CONTENT_FILTER',
        fragments: [{ id: 2, type: 'ANSWER', content: '服务器仍返回的可读正文' }]
      }] } }
  });
  var xhr = hist(e, '/api/v0/chat/history_messages', json);
  var j = JSON.parse(xhr.responseText);
  var msg = j.data.biz_data.chat_messages[0];
  var hasText = JSON.stringify(msg.fragments).indexOf('服务器仍返回的可读正文') >= 0;
  assert(hasText, '无存档时把服务器仍在返回的正文整体替换成 TIP，可见内容被破坏');
  eq(msg.status, 'FINISHED');
  assert(msg.fragments[msg.fragments.length - 1].type === 'TIP', '应附带提示');
});

/* ================================================================== */
/* A15  fetch_page：sess 不在 chat_session.id                            */
/* ================================================================== */
probe('A15', 'fetch_page 分页：session id 只在 message 上时能否匹配存档', function () {
  var e = env.createEnv(src);

  gen(e, '/api/v0/chat/completion', { chat_session_id: 'sess-page' },
      baseStream(1500).concat([
        ev({ p: 'response', o: 'BATCH', v: [
          { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
        ''
      ]));
  eq(e.shell.count(), 1, '前置存档失败');

  // 分页接口常见形态：没有 chat_session 对象，session id 在每条消息上
  var json = JSON.stringify({
    data: { biz_data: { chat_messages: [
      { message_id: 1500, chat_session_id: 'sess-page', status: 'CONTENT_FILTER',
        fragments: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }
    ] } }
  });
  var xhr = hist(e, '/api/v0/chat/fetch_page', json);
  var j = JSON.parse(xhr.responseText);
  var msg = j.data.biz_data.chat_messages[0];
  assert(msg.status === 'FINISHED', 'status 被改（说明 walk 到了）');
  assert(msg.fragments[0].type !== 'TEMPLATE_RESPONSE',
      'sess 只挂在 message 上时匹配失败 → 明明有存档却显示"未找到"');
});

/* ================================================================== */
/* A16  篡改后的流能被标准 SSE 解析器重新解析                           */
/* ================================================================== */
probe('A16', '篡改后的 SSE 行必须是合法 JSON 且结构完整（无残破行）', function () {
  var e = env.createEnv(src);
  var xhr = gen(e, '/api/v0/chat/completion', { chat_session_id: 'S16' },
      baseStream(1600).concat([
        ev({ p: 'response', o: 'BATCH', v: [
          { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
          { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
        ''
      ]));

  var out = xhr.responseText;
  assert(out.charAt(out.length - 1) === NL, '末尾换行被破坏，流语义变了');
  var events = sseParse(out);
  assert(events.length >= 5, '事件数异常: ' + events.length);
  // 每一行 data: 后必须能 parse，且被改写的行仍保持 p/o/v 结构
  var hasTip = false, hasFinished = false;
  for (var i = 0; i < events.length; i++) {
    var ev0 = events[i];
    if (ev0 && ev0.v) {
      for (var k = 0; k < ev0.v.length; k++) {
        var op = ev0.v[k];
        if (op && op.p === 'fragments' && op.o === 'APPEND' && op.v
            && op.v[0] && op.v[0].type === 'TIP') hasTip = true;
        if (op && op.p === 'status' && op.v === 'FINISHED') hasFinished = true;
      }
    }
  }
  assert(hasTip, '篡改后应出现 TIP APPEND 操作');
  assert(hasFinished, 'status 应被改成 FINISHED');
});

/* ================================================================== */
/* A17  ES5 纯度（acorn）                                              */
/* ================================================================== */
probe('A17', 'ES5 语法（acorn ecmaVersion=5, sourceType=script）', function () {
  var acorn = require('acorn');
  acorn.parse(src, { ecmaVersion: 5, sourceType: 'script' });
  // catch 必须带绑定名
  var bad = /catch\s*\{/.test(src);
  assert(!bad, '存在无绑定名的 catch{}');
});

/* ================================================================== */
/* A18  存档可原样还原（片段结构保留）                                  */
/* ================================================================== */
probe('A18', '存档保留 {id,type,content,style?}，还原后思考链/样式不丢', function () {
  var e = env.createEnv(src);
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 1800, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'THINKING', content: '推理中' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 3, type: 'ANSWER', content: '代码块', style: 'CODE' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ];
  var xhr = gen(e, '/api/v0/chat/completion', { chat_session_id: 'S18' }, lines);

  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-S18-msg-1800'));
  assert(rec && rec.fragments.length === 2, '片段数应为 2，实际 '
      + (rec ? rec.fragments.length : 'no rec'));
  eq(rec.fragments[1].style, 'CODE', 'style 字段丢失');
  eq(rec.fragments[0].id, 2);
  eq(rec.fragments[1].id, 3);
  eq(rec.fragments[0].content, '推理中');

  // 再还原
  var h = hist(e, '/api/v0/chat/history_messages', JSON.stringify({
    data: { biz_data: { chat_session: { id: 'S18' },
      chat_messages: [{ message_id: 1800, status: 'CONTENT_FILTER', fragments: [] }] } }
  }));
  var j = JSON.parse(h.responseText);
  var msg = j.data.biz_data.chat_messages[0];
  eq(msg.fragments[1].style, 'CODE', '还原后 style 丢失');
  assert(xhr.responseText.indexOf('TEMPLATE_RESPONSE') === -1);
});

/* ================================================================== */
/* A19  长对话 + 撤回：性能与正确性                                     */
/* ================================================================== */
probe('A19', '300 事件/900KB 长对话尾部撤回：性能线性且存档完整', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S19' }));

  var big = new Array(3000 + 1).join('x');
  var lines = [ev({ p: '', o: 'SET', v: { response: { message_id: 1900, fragments: [] } } })];
  for (var i = 0; i < 300; i++) {
    lines.push(ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2 + i, type: 'ANSWER', content: big }] }] }));
  }
  lines.push(ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
    { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }));
  lines.push('');

  var t0 = Date.now();
  feed(xhr, lines);
  var dt = Date.now() - t0;

  etotal(xhr.responseText);
  eq(e.shell.count(), 1, '应存档 1 条');
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-S19-msg-1900'));
  eq(rec.fragments.length, 300, '300 个片段应全部存档，实际 ' + rec.fragments.length);
  assert(dt < 4000, '耗时 ' + dt + 'ms 偏高（疑似 O(n²)）');
  return (xhr.responseText.length / 1024).toFixed(0) + 'KB / ' + dt + 'ms';
});
function etotal(t) { assert(t.length > 800 * 1024, '文本量不足: ' + t.length); }

/* ================================================================== */
console.log('\n=== ' + pass + ' ok, ' + fail + ' bug(s) confirmed ===');
if (fail > 0) {
  console.log('\nconfirmed bugs:');
  for (var i = 0; i < bugs.length; i++) {
    console.log('  [' + bugs[i].id + '] ' + bugs[i].title);
    console.log('      ' + (bugs[i].err && bugs[i].err.message));
  }
  process.exit(1);
}
console.log('no defects found');
