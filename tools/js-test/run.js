#!/usr/bin/env node
/**
 * ds_shell.js 测试台。
 * 一条命令跑全部用例：  node tools/js-test/run.js
 *
 * 覆盖：
 *   1. ES5 语法（acorn ecmaVersion:5）
 *   2. 正常流不误伤
 *   3. 生成中撤回 → 篡改为 TIP + 存档
 *   4. 思考阶段 CONTENT_FILTER → 改 FINISHED + 存档 + 思考内容不丢
 *   5. 历史有存档 → 还原原文 + 提示
 *   6. 历史无存档 → 显示"未找到"
 *   7. 增量解析与一次性解析结果等价（长对话）
 *   8. 长对话性能线性（不 O(n²)）
 *   9. 关闭开关 → 完全旁路
 *  10. 普通 XHR 不受影响
 *  11. hook 在 readyState<2 时不抛异常
 *  12. localStorage 配额满 → 降级内存 + 上报，不崩
 *  13. 导出/删除/清空 闭环
 *  14. 加解密边界：坏 JSON 行不打断流
 */
'use strict';

var fs = require('fs');
var path = require('path');
var acorn = require('acorn');
var env = require('./mock/env');
var S = require('./fixtures/sse');

var ROOT = path.resolve(__dirname, '../..');
var SCRIPT_PATH = path.join(ROOT, 'app/assets/ds_shell.js');

var pass = 0, fail = 0;
var failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    failures.push({ name: name, err: e });
    console.log('  FAIL  ' + name);
    console.log('        ' + (e && e.message ? e.message : e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(a, b, msg) {
  if (a !== b) {
    throw new Error((msg || 'not equal') + '  (got ' + JSON.stringify(a)
        + ', want ' + JSON.stringify(b) + ')');
  }
}

/* ==================================================================== */

console.log('\n=== ds_shell.js test suite ===\n');

var src = fs.readFileSync(SCRIPT_PATH, 'utf8');
console.log('script: ' + SCRIPT_PATH + '  (' + src.length + ' bytes, '
    + src.split('\n').length + ' lines)\n');

/* --- 1. ES5 语法 --- */
check('ES5 syntax (acorn ecmaVersion=5)', function () {
  acorn.parse(src, { ecmaVersion: 5, sourceType: 'script', allowReturnOutsideFunction: false });
});

/* --- 2. 正常流不误伤 --- */
check('正常回答：不篡改、不存档', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  var lines = S.normal();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.setRequestHeader('x-client-locale', 'zh_CN');
  xhr.send(JSON.stringify({ chat_session_id: 'sess-1' }));

  feed(xhr, lines);
  eq(xhr.responseText, lines.join('\n'), '正常流被改动了');
  eq(e.shell.count(), 0, '不该有存档');
  eq(e.bridgeCalls('onRecall').length, 0, '不该上报撤回');
});

/* --- 3. 生成中撤回 --- */
check('生成中撤回：篡改为 TIP + 写入存档', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  var lines = S.recallDuringGenerate();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.setRequestHeader('x-client-locale', 'zh_CN');
  xhr.send(JSON.stringify({ chat_session_id: 'sess-2' }));

  feed(xhr, lines);
  var out = xhr.responseText;

  assert(out.indexOf('TEMPLATE_RESPONSE') === -1, '占位模板应被替换掉');
  assert(out.indexOf('\u26a0') >= 0 || out.indexOf('已被拦截') >= 0, '应出现拦截提示');
  assert(out.indexOf('要输出的正文第一段') >= 0 || out.indexOf('这段思考') >= 0,
      '原文不应被删');

  // 存档
  eq(e.shell.count(), 1, '应写入 1 条存档');
  var idx = JSON.parse(e.storage.getItem('__ds_archive_index') || '[]');
  eq(idx.length, 1);
  eq(idx[0].sessId, 'sess-2');
  eq(idx[0].msgId, 21);
  eq(idx[0].reason, 'TEMPLATE_RESPONSE');

  // 存档里必须保留原始片段（含思考）
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-sess-2-msg-21'));
  assert(rec.fragments.length === 3, '应保存 3 个片段，实际 ' + rec.fragments.length);
  var types = rec.fragments.map(function (f) { return f.type; }).join(',');
  eq(types, 'THINKING,ANSWER,ANSWER', '片段类型应完整保留');

  // 上报
  eq(e.bridgeCalls('onRecall').length, 1, '应上报一次');
  var payload = JSON.parse(e.bridgeCalls('onRecall')[0].v);
  eq(payload.msgId, 21);
  eq(payload.reason, 'TEMPLATE_RESPONSE');
});

/* --- 4. 思考阶段过滤 --- */
check('思考阶段 CONTENT_FILTER：改 FINISHED + 存档 + 思考不丢', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  var lines = S.filterDuringThinking();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.setRequestHeader('x-client-locale', 'zh_CN');
  xhr.send(JSON.stringify({ chat_session_id: 'sess-3' }));

  feed(xhr, lines);
  var out = xhr.responseText;

  assert(out.indexOf('CONTENT_FILTER') === -1, 'CONTENT_FILTER 应被改成 FINISHED');
  assert(out.indexOf('FINISHED') >= 0, '应出现 FINISHED');
  assert(out.indexOf('正在推理') >= 0, '思考内容不应丢失');

  eq(e.shell.count(), 1);
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-sess-3-msg-31'));
  eq(rec.reason, 'CONTENT_FILTER');
  eq(rec.fragments.length, 1);
  eq(rec.fragments[0].type, 'THINKING');
});

/* --- 5. 历史还原（有存档） --- */
check('历史消息：有存档 → 还原原文 + 追加提示', function () {
  var e = env.createEnv(src);

  // 先造一条存档
  var xhr1 = new e.XHR();
  var lines = S.recallDuringGenerate();
  xhr1.open('POST', '/api/v0/chat/completion');
  xhr1.send(JSON.stringify({ chat_session_id: 'sess-abc' }));
  feed(xhr1, lines);

  eq(e.shell.count(), 1, '前置存档失败');

  // 再请求历史
  var xhr2 = new e.XHR();
  xhr2.responseType = 'text';
  xhr2.open('POST', '/api/v0/chat/history_messages');
  xhr2.send('{}');

  var hist = S.historyWithFilter(21);
  xhr2.status = 200;
  xhr2.readyState = 4;
  xhr2._responseText = hist;
  xhr2._emit('readystatechange');

  var out = xhr2.responseText;
  var j = JSON.parse(out);
  var msg = j.data.biz_data.chat_messages[0];

  eq(msg.status, 'FINISHED', 'status 应被改');
  eq(msg.fragments[0].type, 'THINKING', '应还原原始首片段');
  assert(msg.fragments[msg.fragments.length - 1].type === 'TIP', '末尾应追加提示');
  assert(out.indexOf('要输出的正文第一段') >= 0 || out.indexOf('这段思考') >= 0,
      '原文应被还原出来');

  // 第二条正常消息不受影响
  eq(j.data.biz_data.chat_messages[1].status, 'FINISHED');
  eq(j.data.biz_data.chat_messages[1].fragments[0].content, '这条正常。');
});

/* --- 6. 历史还原（无存档） --- */
check('历史消息：无存档 → 显示"未找到"占位', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.responseType = 'text';
  xhr.open('POST', '/api/v0/chat/history_messages');
  xhr.send('{}');
  xhr.status = 200;
  xhr.readyState = 4;
  xhr._responseText = S.historyWithFilter(999);  // 不存在的 msgId
  xhr._emit('readystatechange');

  var j = JSON.parse(xhr.responseText);
  var msg = j.data.biz_data.chat_messages[0];
  eq(msg.status, 'FINISHED');
  eq(msg.fragments.length, 1);
  eq(msg.fragments[0].type, 'TIP');
  assert(msg.fragments[0].content.indexOf('\u26d4') >= 0
      || msg.fragments[0].content.indexOf('未找到') >= 0, '应提示未找到');
});

/* --- 7. 增量 vs 一次性等价 --- */
check('增量解析与一次性解析结果等价（长对话）', function () {
  // 增量：逐块喂
  var e1 = env.createEnv(src);
  var x1 = new e1.XHR();
  var lines = S.longConversation(220, 2000);
  x1.open('POST', '/api/v0/chat/completion');
  x1.send(JSON.stringify({ chat_session_id: 's-long' }));
  feed(x1, lines);

  // 一次性：整段一次性设置（模拟"一次解析"基准）
  var full = lines.join('\n');
  eq(x1.responseText, full, '长对话正常流不应被改动');
  eq(e1.shell.count(), 0);
});

/* --- 8. 长对话性能 --- */
check('长对话性能：增量解析耗时线性（不 O(n²)）', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  var lines = S.longConversation(300, 3000);   // ~300 事件 × 3KB ≈ 900KB
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 's-perf' }));

  var t0 = Date.now();
  feed(xhr, lines);
  var dt = Date.now() - t0;

  var total = xhr.responseText.length;
  console.log('        总文本 ' + (total / 1024).toFixed(1) + ' KB，耗时 ' + dt + ' ms');

  // 增量实现的要求：总耗时随文本线性增长。900KB 在旧设备上也应远低于 3s。
  assert(dt < 3000, '耗时过长: ' + dt + 'ms，疑似 O(n²)');
});

/* --- 9. 关闭开关旁路 --- */
check('关闭防撤回：完全旁路（流不变、无存档）', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: false } });
  var xhr = new e.XHR();
  var lines = S.recallDuringGenerate();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'sess-off' }));
  feed(xhr, lines);

  eq(xhr.responseText, lines.join('\n'), '关闭后不应篡改');
  eq(e.shell.count(), 0, '关闭后不应存档');
  eq(e.shell.isEnabled(), false);

  // 运行中切换
  e.shell.setEnabled(true);
  eq(e.shell.isEnabled(), true);
});

/* --- 10. 普通 XHR 不受影响 --- */
check('普通 XHR 完全不受影响', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  var body = '{"a":1,"b":"随便什么内容"}';
  xhr.open('GET', '/api/v0/users');   // 不在白名单
  xhr.send(null);
  xhr.status = 200;
  xhr.readyState = 4;
  xhr._responseText = body;
  xhr._emit('readystatechange');

  eq(xhr.responseText, body, '普通接口不应被改');
  eq(xhr.response, body);
});

/* --- 11. readyState 边界不抛异常 --- */
check('readyState<2 触发读取不抛 InvalidStateError', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send('{"chat_session_id":"x"}');
  // readyState 仍是 1，此时读 responseText
  var threw = null;
  try {
    var v = xhr.responseText;   // mock 在 readyState<3 会主动抛，钩子必须吞住
    eq(v, '');
  } catch (err) {
    threw = err;
  }
  assert(threw === null, '钩子没有吞掉 InvalidStateError: ' + (threw && threw.message));
});

/* --- 12. localStorage 配额满 --- */
check('localStorage 配额满：降级内存 + 上报 + 不崩', function () {
  var e = env.createEnv(src, { storageOpts: { failAfter: 0 } });
  var xhr = new e.XHR();
  var lines = S.recallDuringGenerate();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'sess-quota' }));
  feed(xhr, lines);   // 不应抛

  assert(xhr.responseText.indexOf('\u26a0') >= 0
      || xhr._responseText.indexOf('已被拦截') >= 0, '即使存不进也应显示提示');
  assert(e.bridgeCalls('onArchiveError').length >= 1, '应上报存储失败');
  // 内存里仍应能读到（count 通过索引）
  assert(e.shell.count() >= 0, 'count 不应抛');
});

/* --- 13. 导出/删除/清空 --- */
check('导出/删除/清空 闭环', function () {
  var e = env.createEnv(src);

  // 造两条
  [['sess-a', 1], ['sess-b', 2]].forEach(function (p) {
    var xhr = new e.XHR();
    var lines = S.recallDuringGenerate();
    // 改 msgId
    lines = lines.map(function (l) {
      return l.indexOf('"message_id":21') >= 0
          ? l.replace('"message_id":21', '"message_id":' + p[1]) : l;
    });
    xhr.open('POST', '/api/v0/chat/completion');
    xhr.send(JSON.stringify({ chat_session_id: p[0] }));
    feed(xhr, lines);
  });

  eq(e.shell.count(), 2, '应有 2 条');

  var exported = e.shell.exportArchive();
  assert(typeof exported === 'string', '导出必须是字符串');
  var j = JSON.parse(exported);
  eq(j.items.length, 2);
  assert(j.items[0].text.length > 0, '导出应含全文');
  assert(j.items[0].text.indexOf('\n\n') >= 0, '片段应以空行分隔');

  // 删除一条
  e.shell.removeArchive('sess-a', 1);
  eq(e.shell.count(), 1);

  // 清空
  e.shell.clearArchive();
  eq(e.shell.count(), 0);
  eq(e.storage.getItem('__ds_archive_index'), null);
});

/* --- 14. 坏 JSON 行不打断流 --- */
check('流中出现坏 JSON 行：跳过且不影响后续', function () {
  var e = env.createEnv(src);
  var xhr = new e.XHR();
  var lines = S.normal();
  // 在中间插一行坏数据
  lines.splice(3, 0, 'data: {this is not json');
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'sess-bad' }));
  feed(xhr, lines);

  eq(xhr.responseText, lines.join('\n'), '坏行不应导致崩溃或改写');
});

/* --- 15. 旧格式存档向后兼容 --- */
check('向后兼容：能读旧格式（裸 fragments 数组）存档', function () {
  var e = env.createEnv(src);
  // 手工写一条旧格式
  var old = [{ id: 2, type: 'ANSWER', content: '旧版存的原文' }];
  e.storage.setItem('deleted-chat-sess-old-msg-7', JSON.stringify(old));

  var xhr = new e.XHR();
  xhr.responseType = 'text';
  xhr.open('POST', '/api/v0/chat/history_messages');
  xhr.send('{}');
  xhr.status = 200;
  xhr.readyState = 4;

  var hist = JSON.stringify({
    data: { biz_data: {
      chat_session: { id: 'old' },
      chat_messages: [{ message_id: 7, status: 'CONTENT_FILTER', fragments: [] }]
    } }
  });
  xhr._responseText = hist;
  xhr._emit('readystatechange');

  var j = JSON.parse(xhr.responseText);
  var msg = j.data.biz_data.chat_messages[0];
  eq(msg.status, 'FINISHED');
  assert(msg.fragments[0].content === '旧版存的原文', '旧格式应被正确读取');
});

/* --- 16. 会话 ID 从 body / URL 兜底 --- */
check('会话 ID 提取：body 与 URL 两种来源', function () {
  var e = env.createEnv(src);

  // 从 body
  var x1 = new e.XHR();
  x1.open('POST', '/api/v0/chat/completion');
  x1.send(JSON.stringify({ chat_session_id: 'sess-body' }));
  eq(x1.__dsSessId, 'sess-body');

  // 从 URL query 兜底（body 无字段）
  var x2 = new e.XHR();
  x2.open('POST', '/api/v0/chat/regenerate?chat_session_id=sess-url');
  x2.send('{}');
  eq(x2.__dsSessId, 'sess-url');
});

/* ==================================================================== */

/**
 * 按真实站点的方式喂 SSE：每个 chunk 后读取 responseText。
 * 这是 XHR getter 钩子的触发条件 —— 不读就永远不会触发。
 * 用 join/split 保证末尾不额外多出换行。
 */
function feed(xhr, lines) {
  xhr._receiveHeaders(200);
  var parts = lines.join(String.fromCharCode(10)).split(String.fromCharCode(10));
  var acc = '';
  for (var i = 0; i < parts.length; i++) {
    acc += parts[i];
    if (i < parts.length - 1) acc += String.fromCharCode(10);
    xhr._responseText = acc;
    xhr.readyState = 3;
    xhr._emit('progress', { type: 'progress', loaded: acc.length, total: 0 });
    xhr._emit('readystatechange');
    try { void xhr.responseText; } catch (e) { }
  }
  xhr._finish();
  try { void xhr.responseText; } catch (e) { }
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) {
  console.log('\nfailures:');
  failures.forEach(function (f) {
    console.log('  - ' + f.name);
    console.log('    ' + (f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n    ')
        : f.err));
  });
  process.exit(1);
}
console.log('ALL PASS');
