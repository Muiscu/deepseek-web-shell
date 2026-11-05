#!/usr/bin/env node
/**
 * 增量补写测试（定稿后继续累积）。
 *
 * 事故背景：线上存档正文只有 3~6 个字，形如「1.\n\n听到」。
 * 根因：DeepSeek 思考阶段常会长时间无输出，10 秒宽限期一到就定稿，
 * 之后到达的正文全被丢掉。
 *
 * 修复思路（不是延长等待，那会走向另一个错误：永远不定稿）：
 *   先定稿（保证有东西可救）→ 后续内容继续到达则"补写"同一条存档。
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
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) {
  if (a !== b) throw new Error((m || '!=') + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}
function ev(o) { return 'data: ' + JSON.stringify(o); }

/** 带手动定时器的驱动 */
function makeDriver(seedMsgId, sessId) {
  var e = env.createEnv(src, { cfg: { antiRecall: true, debug: false } });
  var pending = [];
  e.sandbox.setTimeout = function (fn) { pending.push(fn); return pending.length; };
  e.sandbox.clearTimeout = function (id) { if (id) pending[id - 1] = null; };

  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/edit_message');
  x.send(JSON.stringify({ chat_session_id: sessId }));
  x._receiveHeaders(200);

  var acc = '';
  return {
    env: e,
    xhr: x,
    feed: function (lines) {
      for (var i = 0; i < lines.length; i++) {
        acc += lines[i] + '\n';
        x._responseText = acc;
        x.readyState = 3;
        x._emit('progress', { loaded: acc.length, total: 0 });
        x._emit('readystatechange');
        try { void x.responseText; } catch (err) { }
      }
    },
    finish: function () {
      x.readyState = 4;
      x._emit('readystatechange');
      try { void x.responseText; } catch (err) { }
    },
    /** 模拟宽限期到点 */
    flush: function () {
      var s = pending.slice();
      pending.length = 0;
      s.forEach(function (f) { if (f) { try { f(); } catch (x2) { } } });
    },
    archiveText: function () {
      var idx = JSON.parse(e.storage.getItem('__ds_archive_index') || '[]');
      if (!idx.length) return null;
      var rec = JSON.parse(e.storage.getItem(
          'deleted-chat-sess-' + idx[0].sessId + '-msg-' + idx[0].msgId));
      return rec.fragments.map(function (f) { return f.content; }).join('');
    }
  };
}

console.log('\n=== 增量补写测试 ===\n');

var HEAD = function (mid) {
  return ev({ p: '', o: 'SET', v: { response: { message_id: mid, fragments: [] } } });
};
var FRAG = function (id, c) {
  return ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: id, type: 'ANSWER', content: c }] }] });
};

check('停顿触发定稿 → 后续内容自动补写（核心回归）', function () {
  var d = makeDriver(18, 'S1');

  // 第一批：只有前 3 帧，然后"思考停顿"
  d.feed([
    HEAD(18),
    FRAG(2, '1.'),
    FRAG(3, '\n\n听到')
  ]);
  d.flush();   // 宽限期到点 → 定稿

  var mid = d.archiveText();
  assert(mid !== null, '停顿后应先定稿，避免什么都没存');
  eq(mid, '1.\n\n听到', '第一份存档应是已收到的部分');

  // 第二批：思考结束，正文继续到达
  d.feed([
    FRAG(4, '这话说得太对了，'),
    FRAG(5, '你应该继续努力'),
    FRAG(6, '加油实现目标！')
  ]);
  d.flush();

  var done = d.archiveText();
  eq(done, '1.\n\n听到这话说得太对了，你应该继续努力加油实现目标！',
      '最终存档必须是完整正文');
});

check('多次停顿都能补写（不是只补一次）', function () {
  var d = makeDriver(19, 'S2');
  d.feed([HEAD(19), FRAG(2, 'AAA')]);
  d.flush();
  eq(d.archiveText(), 'AAA', '第一次定稿');

  d.feed([FRAG(3, 'BBB')]);
  d.flush();
  eq(d.archiveText(), 'AAABBB', '第一次补写');

  d.feed([FRAG(4, 'CCC')]);
  d.flush();
  eq(d.archiveText(), 'AAABBBCCC', '第二次补写');

  d.feed([FRAG(5, 'DDD')]);
  d.flush();
  eq(d.archiveText(), 'AAABBBCCCDDD', '第三次补写');
});

check('补写后仍只有一条存档（不重复建条目）', function () {
  var d = makeDriver(20, 'S3');
  d.feed([HEAD(20), FRAG(2, 'XXXXX')]);
  d.flush();
  d.feed([FRAG(3, 'YYYYY')]);
  d.flush();
  d.feed([FRAG(4, 'ZZZZZ')]);
  d.flush();

  var idx = JSON.parse(d.env.storage.getItem('__ds_archive_index') || '[]');
  eq(idx.length, 1, '同一 msgId 应始终只有 1 条，实际 ' + idx.length);
  eq(d.archiveText(), 'XXXXXYYYYYZZZZZ');
});

check('正常流（无停顿）不会被重复写入', function () {
  var d = makeDriver(21, 'S4');
  d.feed([HEAD(21), FRAG(2, '正常内容一号'), FRAG(3, '正常内容二号')]);
  d.finish();
  d.flush();

  var text = d.archiveText();
  assert(text !== null, '应有存档');
  eq(text, '正常内容一号正常内容二号', '内容应完整且不重复');
});

check('撤回信号仍优先（不被补写覆盖 reason）', function () {
  var d = makeDriver(22, 'S5');
  d.feed([
    HEAD(22),
    FRAG(2, '正文内容'),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }
    ] })
  ]);
  d.finish();
  d.flush();

  var idx = JSON.parse(d.env.storage.getItem('__ds_archive_index') || '[]');
  eq(idx.length, 1);
  // 信号命中的 reason 应保留，不该被 LIVE_GROW 改写
  assert(idx[0].reason === 'TEMPLATE_RESPONSE' || idx[0].reason === 'CONTENT_FILTER',
      'reason 应保持信号检测结果，实际 ' + idx[0].reason);
});

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) {
  fails.forEach(function (f) { console.log('  - ' + f[0] + ': ' + f[1]); });
  process.exit(1);
}
console.log('ALL PASS');
