/**
 * 第二批修法实证：A2b / A3 / A4 / A6 / A13 / A14 / A15。
 * 同样只在内存副本上打补丁，确认"这样改能修好且不回归"，不写 app/。
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
function feed(xhr, lines) {
  xhr._receiveHeaders(200);
  var p = lines.join(NL).split(NL), acc = '';
  for (var i = 0; i < p.length; i++) {
    acc += p[i]; if (i < p.length - 1) acc += NL;
    xhr._responseText = acc; xhr.readyState = 3;
    xhr._emit('progress', {}); xhr._emit('readystatechange');
    read(xhr);
  }
  xhr._finish(); read(xhr);
}
function hist(e, url, json) {
  var x = new e.XHR();
  x.responseType = 'text';
  x.open('POST', url || '/api/v0/chat/history_messages');
  x.send('{}');
  x.status = 200; x.readyState = 4; x._responseText = json;
  x._emit('readystatechange'); read(x);
  return x;
}

function patch(s) {
  /* ---- A2b: 整体 response 事件必须覆盖旧字段 ---- */
  var a = "      for (var k in value) {\n        if (this.fields[k] === undefined) this.fields[k] = value[k];\n      }";
  var b = "      if (this.fields.response) {\n"
    + "        this.fields = {};\n"
    + "      }\n"
    + "      for (var k in value) {\n"
    + "        if (this.fields[k] === undefined) this.fields[k] = value[k];\n"
    + "      }";
  if (s.indexOf(a) < 0) throw new Error('A2b anchor miss');
  s = s.split(a).join(b);

  /* ---- A3/A4: msgId 兜底 + 清空后仍能存 + status 事件单独取证 ---- */
  var c = "    var msgId = response.message_id;";
  var d = "    var msgId = response.message_id;\n"
    + "    if (msgId === undefined || msgId === null) msgId = this.lastMsgId;";
  if (s.indexOf(c) < 0) throw new Error('A3 anchor miss');
  s = s.split(c).join(d);

  /* 每当 response 对象里出现 message_id，就记下来 */
  var e2 = "      if (value.response && value.response.chat_session_id) {";
  var f2 = "      if (value.response && value.response.message_id !== undefined) {\n"
    + "        this.lastMsgId = value.response.message_id;\n"
    + "      }\n"
    + "      if (value.response && value.response.chat_session_id) {";
  if (s.indexOf(e2) < 0) throw new Error('A3b anchor miss');
  s = s.split(e2).join(f2);

  /* 记录“曾经出现过的最长片段集”，清空/覆盖后仍可存档 */
  var g = "    var response = this.fields.response || {};";
  var h = "    var response = this.fields.response || {};\n"
    + "    if (response.message_id !== undefined) this.lastMsgId = response.message_id;\n"
    + "    if (isArray(response.fragments) && response.fragments.length > 0) {\n"
    + "      this.lastGoodFragments = cloneFragments(response.fragments);\n"
    + "    }\n"
    + "    var rescue = this.lastGoodFragments || [];";
  if (s.indexOf(g) < 0) throw new Error('A3c anchor miss');
  s = s.split(g).join(h);

  /* fragments 为空时的存档改用 rescue */
  var i3 = "        if (fragments.length > 0) {";
  var j3 = "        if (fragments.length === 0 && rescue.length > 0) fragments = rescue;\n"
    + "        if (fragments.length > 0) {";
  if (s.indexOf(i3) < 0) throw new Error('A3d anchor miss');
  s = s.split(i3).join(j3);

  /* status 分支同样用 rescue */
  var k3 = "        if (!modified && msgId !== undefined && msgId !== null && fragments.length > 0) {";
  var l3 = "        var statusFrags = fragments.length > 0 ? fragments : rescue;\n"
    + "        if (!modified && msgId !== undefined && msgId !== null && statusFrags.length > 0) {";
  if (s.indexOf(k3) < 0) throw new Error('A4 anchor miss');
  s = s.split(k3).join(l3);
  s = s.split("          saveArchive(this.sessId, msgId, cloneFragments(fragments), CONTENT_FILTER);")
    .join("          saveArchive(this.sessId, msgId, cloneFragments(statusFrags), CONTENT_FILTER);");

  /* ---- A13: history 允许 responseType=json，用 response 取文本 ---- */
  var m = "      var text = rawText(xhr);\n      if (typeof text !== 'string' || text.length === 0) return null;";
  var n = "      var text = rawText(xhr);\n"
    + "      if ((typeof text !== 'string' || text.length === 0)\n"
    + "          && xhr.responseType && xhr.responseType !== 'text') {\n"
    + "        try {\n"
    + "          var robj = descResp.get.call(xhr);\n"
    + "          if (robj !== null && robj !== undefined) text = JSON.stringify(robj);\n"
    + "        } catch (e3) { }\n"
    + "      }\n"
    + "      if (typeof text !== 'string' || text.length === 0) return null;";
  if (s.indexOf(m) < 0) throw new Error('A13 anchor miss');
  s = s.split(m).join(n);

  /* ---- A14: 无存档时不要把服务器仍在返回的可读正文顶掉 ---- */
  var o4 = "        } else {\n"
    + "          node.fragments = [{\n"
    + "            id: 2, type: 'TIP', style: 'WARNING', content: tipNotFound()\n"
    + "          }];";
  var p4 = "        } else {\n"
    + "          var keep = isArray(node.fragments) ? node.fragments : [];\n"
    + "          var readable = false;\n"
    + "          for (var q = 0; q < keep.length; q++) {\n"
    + "            if (keep[q] && keep[q].type !== 'TEMPLATE_RESPONSE'\n"
    + "                && keep[q].type !== 'TIP' && keep[q].content) { readable = true; }\n"
    + "          }\n"
    + "          if (!readable) {\n"
    + "            node.fragments = [{ id: 2, type: 'TIP', style: 'WARNING', content: tipNotFound() }];\n"
    + "          } else {\n"
    + "            keep.push({ id: keep.length + 2, type: 'TIP', style: 'WARNING', content: tipNotFound() });\n"
    + "            node.fragments = keep;\n"
    + "          }";
  if (s.indexOf(o4) < 0) throw new Error('A14 anchor miss');
  s = s.split(o4).join(p4);

  /* ---- A15: sess 也可挂在 message 自身 ---- */
  var q4 = "      if (node.chat_session && node.chat_session.id) sess = String(node.chat_session.id);";
  var r4 = "      if (node.chat_session && node.chat_session.id) sess = String(node.chat_session.id);\n"
    + "      if (node.chat_session_id) sess = String(node.chat_session_id);\n"
    + "      if (node.session_id) sess = String(node.session_id);";
  if (s.indexOf(q4) < 0) throw new Error('A15 anchor miss');
  s = s.split(q4).join(r4);
  return s;
}

var fixed = patch(orig);
{if (process.env.DS_DUMP) require('fs').writeFileSync(process.env.DS_DUMP, fixed);}
require('acorn').parse(fixed, { ecmaVersion: 5, sourceType: 'script' });
console.log('patched copy parses as ES5: ok\n');

/* ---------------- 各断言 ---------------- */
function tA2b(src) {
  var e = env.createEnv(src), x = new e.XHR();
  x.open('POST', '/api/v0/chat/resume_stream');
  x.send(JSON.stringify({ chat_session_id: 'SR2' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 300, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '前半段' }] }] }),
    ev({ p: '', o: 'SET', v: { response: { message_id: 301, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '重放正文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  var it = JSON.parse(e.storage.getItem('__ds_archive_index') || '[]');
  return it.length === 1 && it[0].msgId === 301;
}

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
  return x.responseText.indexOf('CONTENT_FILTER') === -1 && rec && rec.fragments.length === 1;
}

function tA4(src) {
  var e = env.createEnv(src), x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S4' }));
  feed(x, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 500, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '原文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'SET', v: [] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ]);
  var rec = JSON.parse(e.storage.getItem('deleted-chat-sess-S4-msg-500') || 'null');
  return rec && rec.fragments.length >= 1;
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
  return !bad && e.shell.count() === 1;
}

function tA13(src) {
  var e = env.createEnv(src);
  var g = new e.XHR();
  g.open('POST', '/api/v0/chat/completion');
  g.send(JSON.stringify({ chat_session_id: 'sess-json' }));
  feed(g, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 1300, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '原文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  var x = new e.XHR();
  x.responseType = 'json';
  x.open('POST', '/api/v0/chat/history_messages');
  x.send('{}');
  x.status = 200; x.readyState = 4;
  x._responseText = JSON.stringify({ data: { biz_data: { chat_session: { id: 'sess-json' },
    chat_messages: [{ message_id: 1300, status: 'CONTENT_FILTER', fragments: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] } } });
  x._emit('readystatechange');
  var o = x.response;
  return o && o.data.biz_data.chat_messages[0].status === 'FINISHED';
}

function tA14(src) {
  var e = env.createEnv(src);
  var x = hist(e, '/api/v0/chat/history_messages', JSON.stringify({
    data: { biz_data: { chat_session: { id: 'S14' }, chat_messages: [{
      message_id: 1400, status: 'CONTENT_FILTER',
      fragments: [{ id: 2, type: 'ANSWER', content: '服务器仍返回的可读正文' }] }] } }
  }));
  var m = JSON.parse(x.responseText).data.biz_data.chat_messages[0];
  return JSON.stringify(m.fragments).indexOf('服务器仍返回的可读正文') >= 0
    && m.fragments[m.fragments.length - 1].type === 'TIP';
}

function tA15(src) {
  var e = env.createEnv(src);
  var g = new e.XHR();
  g.open('POST', '/api/v0/chat/completion');
  g.send(JSON.stringify({ chat_session_id: 'sess-page' }));
  feed(g, [
    ev({ p: '', o: 'SET', v: { response: { message_id: 1500, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '原文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''
  ]);
  var x = hist(e, '/api/v0/chat/fetch_page', JSON.stringify({
    data: { biz_data: { chat_messages: [{ message_id: 1500, chat_session_id: 'sess-page',
      status: 'CONTENT_FILTER', fragments: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] } }
  }));
  var m = JSON.parse(x.responseText).data.biz_data.chat_messages[0];
  return m.fragments[0].type !== 'TEMPLATE_RESPONSE';
}

function tReg(src) {
  var e = env.createEnv(src), x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'R' }));
  var l = [ev({ p: '', o: 'SET', v: { response: { message_id: 1, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '正常' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }), ''];
  feed(x, l);
  // 无存档 + 无可读内容的历史 → 仍应显示"未找到"
  var x2 = hist(e, null, JSON.stringify({ data: { biz_data: { chat_session: { id: 'R' },
    chat_messages: [{ message_id: 9, status: 'CONTENT_FILTER', fragments: [] }] } } }));
  var m = JSON.parse(x2.responseText).data.biz_data.chat_messages[0];
  return x.responseText === l.join(NL) && e.shell.count() === 0
    && m.fragments[0].type === 'TIP' && m.status === 'FINISHED';
}

var rows = [
  ['A2b 重放更新 state', tA2b], ['A3 response 清空后存档', tA3],
  ['A4 fragments 清空后存档', tA4], ['A6 msgId 缺失不丢', tA6],
  ['A13 responseType=json', tA13], ['A14 无存档不顶掉正文', tA14],
  ['A15 fetch_page sess 兜底', tA15], ['回归：正常流 + 未找到占位', tReg]
];
var bad = 0;
rows.forEach(function (r) {
  var before, after;
  try { before = r[1](orig) ? 'ok' : 'BUG'; } catch (err) { before = 'err'; }
  try { after = r[1](fixed) ? 'ok' : 'BUG'; } catch (err) { after = 'err:' + err.message; }
  var nm = r[0]; while (nm.length < 26) nm += ' ';
  console.log('  ' + nm + ' 原始=' + before + '  修法后=' + after);
  if (after !== 'ok') bad++;
});
console.log(bad === 0 ? '\nFIX-VERIFIED (batch 2): 全部修法有效' : '\nFIX-INCOMPLETE: ' + bad + ' 项仍失败');
process.exit(bad === 0 ? 0 : 1);
