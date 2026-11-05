/**
 * C4 修法实证：前缀匹配 → 路径边界匹配。
 * 只改内存副本，不写 app/。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var env = require('../mock/env');

var ROOT = path.resolve(__dirname, '../../..');
var orig = fs.readFileSync(path.join(ROOT, 'app/assets/ds_shell.js'), 'utf8');

function patch(s) {
  var a = "      if (p === URL_GENERATE[i] || p.indexOf(URL_GENERATE[i]) === 0) return 'generate';";
  var b = "      if (pathHits(p, URL_GENERATE[i])) return 'generate';";
  if (s.indexOf(a) < 0) throw new Error('anchor1 miss');
  s = s.split(a).join(b);

  var c = "      if (p === URL_HISTORY[i] || p.indexOf(URL_HISTORY[i]) === 0) return 'history';";
  var d = "      if (pathHits(p, URL_HISTORY[i])) return 'history';";
  if (s.indexOf(c) < 0) throw new Error('anchor2 miss');
  s = s.split(c).join(d);

  var e = "  function classify(url) {";
  var f = "  /** 路径边界匹配：相等，或后面紧跟 '/' 或结尾。避免 completion 吞掉 completion_status */\n"
    + "  function pathHits(p, base) {\n"
    + "    if (p === base) return true;\n"
    + "    if (p.length <= base.length) return false;\n"
    + "    return p.substring(0, base.length) === base\n"
    + "        && p.charAt(base.length) === '/';\n"
    + "  }\n\n"
    + "  function classify(url) {";
  if (s.indexOf(e) < 0) throw new Error('anchor3 miss');
  s = s.split(e).join(f);
  return s;
}

var fixed = patch(orig);
require('acorn').parse(fixed, { ecmaVersion: 5, sourceType: 'script' });
console.log('patched copy parses as ES5: ok\n');

function classifyOf(script, u) {
  var e = env.createEnv(script);
  return e.shell._internals.classify(u);
}

var realPaths = [
  '/api/v0/chat/completion', '/api/v0/chat/edit_message', '/api/v0/chat/regenerate',
  '/api/v0/chat/continue', '/api/v0/chat/resume_stream',
  '/api/v0/chat/history_messages', '/api/v0/chat_session/fetch_page',
  '/api/v0/chat/fetch_page', '/api/v0/chat_session/history_messages',
  '/api/v0/chat/fetch_messages'
];
var neighbours = [
  '/api/v0/chat/completion_status', '/api/v0/chat/completion_quota',
  '/api/v0/chat/history_messages_read', '/api/v0/chat/continue_stop',
  '/api/v0/chat/edit_message_draft', '/api/v0/chat/regenerate_preview',
  '/api/v0/chat/completionx'
];

var fail = 0;
function check(label, fn) {
  try { if (!fn()) { console.log('  FAIL  ' + label); fail++; } else console.log('  ok    ' + label); }
  catch (e) { console.log('  ERR   ' + label + ' :: ' + e.message); fail++; }
}

console.log('--- 真实路径必须仍被识别 ---');
realPaths.forEach(function (u) {
  var want = u.indexOf('/chat_session/') >= 0 || u.indexOf('fetch_page') >= 0
    || u.indexOf('history_messages') >= 0 || u.indexOf('fetch_messages') >= 0
    ? 'history' : 'generate';
  check(u + ' → ' + want, function () { return classifyOf(fixed, u) === want; });
});

console.log('\n--- 相邻接口必须不再误判 ---');
neighbours.forEach(function (u) {
  check(u + ' → 不分类', function () { return classifyOf(fixed, u) === null; });
});

console.log('\n--- 原始版本在这些相邻接口上的表现（用于说明 C4 确有其事） ---');
neighbours.forEach(function (u) {
  var r = classifyOf(orig, u);
  if (r) console.log('  (原始) ' + u + ' → ' + r);
});

/* 端到端：误判为 history 时普通 JSON 会被改写，修好后不会 */
function e2e(script, u) {
  var e = env.createEnv(script);
  var x = new e.XHR();
  x.open('POST', u);
  x.send('{}');
  var body = JSON.stringify({ data: { list: [
    { message_id: 77, status: 'CONTENT_FILTER', fragments: [] }] } });
  x.status = 200; x.readyState = 4; x._responseText = body;
  x._emit('readystatechange');
  try { void x.responseText; } catch (err) { }
  return String(x.responseText) === body;
}
console.log('\n--- 端到端：普通 JSON 响应完整性 ---');
check('原始版本对 /completion_quota 的响应是否被改动',
  function () { return e2e(orig, '/api/v0/chat/completion_quota'); });
check('修法版本对 /completion_quota 的响应是否被改动',
  function () { return e2e(fixed, '/api/v0/chat/completion_quota'); });
check('原始版本对 /history_messages_meta 的响应是否被改动',
  function () { return e2e(orig, '/api/v0/chat/history_messages_meta'); });
check('修法版本对 /history_messages_meta 的响应是否被改动',
  function () { return e2e(fixed, '/api/v0/chat/history_messages_meta'); });

/* 回归：真实撤回流仍要能工作 */
function stillWorks(script) {
  var e = env.createEnv(script);
  var x = new e.XHR();
  x.open('POST', '/api/v0/chat/completion');
  x.send(JSON.stringify({ chat_session_id: 'S' }));
  x._receiveHeaders(200);
  var lines = [
    'data: ' + JSON.stringify({ p: '', o: 'SET', v: { response: { message_id: 1, fragments: [] } } }),
    'data: ' + JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND',
      v: [{ id: 2, type: 'ANSWER', content: '正文' }] }] }),
    'data: ' + JSON.stringify({ p: 'response', o: 'BATCH', v: [
      { p: 'fragments', o: 'SET', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: '' }] },
      { p: 'status', o: 'SET', v: 'CONTENT_FILTER' }] }),
    ''
  ];
  x._responseText = lines.join('\n');
  x.readyState = 3; x._emit('progress'); try { void x.responseText; } catch (a) { }
  x._finish(); try { void x.responseText; } catch (a) { }
  return e.shell.count() === 1 && String(x.responseText).indexOf('TEMPLATE_RESPONSE') === -1;
}
console.log('\n--- 回归：真实撤回仍工作 ---');
check('修法后 /completion 撤回仍被拦截并存档', function () { return stillWorks(fixed); });

console.log(fail === 0 ? '\nFIX-VERIFIED (C4)' : '\nFIX-INCOMPLETE: ' + fail);
process.exit(fail === 0 ? 0 : 1);
