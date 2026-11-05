#!/usr/bin/env node
/**
 * 片段归属测试（裸增量该进哪个片段）。
 *
 * 背景：线上现象是「思考过程完整、正文只剩一个括号」。
 * 需要确认增量事件的归属规则正确：
 *   裸增量属于「当前正在吐字的那个片段」= 最后一个非 TIP 片段，
 *   不管它是 THINKING 还是 ANSWER。
 *
 * 曾经的错误实现是「优先找 ANSWER」，会造成：
 *   ① 只有 THINKING 时，正文增量被塞进 THINKING 末尾；
 *   ② ANSWER 片段后来才创建，正文落在错误位置。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var env = require('./mock/env');

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
function ev(o) { return 'data: ' + JSON.stringify(o); }

function run(lines) {
  var e = env.createEnv(src, { cfg: { antiRecall: true, debug: false } });
  var pend = [];
  e.sandbox.setTimeout = function (fn) { pend.push(fn); return pend.length; };
  e.sandbox.clearTimeout = function (id) { if (id) pend[id - 1] = null; };
  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send('{"chat_session_id":"F1"}');
  x._receiveHeaders(200);
  var acc = '';
  for (var i = 0; i < lines.length; i++) {
    acc += lines[i] + '\n';
    x._responseText = acc;
    x.readyState = 3;
    x._emit('progress', { loaded: acc.length, total: 0 });
    x._emit('readystatechange');
    try { void x.responseText; } catch (err) { }
  }
  return x.__dsState.fields.response.fragments || [];
}

console.log('\n=== 片段归属测试 ===\n');

check('只有 THINKING 时，裸增量进 THINKING（不越界到不存在的 ANSWER）', function () {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 700, fragments: [] } } }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 2, type: 'THINKING', content: '', references: [], stage_id: 1 }] }),
    ev({ v: '思' }), ev({ v: '考' })
  ];
  var fr = run(lines);
  eq(fr.length, 1, '应只有 1 个片段');
  eq(fr[0].type, 'THINKING');
  eq(fr[0].content, '思考');
});

check('ANSWER 创建后，后续裸增量进 ANSWER（关键）', function () {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 701, fragments: [] } } }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 2, type: 'THINKING', content: '思考', references: [], stage_id: 1 }] }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 3, type: 'ANSWER', content: '', references: [], stage_id: 2 }] }),
    ev({ v: '正' }), ev({ v: '文' })
  ];
  var fr = run(lines);
  eq(fr.length, 2);
  eq(fr[0].type, 'THINKING');
  eq(fr[0].content, '思考', 'THINKING 不应被正文污染');
  eq(fr[1].type, 'ANSWER');
  eq(fr[1].content, '正文', '正文必须进 ANSWER');
});

check('ANSWER 带初始内容（如括号）时，增量正确追加', function () {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 702, fragments: [] } } }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 2, type: 'THINKING', content: '思考完毕', references: [], stage_id: 1 }] }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 3, type: 'ANSWER', content: '（', references: [], stage_id: 2 }] }),
    ev({ v: '正' }), ev({ v: '文' }), ev({ v: '内' }), ev({ v: '容' })
  ];
  var fr = run(lines);
  eq(fr[1].content, '（正文内容', '应保留初始括号并追加正文');
  eq(fr[0].content, '思考完毕', 'THINKING 不应被污染');
});

check('多个片段交替时，增量始终跟随最后一个', function () {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 703, fragments: [] } } }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 2, type: 'THINKING', content: 'A', references: [], stage_id: 1 }] }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 3, type: 'ANSWER', content: 'B', references: [], stage_id: 2 }] }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 4, type: 'ANSWER', content: 'C', references: [], stage_id: 3 }] }),
    ev({ v: 'D' })
  ];
  var fr = run(lines);
  eq(fr.length, 3);
  eq(fr[2].content, 'CD', '最后一个片段应收到增量');
  eq(fr[1].content, 'B');
});

check('-1 索引 + 缺省 SET 正确作用于最后片段', function () {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 704, fragments: [] } } }),
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 2, type: 'THINKING', content: '旧', references: [], stage_id: 1 }] }),
    ev({ p: 'response/fragments/-1/content', o: 'SET', v: '新' }),
    ev({ p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 5 })
  ];
  var fr = run(lines);
  eq(fr[0].content, '新', '-1 索引应覆盖最后一个片段的 content');
});

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) {
  fails.forEach(function (f) { console.log('  - ' + f[0] + ': ' + f[1]); });
  process.exit(1);
}
console.log('ALL PASS');
