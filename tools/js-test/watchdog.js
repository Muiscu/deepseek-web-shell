#!/usr/bin/env node
/**
 * 实时暂存 / 完整性看门狗 测试（v1.3 策略）。
 * 策略：①生成过程中实时写入暂存 ②停增满10s→定稿 ③有撤回信号→立即定稿 ④太短→丢弃
 * 关键认知：正常完成也要存 —— 撤回常是"事后"发生的（history 标成 CONTENT_FILTER）。
 */
'use strict';
var fs = require('fs'), path = require('path'), acorn = require('acorn');
var env = require('./mock/env');
var src = fs.readFileSync(path.resolve(__dirname, '../../app/assets/ds_shell.js'), 'utf8');

var pass = 0, fail = 0, failures = [];
function check(n, fn) {
  try { fn(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; failures.push({ n: n, e: e }); console.log('  FAIL  ' + n + '\n        ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) { if (a !== b) throw new Error((m || '!=') + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function fakeTimers(e) {
  var timers = [], seq = 1;
  e.sandbox.setTimeout = function (fn, ms) { var id = seq++; timers.push({ id: id, fn: fn, c: false }); return id; };
  e.sandbox.clearTimeout = function (id) { for (var i = 0; i < timers.length; i++) if (timers[i].id === id) timers[i].c = true; };
  return { advance: function () {
    var s = timers.slice();
    for (var i = 0; i < s.length; i++) { if (s[i].c) continue; s[i].c = true; try { s[i].fn(); } catch (x) {} }
  } };
}
function ev(o) { return 'data: ' + JSON.stringify(o); }
function streamFrags(n, mid) {
  var out = [ev({ p: '', o: 'SET', v: { response: { message_id: mid || 900, fragments: [] } } })];
  for (var i = 0; i < n; i++) out.push(ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [
    { id: 2 + i, type: i === 0 ? 'THINKING' : 'ANSWER', content: '这是第' + i + '段正文内容，足够长' }] }] }));
  return out;
}
function feedPartial(x, lines) {
  x._receiveHeaders(200); var acc = '';
  for (var i = 0; i < lines.length; i++) {
    acc += lines[i] + '\n'; x._responseText = acc; x.readyState = 3;
    x._emit('progress', { loaded: acc.length, total: 0 }); x._emit('readystatechange');
    try { void x.responseText; } catch (e) {}
  }
}
function feedFull(x, lines) { feedPartial(x, lines); x._finish(); try { void x.responseText; } catch (e) {} }

console.log('\n=== 实时暂存 / 看门狗 测试（v1.3） ===\n');

check('正常完成也存档（事后撤回需要它）', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true } }), T = fakeTimers(e);
  var lines = streamFrags(4).concat([ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] })]);
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S1"}');
  feedFull(x, lines); T.advance();
  assert(e.shell.count() >= 1, '正常完成也应存档，实际 ' + e.shell.count());
  var idx = JSON.parse(e.storage.getItem('__ds_archive_index') || '[]');
  eq(idx.length, 1);
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-S1-msg-' + idx[0].msgId));
  assert(rec.fragments.length >= 4, '应存 4 段，实际 ' + rec.fragments.length);
  assert(rec.fragments[0].type === 'THINKING', '思考片段应保留');
});

check('中途掐断（未正常收尾）→ 存档', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true } }), T = fakeTimers(e);
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S2"}');
  feedPartial(x, streamFrags(4, 902));
  eq(e.shell.count(), 0, '宽限期内不应定稿'); T.advance(); eq(e.shell.count(), 1);
});

check('用户主动停止（STOPPED）→ 保留内容', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true } }), T = fakeTimers(e);
  var lines = streamFrags(3, 903).concat([ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'STOPPED' }] })]);
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S3"}');
  feedPartial(x, lines); T.advance();
  assert(e.shell.count() >= 1, '停止的内容也应保留');
});

check('内容过短 → 丢弃', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true } }), T = fakeTimers(e);
  var lines = [ev({ p: '', o: 'SET', v: { response: { message_id: 904, fragments: [] } } })];
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S4"}');
  feedPartial(x, lines); T.advance(); eq(e.shell.count(), 0);
});

check('关闭开关 → 完全不触发', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: false } }), T = fakeTimers(e);
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S5"}');
  feedPartial(x, streamFrags(5, 905)); T.advance(); eq(e.shell.count(), 0);
});

check('实时暂存：定稿前已有正文', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true } }), T = fakeTimers(e);
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S6"}');
  feedPartial(x, streamFrags(3, 906));
  var keys = Object.keys(e.storage._raw()).filter(function (k) { return k.indexOf('__ds_live_') === 0; });
  assert(keys.length >= 1, '应有实时暂存，keys=' + Object.keys(e.storage._raw()).join(','));
  var live = JSON.parse(e.storage.getItem(keys[0]));
  assert(live.text && live.text.length > 0, '暂存应有正文');
  assert(live.fragments && live.fragments.length >= 2, '暂存应有片段');
  T.advance();
  var keys2 = Object.keys(e.storage._raw()).filter(function (k) { return k.indexOf('__ds_live_') === 0; });
  eq(keys2.length, 0, '定稿后暂存应清理');
});

check('撤回信号 → 立即定稿', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true } }), T = fakeTimers(e);
  var lines = streamFrags(3, 907).concat([ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
    { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] })]);
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S7"}');
  feedFull(x, lines);
  var idx = JSON.parse(e.storage.getItem('__ds_archive_index') || '[]');
  eq(idx.length, 1); eq(idx[0].reason, 'TEMPLATE_RESPONSE');
});

check('信号命中 + 看门狗 → 仍只 1 条', function () {
  var e = env.createEnv(src, { cfg: { antiRecall: true } }), T = fakeTimers(e);
  var lines = streamFrags(3, 908).concat([ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
    { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] })]);
  var x = new e.XHR(); x.open('POST', '/api/v0/chat/completion'); x.send('{"chat_session_id":"S8"}');
  feedFull(x, lines); T.advance();
  var idx = JSON.parse(e.storage.getItem('__ds_archive_index') || '[]');
  eq(idx.length, 1, '同 msgId 只应 1 条');
});

check('仍为 ES5', function () { acorn.parse(src, { ecmaVersion: 5, sourceType: 'script' }); });

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) { failures.forEach(function (f) { console.log('  - ' + f.n + ': ' + (f.e && f.e.message)); }); process.exit(1); }
console.log('ALL PASS');
