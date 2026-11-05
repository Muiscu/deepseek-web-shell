#!/usr/bin/env node
/**
 * 第二轮对抗测试 —— 专打"这一轮修法新引入的缺陷"。
 *
 * 第一轮的 A1–A19 已全绿，所以这里不再重复它们，而是针对新增代码：
 *   - snapshot()          跨整体 SET 保留旧原文
 *   - __dsFlushedTail     一次性 flush 标记
 *   - 前缀匹配 classify()
 *   - extractReadable()
 *   - lastMsgId 持久性
 *   - 实例级降级 hook（原型无 accessor 路径）
 *
 * 用法：node tools/js-test/audit/adversarial2.js   退出码 1 = 有待确认缺陷
 */
'use strict';

var fs = require('fs');
var path = require('path');
var env = require('../mock/env');

var ROOT = path.resolve(__dirname, '../../..');
var SCRIPT = path.join(ROOT, 'app/assets/ds_shell.js');
var src = fs.readFileSync(SCRIPT, 'utf8');
var NL = String.fromCharCode(10);

var pass = 0, fail = 0, bugs = [];

function ev(o) { return 'data: ' + JSON.stringify(o); }
function read(x) {
  try { void x.responseText; } catch (e) { }
  try { void x.response; } catch (e) { }
}
function feed(x, lines) {
  x._receiveHeaders(200);
  var p = lines.join(NL).split(NL), acc = '';
  for (var i = 0; i < p.length; i++) {
    acc += p[i]; if (i < p.length - 1) acc += NL;
    x._responseText = acc; x.readyState = 3;
    x._emit('progress', {}); x._emit('readystatechange'); read(x);
  }
  x._finish(); read(x);
}
function probe(id, title, fn) {
  try {
    var n = fn();
    pass++;
    console.log('  OK    [' + id + '] ' + title + (n ? '   — ' + n : ''));
  } catch (e) {
    fail++;
    bugs.push({ id: id, title: title, msg: e && e.message });
    console.log('  BUG   [' + id + '] ' + title);
    console.log('        ' + (e && e.message));
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) {
  if (a !== b) throw new Error((m || 'ne') + ' (got ' + JSON.stringify(a)
    + ', want ' + JSON.stringify(b) + ')');
}
function idx(e) {
  var r = e.storage.getItem('__ds_archive_index');
  try { return r ? JSON.parse(r) : []; } catch (x) { return []; }
}

console.log('\n=== round 2: 修法自身引入的风险 ===');
console.log('script: ' + SCRIPT + ' (' + src.length + ' bytes)\n');

/* ================================================================== */
/* C1  snapshot 是否跨消息污染：A 消息撤回后，B 消息被清空不该存 A 的原文   */
/* ================================================================== */
probe('C1', 'snapshot 跨消息污染：上一条的原文不得被当成下一条存档', function () {
  var e = env.createEnv(src);
  var x = new e.XHR();

  // 消息 A：正常生成后被撤回 → 存档 A
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 1001, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: 'AAA-上一条的机密原文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  eq(e.shell.count(), 1, '前置：A 应已存档');

  // 同一实例，消息 B：先被清空，再被过滤（本该"未找到"，不能拿到 A 的原文）
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 1002, fragments: [] } } }),
    ev({ p: 'response', o: 'SET', v: {} }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);

  var recB = JSON.parse(e.storage.getItem('deleted-chat-sess-S-msg-1002') || 'null');
  if (!recB) return 'B 未存档（可接受：无正文可救）';
  var txt = JSON.stringify(recB.fragments);
  assert(txt.indexOf('AAA-上一条的机密原文') < 0,
    '消息 B 的存档里出现了消息 A 的原文 —— snapshot 未随整体 SET 重置，'
    + '会把上一条内容的原文错挂到下一条 msgId 上（history 还原时会显示串内容）');
});

/* ================================================================== */
/* C2  snapshot 跨会话污染                                              */
/* ================================================================== */
probe('C2', 'snapshot 跨会话污染：不同 chat_session_id 的原文不得互串', function () {
  var e = env.createEnv(src);
  var x1 = new e.XHR();
  x1.open('POST', '/api/v0/chat/completion');
  x1.send(JSON.stringify({ chat_session_id: 'SESS-X' }));
  feed(x1, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 2001, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: 'X会话的机密原文' }] }] }),
    ''
  ]);

  var x2 = new e.XHR();   // 新请求（新实例）——snapshot 是 per-request，应无污染
  x2.open('POST', '/api/v0/chat/completion');
  x2.send(JSON.stringify({ chat_session_id: 'SESS-Y' }));
  feed(x2, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 2002, fragments: [] } } }),
    ev({ p: 'response', o: 'SET', v: {} }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-SESS-Y-msg-2002') || 'null');
  if (!rec) return 'Y 未存档（可接受）';
  assert(JSON.stringify(rec.fragments).indexOf('X会话的机密原文') < 0,
    'SESS-Y 的存档里出现了 SESS-X 的原文（跨会话串内容）');
});

/* ================================================================== */
/* C3  __dsFlushedTail 在 open 复用后是否重置                            */
/* ================================================================== */
probe('C3', 'XHR 复用第二次请求的尾部 flush 是否被旧 __dsFlushedTail 挡住', function () {
  var e = env.createEnv(src);
  var x = new e.XHR();

  // 第一次：正常结束（会把 __dsFlushedTail 置 true）
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 3001, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }),
    ''
  ]);

  // 第二次：复用，撤回在末尾且无换行（必须 flush 才有效）
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  var head = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 3002, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '第二次的正文' }] }] })
  ];
  x._receiveHeaders(200);
  x._responseText = head.join(NL) + NL
    + ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] });
  x.readyState = 3; x._emit('progress', {}); read(x);
  x._finish(); read(x);

  assert(x.responseText.indexOf('TEMPLATE_RESPONSE') === -1,
    '__dsFlushedTail 未在 open 里重置：复用实例的第二次请求尾部不 flush，'
    + '记录里的 "结束态尾部只处理一次" 标记是 per-实例而非 per-请求');
  // 第一次请求没有正文也没有撤回，所以只有第二次应产生 1 条存档
  assert(e.shell.count() >= 1, '第二次的撤回应存档（当前总数 ' + e.shell.count() + '）');
  var it = idx(e);
  eq(String(it[it.length - 1].msgId), '3002', '存档 msgId 应为第二次的 3002');
});

/* ================================================================== */
/* C1b snapshot 在同一请求内重放时是否串内容                             */
/* ================================================================== */
probe('C1b', 'snapshot 在同一请求内重放（整体 SET 换 msgId）时不得串内容', function () {
  var e = env.createEnv(src);
  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/resume_stream');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  feed(x, [
    // 消息 A：有正文
    ev({ p: '', o: 'SET', v: { response: { message_id: 1101, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: 'A-机密原文' },
          { id: 3, type: 'ANSWER', content: 'A-第二段' }] }] }),
    // 重放：切到消息 B，且 B 没有内容
    ev({ p: '', o: 'SET', v: { response: { message_id: 1102, fragments: [] } } }),
    ev({ p: 'response', o: 'SET', v: {} }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  var recB = JSON.parse(e.storage.getItem('deleted-chat-sess-S-msg-1102') || 'null');
  if (!recB) return 'B 未存档（可接受）';
  assert(JSON.stringify(recB.fragments).indexOf('A-机密原文') < 0,
    '消息 B(1102) 的存档里写进了消息 A(1101) 的原文 —— snapshot 未随整体 SET 重置，'
    + 'history 还原时会把 A 的内容显示在 B 的位置');
});

/* ================================================================== */
/* C4  前缀匹配是否会误判普通接口                                       */
/* ================================================================== */
probe('C4', '前缀匹配误判：/api/v0/chat/completion 前缀会吞掉无关接口', function () {
  var e = env.createEnv(src);
  var hit = [];

  // 这些都不该被判为 generate/history，否则普通 JSON 接口会被 SSE 解析
  var cases = [
    '/api/v0/chat/completion_status',
    '/api/v0/chat/history_messages_read',
    '/api/v0/chat/continue_stop',
    '/api/v0/chat/edit_message_draft',
    '/api/v0/chat/regenerate_preview'
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = e.shell._internals.classify(cases[i]);
    if (c) hit.push(cases[i] + ' → ' + c);
  }
  assert(hit.length === 0,
    '前缀匹配把无关接口判成 generate/history（会被当 SSE/JSON 篡改，属误伤）：'
    + hit.join('; '));
});

/* ================================================================== */
/* C5  普通接口误判后的实际后果（不只是 classify 返回非空）               */
/* ================================================================== */
probe('C5', '误判后普通 JSON 响应是否被破坏（端到端）', function () {
  var e = env.createEnv(src);
  var body = '{"biz_code":0,"data":{"status":"ok","text":"用户资料"}}';
  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion_quota');   // 假设存在这种相邻接口
  x.send('{}');
  x.status = 200; x.readyState = 4; x._responseText = body;
  x._emit('readystatechange'); read(x);
  eq(x.responseText, body, '普通 JSON 接口的响应被 hook 改动（前缀匹配误伤）');
});

/* ================================================================== */
/* C6  lastMsgId 是否跨请求残留（新实例/复用）                          */
/* ================================================================== */
probe('C6', 'lastMsgId 残留：复用实例时旧 message_id 不得覆盖缺失的新消息', function () {
  var e = env.createEnv(src);
  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 4001, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '第一条' }] }] }),
    ''
  ]);

  // 复用：新消息仍带 message_id
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 4002, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '第二条' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  var it = idx(e);
  // 允许第一条也存（正常流没撤回则只有 1 条）
  var ids = it.map(function (r) { return String(r.msgId); });
  assert(ids.indexOf('4001') < 0 || ids.indexOf('4002') >= 0,
    '第二条消息的存档被写进了旧 msgId 4001（lastMsgId 残留污染）: ' + ids.join(','));
});

/* ================================================================== */
/* C7  extractReadable 是否会把 TIP 之前的旧 TIP 也带进新数组           */
/* ================================================================== */
probe('C7', 'extractReadable 去重：无存档时不得叠加出多个 TIP', function () {
  var e = env.createEnv(src);
  e.shell._internals.setEnabled ? e.shell._internals.setEnabled(true) : 0;
  var json = JSON.stringify({
    data: { biz_data: { chat_session: { id: 'S7' }, chat_messages: [{
      message_id: 7001, status: 'CONTENT_FILTER',
      fragments: [
        { id: 2, type: 'TIP', style: 'WARNING', content: '旧提示' },
        { id: 3, type: 'ANSWER', content: '可读正文' },
        { id: 4, type: 'TIP', style: 'WARNING', content: '旧提示2' }
      ] }] } }
  });
  var out = JSON.parse(e.shell._internals.restoreHistory(json));
  var fr = out.data.biz_data.chat_messages[0].fragments;
  var tips = fr.filter(function (f) { return f.type === 'TIP'; });
  eq(tips.length, 1, 'TIP 数量应为 1（只追加一条），实际 ' + tips.length
    + '；fragments=' + JSON.stringify(fr));
  assert(JSON.stringify(fr).indexOf('可读正文') >= 0, '可读正文应保留');
});

/* ================================================================== */
/* C8  实例级降级 hook：原型无 accessor 时是否还能工作                   */
/* ================================================================== */
probe('C8', '降级层专项已拆出：见 audit/fallback.js (F1–F5)', function () {
  return '详见 audit/fallback.js';
});

/* C9  降级层的 start：open 里不重置 __dsFlushedTail，同上                */
/* ================================================================== */
probe('C9', '整体 SET 后 response.status 也清空：不进 inspect 是否会残留旧状态', function () {
  var e = env.createEnv(src);
  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S9' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 9001, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '正文9' }] }] }),
    // 整体 SET 成 {} 后紧跟 status 过滤
    ev({ p: 'response', o: 'SET', v: {} }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-S9-msg-9001') || 'null');
  assert(rec, '整体 SET 成 {} 后应仍能按 9001 存档');
  assert(JSON.stringify(rec.fragments).indexOf('正文9') >= 0, '存档应含原始正文');
  assert(x.responseText.indexOf('CONTENT_FILTER') === -1, 'status 应改为 FINISHED');
  // 而且 msgId 不能被替换成 auto- 合成 key
  var it = idx(e);
  eq(String(it[0].msgId), '9001', 'msgId 不应退化成 auto- 合成键');
});

/* ================================================================== */
/* C10  SSE 中 data: 前缀后无空格（协议允许）                            */
/* ================================================================== */
probe('C10', 'SSE 的 "data:" 后无空格（协议允许）是否仍能解析', function () {
  var e = env.createEnv(src);
  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S10' }));
  // 注意：没有空格
  feed(x, [
    'data:' + JSON.stringify({ p: '', o: 'SET', v: { response: { message_id: 10001, fragments: [] } } }),
    'data:' + JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '无空格正文' }] }] }),
    'data:' + JSON.stringify({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  assert(x.responseText.indexOf('TEMPLATE_RESPONSE') === -1,
    '"data:" 后无空格的合法 SSE 未被处理（SSE 规范只要求冒号后可选的单个空格，'
    + '若服务端/代理改格式会静默失效）');
  assert(e.shell.count() >= 1, '应存档');
});

/* ================================================================== */
console.log('\n=== ' + pass + ' ok, ' + fail + ' bug(s) pending ===');
if (fail) {
  console.log('\npending:');
  for (var i = 0; i < bugs.length; i++) {
    console.log('  [' + bugs[i].id + '] ' + bugs[i].title);
    console.log('      ' + bugs[i].msg);
  }
  process.exit(1);
}
console.log('no new defects');
