/**
 * 修法实证：把 A1/A5/A7 三条最小修法打到一个内存副本上，跑同一批断言，
 * 证明"改这几行就能修好"，且不破坏既有 16 用例（回归由 lead 的 run.js 负责）。
 * 不写 app/ 任何文件。
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

/* ---- 三条修法 ---- */
function patch(s) {
  var a = "      this.__dsUrl = String(url);";
  var b = "      this.__dsUrl = String(url);\n"
    + "      this.__dsState = null; this.__dsOffset = 0;\n"
    + "      this.__dsRewrites = []; this.__dsSessId = '';";
  if (s.indexOf(a) < 0) throw new Error('anchor1 miss');
  s = s.split(a).join(b);

  var c = "      if (op.o === 'SET') {";
  var d = "      var opMode = op.o || 'SET';\n      if (opMode === 'SET') {";
  if (s.indexOf(c) < 0) throw new Error('anchor2 miss');
  s = s.split(c).join(d);
  var e2 = "      if (op.o === 'APPEND') {";
  if (s.indexOf(e2) < 0) throw new Error('anchor3 miss');
  s = s.split(e2).join("      if (opMode === 'APPEND') {");

  var f = "    if (lastNl < 0) return applyRewrites(req, text);";
  var g = "    if (lastNl < 0) {\n"
    + "      if (req.readyState === 4) { lastNl = chunk.length - 1; }\n"
    + "      else { return applyRewrites(req, text); }\n"
    + "    }";
  if (s.indexOf(f) < 0) throw new Error('anchor4 miss');
  s = s.split(f).join(g);

  var h = "      var nl = text.indexOf('\\n', lineStart);\n"
    + "      if (nl < 0 || nl >= scanEnd) break;";
  var k2 = "      var nl = text.indexOf('\\n', lineStart);\n"
    + "      if (nl < 0 || nl >= scanEnd) {\n"
    + "        if (nl < 0 && req.readyState === 4) { nl = scanEnd; }\n"
    + "        else { break; }\n"
    + "      }";
  if (s.indexOf(h) < 0) throw new Error('anchor5 miss');
  s = s.split(h).join(k2);
  return s;
}

var fixed = patch(orig);
require('acorn').parse(fixed, { ecmaVersion: 5, sourceType: 'script' });
console.log('patched copy parses as ES5: ok');

/* ---- A1 ---- */
function tA1(src) {
  var e = env.createEnv(src), xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S1' }));
  var l1 = [ev({ p: '', o: 'SET', v: { response: { message_id: 101, fragments: [] } } })];
  for (var z = 0; z < 5; z++) l1.push(ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'APPEND', v: [{ id: 2 + z, type: 'ANSWER', content: '第一次第' + z + '段' }] }] }));
  l1.push(ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
    { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }));
  l1.push(''); feed(xhr, l1);

  var l2 = [ev({ p: '', o: 'SET', v: { response: { message_id: 202, fragments: [] } } })];
  for (var q = 0; q < 40; q++) l2.push(ev({ p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'APPEND', v: [{ id: 2 + q, type: 'ANSWER', content: '第二次第' + q + '段正文' }] }] }));
  l2.push(ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }));
  l2.push('');
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S2' }));
  feed(xhr, l2);
  return xhr.responseText === l2.join(NL);
}

/* ---- A5 ---- */
function tA5(src) {
  var e = env.createEnv(src), xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S5' }));
  var l = [ev({ p: '', o: 'SET', v: { response: { message_id: 600, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '会被拦截的正文' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] }] }),
    ''];
  feed(xhr, l);
  return xhr.responseText.indexOf('TEMPLATE_RESPONSE') === -1 && e.shell.count() === 1;
}

/* ---- A7 ---- */
function tA7(src) {
  var e = env.createEnv(src), xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'S7' }));
  xhr._receiveHeaders(200);
  var l = [ev({ p: '', o: 'SET', v: { response: { message_id: 700, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '末尾撤回的正文' }] }] })];
  var body = l.join(NL) + NL
    + ev({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] });
  xhr._responseText = body; xhr.readyState = 3;
  xhr._emit('progress', {}); read(xhr);
  xhr._finish(); read(xhr);
  return xhr.responseText.indexOf('TEMPLATE_RESPONSE') === -1 && e.shell.count() === 1;
}

/* ---- 回归：正常流 / STOPPED 不被误伤 ---- */
function tReg(src) {
  var e = env.createEnv(src), xhr = new e.XHR();
  xhr.open('POST', '/api/v0/chat/completion');
  xhr.send(JSON.stringify({ chat_session_id: 'R' }));
  var l = [ev({ p: '', o: 'SET', v: { response: { message_id: 1, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '正常' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'STOPPED' }] }), ''];
  feed(xhr, l);
  var x2 = new e.XHR();
  x2.open('POST', '/api/v0/chat/completion');
  x2.send(JSON.stringify({ chat_session_id: 'R2' }));
  var l2 = [ev({ p: '', o: 'SET', v: { response: { message_id: 2, fragments: [] } } }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'ANSWER', content: '正常2' }] }] }),
    ev({ p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] }), ''];
  feed(x2, l2);
  return xhr.responseText === l.join(NL) && x2.responseText === l2.join(NL)
    && e.shell.count() === 0;
}

var rows = [
  ['A1 XHR 复用', tA1], ['A5 op.o 缺省', tA5], ['A7 末尾无换行', tA7],
  ['回归：正常/STOPPED 不误伤', tReg]
];
var bad = 0;
rows.forEach(function (r) {
  var before = null, after = null;
  try { before = r[1](orig) ? 'ok' : 'BUG'; } catch (err) { before = 'err:' + err.message; }
  try { after = r[1](fixed) ? 'ok' : 'BUG'; } catch (err) { after = 'err:' + err.message; }
  var nm = r[0];
  while (nm.length < 28) nm += ' ';
  console.log('  ' + nm + ' 原始=' + before + '  打补丁后=' + after);
  if (after !== 'ok') bad++;
});
console.log(bad === 0 ? '\nFIX-VERIFIED: 三条修法均有效，且正常流/STOPPED 未回归'
  : '\nFIX-INCOMPLETE: ' + bad + ' 项仍失败');
process.exit(bad === 0 ? 0 : 1);
