/**
 * 第三批：A3 / A6 / A15 的修法实证（只在前两批修法之上做增量验证）。
 * 只写内存副本，不碰 app/。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var env = require('../mock/env');
var ROOT = path.resolve(__dirname, '../../..');
var orig = fs.readFileSync(path.join(ROOT, 'app/assets/ds_shell.js'), 'utf8');
var NL = String.fromCharCode(10);

function ev(o) { return 'data: ' + JSON.stringify(o); }
function read(x) { try { void x.responseText; } catch (e) { } }
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

function patch(s) {
  function rep(a, b, tag) {
    if (s.indexOf(a) < 0) throw new Error('anchor miss: ' + tag);
    s = s.split(a).join(b);
  }
  // A3/F1: 快照改到 apply 之后（拿到"当前已累积"的 fragments / message_id）
  rep("    if (path !== '') this.apply(path, value, mode);",
    "    if (path !== '') this.apply(path, value, mode);\n"
    + "    this.snap();", 'postapply');
  // 新增 snap 方法
  rep("  DSState.prototype.apply = function (path, value, mode) {",
    "  DSState.prototype.snap = function () {\n"
    + "    var r = this.fields.response;\n"
    + "    if (!r) return;\n"
    + "    if (r.message_id !== undefined && r.message_id !== null) this.lastMsgId = r.message_id;\n"
    + "    if (isArray(r.fragments) && r.fragments.length > 0) {\n"
    + "      this.lastGoodFragments = cloneFragments(r.fragments);\n"
    + "    }\n"
    + "  };\n\n"
    + "  DSState.prototype.apply = function (path, value, mode) {", 'snapdef');
  // inspect 里改用 rescue / lastMsgId
  rep("    var fragments = response.fragments || [];\n    var msgId = response.message_id;",
    "    var fragments = response.fragments || [];\n"
    + "    if (fragments.length === 0 && this.lastGoodFragments\n"
    + "        && this.lastGoodFragments.length > 0) {\n"
    + "      fragments = this.lastGoodFragments;\n"
    + "    }\n"
    + "    var msgId = response.message_id;\n"
    + "    if (msgId === undefined || msgId === null) msgId = this.lastMsgId;\n"
    + "    if (msgId === undefined || msgId === null) {\n"
    + "      msgId = 'auto-' + (this.sessId || 'nosess') + '-' + fragments.length;\n"
    + "    }", 'rescue');
  // 去掉 msgId !== undefined 守卫（已保证有值）
  rep("          if (msgId !== undefined && msgId !== null) {",
    "          if (true) {", 'guard1');
  rep("        if (fragments.length > 0 && msgId !== undefined && msgId !== null) {",
    "        if (fragments.length > 0) {", 'guard2');
  rep("        if (!modified && msgId !== undefined && msgId !== null && fragments.length > 0) {",
    "        if (!modified && fragments.length > 0) {", 'guard3');
  // A15: sess 也可来自 message 自身
  rep("      if (node.chat_session && node.chat_session.id) sess = String(node.chat_session.id);",
    "      if (node.chat_session && node.chat_session.id) sess = String(node.chat_session.id);\n"
    + "      if (node.chat_session_id) sess = String(node.chat_session_id);\n"
    + "      if (node.session_id) sess = String(node.session_id);", 'sess');
  return s;
}

var fixed = patch(orig);
require('acorn').parse(fixed, { ecmaVersion: 5, sourceType: 'script' });
console.log('patched copy parses as ES5: ok\n');

function tA3(src) {
  var e = env.createEnv(src), x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S3' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 400, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '原文正文' }] }] }),
    ev({ p: 'response', o: 'SET', v: {} }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-S3-msg-400') || 'null');
  return x.responseText.indexOf('CONTENT_FILTER') === -1 && !!rec
    && rec.fragments.length === 1 && rec.fragments[0].content === '原文正文';
}

function tA6(src) {
  var e = env.createEnv(src), x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S6' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '会被拦截的正文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  var dump = e.storage._dump(), bad = false;
  for (var k in dump) if (dump.hasOwnProperty(k) && k.indexOf('undefined') >= 0) bad = true;
  return !bad && e.shell.count() === 1 && x.responseText.indexOf('TEMPLATE_RESPONSE') === -1;
}

function tA15(src) {
  var e = env.createEnv(src), g = new e.XHR();
  g.open('POST', '/api/v0/chat/completion');
  g.send(JSON.stringify({ chat_session_id: 'sess-page' }));
  feed(g, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 1500, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '原文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  var hist = JSON.stringify({ data: { biz_data: { chat_messages: [{
    message_id: 1500, chat_session_id: 'sess-page', status: 'CONTENT_FILTER',
    fragments: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] } } });
  var out = JSON.parse(e.shell._internals.restoreHistory(hist));
  var m = out.data.biz_data.chat_messages[0];
  return m.status === 'FINISHED' && m.fragments[0].type !== 'TEMPLATE_RESPONSE'
    && m.fragments[0].content === '原文';
}

function tReg(src) {
  var e = env.createEnv(src), x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'R' }));
  var l = [ev({ p: '', o: 'SET', v: { response: { message_id: 1, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '正常' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }), ''];
  feed(x, l);
  return x.responseText === l.join(NL) && e.shell.count() === 0;
}

var rows = [['A3 response 清空后存档', tA3], ['A6 msgId 缺失不丢', tA6],
  ['A15 fetch_page sess 兜底', tA15], ['回归：正常流不存档', tReg]];
var bad = 0;
rows.forEach(function (r) {
  var b, a;
  try { b = r[1](orig) ? 'ok' : 'BUG'; } catch (err) { b = 'err:' + err.message; }
  try { a = r[1](fixed) ? 'ok' : 'BUG'; } catch (err) { a = 'err:' + err.message; }
  var nm = r[0]; while (nm.length < 26) nm += ' ';
  console.log('  ' + nm + ' 原始=' + b + '  修法后=' + a);
  if (a !== 'ok') bad++;
});
console.log(bad === 0 ? '\nFIX-VERIFIED (batch 3)' : '\nFIX-INCOMPLETE: ' + bad);
process.exit(bad === 0 ? 0 : 1);
