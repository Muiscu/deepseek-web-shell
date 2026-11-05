#!/usr/bin/env node
/**
 * 裸增量事件测试。
 *
 * 这是本项目最关键的一次修复，依据来自真机导出的真实事件分布：
 *
 *   ×1127  p=- o=- v=str(1)
 *   × 905  p=- o=- v=str(2)
 *   × 185  p=- o=- v=str(3)
 *   ×  18  p=- o=- v=str(4)
 *
 * 也就是说：**2200 多个事件没有 p、没有 o，只带一个 v 字符串**，
 * 正文是「一个字符一个事件」吐出来的。
 *
 * 旧逻辑对这类事件三条分支全不成立（既非整体对象、也过不了 path!=='' 的 apply），
 * 于是被完全丢弃。结果存档正文永远停在开头那几个字
 * ——「1.\n\n听到」这种，正是用户反复反馈的现象。
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

function drive(lines, sessId) {
  var e = env.createEnv(src, { cfg: { antiRecall: true, debug: false } });
  var pend = [];
  e.sandbox.setTimeout = function (fn) { pend.push(fn); return pend.length; };
  e.sandbox.clearTimeout = function (id) { if (id) pend[id - 1] = null; };

  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: sessId || 'R' }));
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
  return {
    env: e, xhr: x,
    finish: function () {
      x.readyState = 4;
      x._emit('readystatechange');
      try { void x.responseText; } catch (err) { }
    },
    flush: function () {
      var s = pend.slice(); pend.length = 0;
      s.forEach(function (f) { if (f) { try { f(); } catch (x2) { } } });
    },
    text: function () {
      var fr = x.__dsState.fields.response.fragments || [];
      return fr.filter(function (f) { return f.type !== 'TIP'; })
          .map(function (f) { return f.content; }).join('');
    }
  };
}

console.log('\n=== 裸增量事件测试（真实形态） ===\n');

var FULL = '1.\n\n听到"你最近压力很大"这种话，我先接住你的情绪。需要被安抚，被纵容。';

function buildRealStream(text, msgId) {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: msgId, fragments: [] } } }),
    // 片段骨架（真实数据里只有 2 个这种事件）
    ev({ p: 'response/fragments', o: 'APPEND',
         v: [{ id: 2, type: 'THINKING', content: '', references: [], stage_id: 1 }] })
  ];
  // ★ 主体：裸字符串，一个字符一个事件
  for (var i = 0; i < text.length; i++) {
    lines.push(ev({ v: text[i] }));
  }
  lines.push(ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }));
  return lines;
}

check('裸字符串增量全部拼接（核心回归）', function () {
  var d = drive(buildRealStream(FULL, 568), 'R1');
  d.finish();
  var got = d.text();
  eq(got.length, FULL.length,
      '正文长度应等于原文长度（旧版只有几个字）');
  eq(got, FULL, '正文必须一字不差');
});

check('裸增量在长文本下仍正确（1000+ 字符）', function () {
  var long = '';
  for (var i = 0; i < 1200; i++) long += String.fromCharCode(97 + (i % 26));
  var d = drive(buildRealStream(long, 569), 'R2');
  d.finish();
  eq(d.text().length, long.length, '长文本也要完整');
  eq(d.text(), long);
});

check('裸增量在没有片段骨架时也能自建片段', function () {
  var lines = [ev({ p: '', o: 'SET', v: { response: { message_id: 570, fragments: [] } } })];
  for (var i = 0; i < 40; i++) lines.push(ev({ v: '字' }));
  var d = drive(lines, 'R3');
  d.finish();
  var fr = d.xhr.__dsState.fields.response.fragments;
  assert(fr.length >= 1, '应自建至少 1 个片段');
  eq(d.text(), '字'.repeat ? '字'.repeat(40) : new Array(41).join('字'), '内容应完整');
});

check('存档里也是完整正文（不只是内存里对）', function () {
  var d = drive(buildRealStream(FULL, 571), 'R4');
  d.finish();
  d.flush();
  var idx = JSON.parse(d.env.storage.getItem('__ds_archive_index') || '[]');
  assert(idx.length >= 1, '应有存档');
  var rec = JSON.parse(d.env.storage.getItem(
      'deleted-chat-sess-' + idx[0].sessId + '-msg-' + idx[0].msgId));
  var txt = rec.fragments.filter(function (f) { return f.type !== 'TIP'; })
      .map(function (f) { return f.content; }).join('');
  eq(txt, FULL, '存档正文必须完整');
});

check('裸数组事件 v=[{p,v}] 也能处理', function () {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 572, fragments: [] } } }),
    ev({ v: [
      { p: 'response/fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: 'ABC' }] }
    ] })
  ];
  var d = drive(lines, 'R5');
  d.finish();
  eq(d.text(), 'ABC');
});

check('普通带 path 的事件仍正常（C 路径未受影响）', function () {
  var lines = [
    ev({ p: '', o: 'SET', v: { response: { message_id: 573, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
         v: [{ id: 2, type: 'ANSWER', content: '正常' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] })
  ];
  var d = drive(lines, 'R6');
  d.finish();
  eq(d.text(), '正常');
});

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) {
  fails.forEach(function (f) { console.log('  - ' + f[0] + ': ' + f[1]); });
  process.exit(1);
}
console.log('ALL PASS');
