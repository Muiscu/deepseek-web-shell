/**
 * DeepSeek 防撤回注入脚本（ds_shell.js）
 * ---------------------------------------------------------------------------
 * * 思路源自 GreasyFork「DeepSeek Anti-recall」(Franky T)，
 * 但在当前线上版本（commit 26090614）上做了大量修正，见下方"相对原脚本的改动"。
 *
 * 【为什么是 ES5】
 * 宿主可能在 Android 5.1（Chromium 37）上执行本脚本。虽然该内核对 DeepSeek
 * 前端 bundle 已经跑不动，但本脚本必须至少能安全执行并给出诊断，
 * 否则用户连"发生了什么"都看不到。所以全文只用 ES5 语法。
 *
 * 【安装时机与顺序】
 * 宿主在 shouldInterceptRequest 里把本脚本内联到 <head> 最前面，
 * 先于 React bundle 执行，因此能赶到第一次 XHR。
 * 幂等：重复注入不会重复安装。
 *
 * 【相对原脚本的改动】
 *  1. 增量解析：记住上次处理的字符偏移，只解析新增的完整行（原版每次重切全长 → O(n²)）
 *  2. 原 getter 调用全部 try/catch，且 readyState >= 2 才读（原版会抛 InvalidStateError 打断请求）
 *  3. 存档结构化 + 索引 + 向后兼容读旧格式（原版只存裸数组）
 *  4. 额外 hook fetch，异常一律回退（原版只 hook XHR）
 *  5. 撤回信号覆盖到 4 类，其中"疑似撤回"只上报不篡改（防误伤正常停止）
 *  6. 历史还原递归遍历 JSON，不硬编码层级（兼容分页接口）
 *  7. localStorage 写入失败降级到内存，不打断流
 *  8. 暴露 __DS_SHELL__ 控制面（开关/计数/导出/删除/清空）
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.__DS_SHELL_INSTALLED__) return;
  window.__DS_SHELL_INSTALLED__ = true;

  var VERSION = '1.4.5';

  /* =====================================================================
   * 0. 配置与常量
   * ===================================================================== */
  var CFG = window.__DS_APP_CFG__ || {};
  var enabled = CFG.antiRecall === undefined ? true : !!CFG.antiRecall;
  var debugOn = !!CFG.debug;

  var TEMPLATE_RESPONSE = 'TEMPLATE_RESPONSE';
  var CONTENT_FILTER = 'CONTENT_FILTER';

  var TIP_RECALL_ZH = '\u26a0\ufe0f 此回复已被拦截，仅在本机存档';
  var TIP_RECALL_EN = '\u26a0\ufe0f This response has been blocked and archived only on this device';
  var TIP_NOTFOUND_ZH = '\u26d4 此回复已被拦截，且本地存档中未找到';
  var TIP_NOTFOUND_EN = '\u26d4 This response has been blocked and cannot be found in local archive';

  var KEY_INDEX = '__ds_archive_index';
  var KEY_PREFIX = 'deleted-chat-sess-';

  var locale = 'zh_CN';

  function tipRecall() {
    return locale === 'zh_CN' ? TIP_RECALL_ZH : TIP_RECALL_EN;
  }
  function tipNotFound() {
    return locale === 'zh_CN' ? TIP_NOTFOUND_ZH : TIP_NOTFOUND_EN;
  }

  /* =====================================================================
   * 1. 日志
   * ===================================================================== */
  var LOG_MAX = 200;
  var logRing = [];

  function log(kind, msg, extra) {
    var item = { t: Date.now(), kind: kind, msg: String(msg) };
    if (extra !== undefined) {
      try { item.extra = typeof extra === 'string' ? extra : JSON.stringify(extra); }
      catch (e) { item.extra = String(extra); }
    }
    logRing.push(item);
    if (logRing.length > LOG_MAX) logRing.shift();
    if (debugOn) {
      try { if (window.console && console.log) console.log('[DS]', kind, msg); } catch (e) { }
      try { if (window.DSApp && DSApp.log) DSApp.log(kind + ': ' + msg); } catch (e) { }
    }
  }

  /* =====================================================================
   * 2. Bridge 安全调用
   * ===================================================================== */
  function bridge(name, arg) {
    try {
      if (window.DSApp && typeof window.DSApp[name] === 'function') {
        if (arg === undefined) window.DSApp[name]();
        else window.DSApp[name](arg);
      }
    } catch (e) {
      // bridge 抛错绝不能影响页面主流程
    }
  }

  /* =====================================================================
   * 3. 存档层
   * ===================================================================== */
  var memStore = {};
  var memIndex = null;

  function storage() {
    try {
      if (window.localStorage && typeof window.localStorage.getItem === 'function') {
        return window.localStorage;
      }
    } catch (e) { }
    return null;
  }

  function sget(key) {
    var ls = storage();
    if (ls) {
      try { return ls.getItem(key); } catch (e) { }
    }
    return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
  }

  function sset(key, val) {
    var ls = storage();
    if (ls) {
      try {
        ls.setItem(key, val);
        return true;
      } catch (e) {
        memStore[key] = val;
        bridge('onArchiveError', (e && e.name ? e.name : 'setItem-failed'));
        log('warn', 'localStorage 写入失败，降级到内存', e && e.name);
        return false;
      }
    }
    memStore[key] = val;
    return false;
  }

  function sdel(key) {
    var ls = storage();
    if (ls) {
      try { ls.removeItem(key); } catch (e) { }
    }
    if (Object.prototype.hasOwnProperty.call(memStore, key)) delete memStore[key];
  }

  function archiveKey(sessId, msgId) {
    return KEY_PREFIX + sessId + '-msg-' + msgId;
  }

  function loadArchive(sessId, msgId) {
    var raw = sget(archiveKey(sessId, msgId));
    if (!raw) return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed) return null;

    if (isArray(parsed)) {
      return { v: 1, ts: 0, sessId: sessId, msgId: msgId, reason: TEMPLATE_RESPONSE, fragments: parsed };
    }
    if (typeof parsed === 'object' && parsed.fragments && isArray(parsed.fragments)) {
      return parsed;
    }
    return null;
  }

  function saveArchive(sessId, msgId, fragments, reason, sessionTitle) {
    var rec = {
      v: 1,
      ts: Date.now(),
      sessId: sessId,
      msgId: msgId,
      reason: reason,
      locale: locale,
      title: sessionTitle || '',
      fragments: fragments
    };
    var ok = sset(archiveKey(sessId, msgId), JSON.stringify(rec));
    memIndex = null;   // 索引可能已变，强制下次重读
    updateIndex(rec, ok);
    return ok;
  }

  /* ---------------------------------------------------------------------
   * 实时暂存（"先都存下来"策略）
   * ---------------------------------------------------------------------
   * 为什么需要它（这是最关键的认知修正）：
   *   撤回并不总是发生在流里。DeepSeek 的 history 接口会返回
   *   status=CONTENT_FILTER 的消息 —— 说明一条回复可能"先正常生成完，
   *   之后才被审核标记成屏蔽"。
   *
   *   如果只在检测到撤回信号时才存档，这种"事后撤回"就完全没有东西可存，
   *   用户看到的就是"依旧被撤回，存档为空"。
   *
   *   所以策略改成：
   *     ① 每条回复在生成过程中就**持续暂存**到 liveKey；
   *     ② 内容停止增长满 GRACE_MS 且请求已结束 → 转为正式存档；
   *     ③ 若中途检测到撤回信号 → 立即转为正式存档（提前定稿）。
   *
   *   暂存与正式存档用不同的 key 前缀，避免污染存档索引。
   * --------------------------------------------------------------------- */

  var LIVE_PREFIX = '__ds_live_';

  function liveKey(sessId, msgId) {
    return LIVE_PREFIX + sessId + '-msg-' + msgId;
  }

  /** 实时写入暂存（内容增长时调用） */
  function writeLive(sessId, msgId, text, fragments, extra) {
    try {
      var rec = {
        v: 1,
        ts: Date.now(),
        sessId: sessId,
        msgId: msgId,
        text: text,
        fragments: fragments || [],
        settled: !!(extra && extra.settled)
      };
      sset(liveKey(sessId, msgId), JSON.stringify(rec));
      return true;
    } catch (e) {
      return false;
    }
  }

  function readLive(sessId, msgId) {
    var raw = sget(liveKey(sessId, msgId));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function dropLive(sessId, msgId) {
    sdel(liveKey(sessId, msgId));
  }

  /** 把暂存转为正式存档 */
  function commitLive(sessId, msgId, reason) {
    var live = readLive(sessId, msgId);
    if (!live) return false;
    var frags = live.fragments;
    if (!frags || frags.length === 0) {
      // 暂存里只有纯文本，尝试从流文本重建片段
      frags = extractFragmentsFromStream(live.text || '');
    }
    frags = extractReadable(frags);
    if (!frags || frags.length === 0) {
      dropLive(sessId, msgId);
      return false;
    }

    // ★ 已有正式存档就不要用定稿覆盖它。
    //   信号检测（TEMPLATE_RESPONSE / CONTENT_FILTER）比"内容停增"更精确，
    //   覆盖会把精确原因退化成 LIVE_SETTLED，还会丢掉信号路径保存的完整片段。
    var existing = loadArchive(sessId, msgId);
    if (existing && existing.fragments && existing.fragments.length > 0) {
      dropLive(sessId, msgId);
      log('commit-skip', 'msgId=' + msgId + ' 已有存档(' + existing.reason + ')，不覆盖');
      return false;
    }

    saveArchive(sessId, msgId, frags, reason || 'LIVE_COMMIT');
    dropLive(sessId, msgId);
    log('commit', 'msgId=' + msgId + ' reason=' + (reason || 'LIVE_COMMIT')
        + ' frags=' + frags.length);
    return true;
  }

  /** 列出所有尚未定稿的暂存条目（用于补定稿/诊断） */
  function listLive() {
    var out = [];
    try {
      var ls = storage();
      if (!ls) return out;
      // localStorage 没有 keys() 的统一实现，用长度+key(i) 遍历
      var n = 0;
      try { n = ls.length || 0; } catch (e) { n = 0; }
      for (var i = 0; i < n; i++) {
        var k = '';
        try { k = ls.key(i) || ''; } catch (e) { k = ''; }
        if (!k || k.indexOf(LIVE_PREFIX) !== 0) continue;
        var raw = null;
        try { raw = ls.getItem(k); } catch (e) { raw = null; }
        if (!raw) continue;
        try { out.push(JSON.parse(raw)); } catch (e) { }
      }
    } catch (e) { }
    return out;
  }

  function loadIndex() {
    if (memIndex) return memIndex;
    var raw = sget(KEY_INDEX);
    if (!raw) { memIndex = []; return memIndex; }
    try {
      var arr = JSON.parse(raw);
      memIndex = isArray(arr) ? arr : [];
    } catch (e) {
      memIndex = [];
    }
    return memIndex;
  }

  function saveIndex() {
    try {
      sset(KEY_INDEX, JSON.stringify(memIndex || []));
    } catch (e) { }
  }

  function updateIndex(rec, persisted) {
    var idx = loadIndex();
    var replaced = false;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].sessId === rec.sessId && String(idx[i].msgId) === String(rec.msgId)) {
        idx[i] = buildIndexItem(rec);
        replaced = true;
        break;
      }
    }
    if (!replaced) idx.push(buildIndexItem(rec));
    saveIndex();
    bridge('onArchiveChanged', idx.length);
    pushSnapshot();
    if (!persisted) {
      log('warn', '存档仅存于内存（持久化失败）');
    }
  }

  function buildIndexItem(rec) {
    return {
      sessId: rec.sessId,
      msgId: rec.msgId,
      ts: rec.ts,
      reason: rec.reason,
      title: rec.title || '',
      preview: makePreview(rec.fragments)
    };
  }

  function makePreview(fragments) {
    if (!fragments || !fragments.length) return '';
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (!f) continue;
      if (f.type === 'TEMPLATE_RESPONSE' || f.type === 'TIP') continue;
      var c = f.content;
      if (typeof c === 'string' && c.length > 0) {
        return c.length > 60 ? c.substring(0, 60) + '\u2026' : c;
      }
    }
    return '';
  }

  function fragmentsToText(fragments) {
    if (!fragments || !fragments.length) return '';
    var parts = [];
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (!f) continue;
      if (f.type === 'TEMPLATE_RESPONSE' || f.type === 'TIP') continue;
      var c = f.content;
      if (typeof c !== 'string' || c.length === 0) continue;
      parts.push(c);
    }
    return parts.join('\n\n');
  }

  /* =====================================================================
   * 4. SSE 状态机
   * ===================================================================== */
  function DSState(sessId) {
    this.fields = {};
    this.sessId = sessId || '';
    this.recalled = false;
    this.recallReason = null;
    this.rawBackup = null;
  }

  function parseKey(key, container) {
    if (isArray(container) && /^[-+]?\d+$/.test(key)) {
      var n = parseInt(key, 10);
      if (n < 0) n = container.length + n;
      return n;
    }
    return key;
  }

  /**
   * 规范化路径段。
   *
   * ★ 关键修复：真实 SSE 的 p 字段可能带前导斜杠（如 "/response/fragments/0/content"）。
   * 若直接拼接会得到 "response//fragments/0/content"，split 后出现空段，
   * 导致路径断掉、后续帧全部写不进去 —— 表现为"只存了前两个字符"。
   * 这里统一去掉多余的首尾斜杠。
   */
  function normalizePath(p) {
    var s = String(p === undefined || p === null ? '' : p);
    // 去掉所有前导斜杠
    while (s.length > 0 && s.charAt(0) === '/') s = s.substring(1);
    // 去掉尾部斜杠
    while (s.length > 0 && s.charAt(s.length - 1) === '/') s = s.substring(0, s.length - 1);
    // 折叠连续斜杠
    while (s.indexOf('//') >= 0) s = s.replace('//', '/');
    return s;
  }

  /** 把父子路径安全拼起来 */
  function joinPath(parent, child) {
    var a = normalizePath(parent);
    var b = normalizePath(child);
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    return a + '/' + b;
  }

  function setValueByPath(obj, path, value, isAppend) {
    var keys = normalizePath(path).split('/');
    var cur = obj;
    var i;
    for (i = 0; i < keys.length - 1; i++) {
      var k = parseKey(keys[i], cur);
      if (cur[k] === undefined || cur[k] === null) {
        var nextK = parseKey(keys[i + 1], cur);
        cur[k] = typeof nextK === 'number' ? [] : {};
      }
      var nxt = cur[k];
      if (typeof nxt !== 'object' || nxt === null) {
        cur[k] = {};
        nxt = cur[k];
      }
      cur = nxt;
    }
    var last = parseKey(keys[keys.length - 1], cur);
    if (isAppend) {
      if (isArray(cur[last])) {
        if (isArray(value)) {
          for (var j = 0; j < value.length; j++) cur[last].push(value[j]);
        } else {
          cur[last].push(value);
        }
      } else if (typeof cur[last] === 'string') {
        cur[last] = cur[last] + (value === null || value === undefined ? '' : String(value));
      } else if (value !== null && value !== undefined) {
        cur[last] = isArray(value) ? value.slice() : value;
      }
    } else {
      cur[last] = value;
    }
    return obj;
  }

  /**
   * 处理单个事件。
   * @returns {string} 非空表示该行需要被替换（撤回被拦截）
   */
  DSState.prototype.handle = function (data) {
    if (!enabled) return '';

    // ★ 路径必须规范化：真实 SSE 的 p 可能带前导斜杠。
    // 不规范化会导致 "path === 'response'" 这类判定全部失效，
    // 撤回信号（p="response"）永远匹配不上。
    var path = normalizePath(data.p !== undefined ? data.p : '');
    var mode = data.o || 'SET';
    var value = data.v;

    // 首个事件：整体 response 对象（path 为空且 v 是对象）
    if (path === '' && typeof value === 'object' && value !== null && !isArray(value)) {
      // ★ B2：服务器可能对同一 key 发第二次整体 SET（resume_stream 重放）。
      // 旧逻辑用 `if (this.fields[k] === undefined)` 会拒绝覆盖，
      // 导致 message_id / fragments 永久停在旧值，存档写进错误的 msgId。
      // 整体事件语义就是"覆盖"，这里直接清空重建。
      if (this.fields.response) this.fields = {};

      // ★ 关键：整体 SET 意味着"这是一条新消息"（新 msgId / 新对话轮次），
      // 必须把"上一条消息的最长快照"一并清掉。
      // 否则 snapshot 会把消息 A 的原文带进消息 B 的存档 ——
      // 表现为"A 的内容出现在 B 的位置"，属于可见的数据错乱。
      var newMid = value.response ? value.response.message_id : undefined;
      if (newMid !== undefined && newMid !== null && this.lastMsgId !== newMid) {
        this.lastGoodFragments = null;
      }

      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) this.fields[k] = value[k];
      }
      if (value.response && value.response.chat_session_id) {
        this.sessId = String(value.response.chat_session_id);
      }
      // 整体 SET 之后维护快照（此时是这条新消息自己的内容）
      this.snapshot(value);
      return '';
    }

    // ★★★ 最关键的一条：裸字符串增量事件。
    //
    //   线上真实事件分布（用户实测导出）：
    //       ×1127  p=- o=- v=str(1)
    //       × 905  p=- o=- v=str(2)
    //       × 185  p=- o=- v=str(3)
    //       ×  18  p=- o=- v=str(4)
    //   也就是说，2200 多个事件**没有 p、没有 o**，只带一个 v 字符串
    //   ——正文是「一个字符一个事件」这样吐出来的。
    //
    //   旧逻辑：path 为空 + value 是字符串时，
    //   既不进"整体 SET"分支，也过不了 `path !== ''` 的 apply，
    //   于是这些事件被**完全丢弃**。结果只有开头那几个
    //   p=response/fragments 事件建起的骨架被留下，
    //   存档正文就永远停在「1.\n\n听到」这种几个字。
    //
    //   修复：把裸字符串当作「当前片段的增量」，追加到最后一个
    //   正文片段（ANSWER）上；若还没有正文片段，就先建一个。
    if (path === '' && typeof value === 'string' && value.length > 0) {
      this.appendDelta(value);
      return '';
    }

    // 裸数组（v=[4x{p,v}]）：当作一次无外层 path 的批量操作
    if (path === '' && isArray(value) && value.length > 0) {
      this.applyBatchAt('', value);
      this.snapshot(this.fields);
      return '';
    }

    var hit = this.inspect(path, mode, value);
    if (hit) return hit;

    if (path !== '') {
      this.apply(path, value, mode);
      // ★ B6：快照必须放在 apply 之后 —— 放在 inspect 开头拿到的是旧状态。
      this.snapshot(this.fields);
    }

    return '';
  };

  /**
   * 把一段裸字符串增量追加到「当前正在生成的片段」。
   *
   * ★ 修正：不能"优先找 ANSWER"。
   *
   *   真实语义是「增量属于当前正在吐字的那个片段」，也就是**最后一个**
   *   非 TIP 片段 —— 不管它是 THINKING 还是 ANSWER。
   *
   *   上一版"优先 ANSWER"造成两个问题：
   *     ① 只有 THINKING 片段时（正文片段尚未创建），正文增量会被塞进
   *        THINKING 末尾，思考与正文混在一起；
   *     ② 若 ANSWER 片段后来才 APPEND，正文就落在错误位置，
   *        表现为「只有思考过程，正文只剩一个括号」。
   *
   *   现在一律追加到最后一个片段；若一个都没有，才自建 ANSWER。
   */
  DSState.prototype.appendDelta = function (chunk) {
    try {
      if (!this.fields.response) this.fields.response = {};
      var r = this.fields.response;
      if (!isArray(r.fragments)) r.fragments = [];
      var fr = r.fragments;

      // 找最后一个可写片段（TIP / 占位模板不算）
      var idx = -1;
      for (var i = fr.length - 1; i >= 0; i--) {
        var f = fr[i];
        if (!f) continue;
        if (f.type === TEMPLATE_RESPONSE || f.type === 'TIP') continue;
        if (typeof f.type === 'string') { idx = i; break; }
      }

      if (idx >= 0) {
        var target = fr[idx];
        if (typeof target.content !== 'string') target.content = '';
        target.content += chunk;
      } else {
        // 还没有任何片段：先建一个 ANSWER 承载增量
        fr.push({
          id: fr.length + 2,
          type: 'ANSWER',
          content: chunk
        });
      }
    } catch (e) {
      log('error', 'appendDelta: ' + e);
    }
  };

  /** 在指定前缀下应用一组批量操作（用于裸数组事件） */
  DSState.prototype.applyBatchAt = function (prefix, ops) {
    try {
      var subMode = 'SET';
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (!op || typeof op !== 'object') continue;
        if (op.o) subMode = op.o;
        var childPath = joinPath(prefix, op.p !== undefined ? op.p : '');
        if (childPath === '') {
          // 子项也没有路径：递归当作增量
          if (typeof op.v === 'string') this.appendDelta(op.v);
          continue;
        }
        this.apply(childPath, op.v, subMode);
      }
    } catch (e) {
      log('error', 'applyBatchAt: ' + e);
    }
  };

  /* ---------------------------------------------------------------------
   * 原始 SSE 事件探针（诊断用）
   * ---------------------------------------------------------------------
   * 目的：把真实收到的 SSE 事件形态记录下来，导出给宿主。
   * 之前排查「存档不全」「只存两个字符」只能靠猜线上格式，反复试错；
   * 有了它，真机把自己收到的原始事件吐出来，排查从「猜」变成「看」。
   */
  var PROBE_LIMIT = 400;
  var probeRing = [];
  var probeShape = {};

  function probeEvent(payload) {
    try {
      if (!payload || payload === '[DONE]') return;
      var d = null;
      try { d = JSON.parse(payload); } catch (e) { return; }
      if (!d || typeof d !== 'object') return;

      var sig = signatureOf(d);
      probeShape[sig] = (probeShape[sig] || 0) + 1;

      if (probeRing.length >= PROBE_LIMIT) return;
      probeRing.push({
        t: Date.now(),
        p: d.p === undefined ? null : String(d.p),
        o: d.o === undefined ? null : String(d.o),
        sig: sig,
        sample: truncateJson(d.v, 400)
      });
    } catch (e) { }
  }

  function signatureOf(d) {
    var parts = [];
    parts.push('p=' + (d.p === undefined ? '-' : String(d.p)));
    parts.push('o=' + (d.o === undefined ? '-' : String(d.o)));
    parts.push('v=' + shapeOf(d.v));
    return parts.join(' ');
  }

  function shapeOf(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return 'null';
    if (isArray(v)) {
      if (v.length === 0) return '[]';
      if (depth > 2) return '[..' + v.length + ']';
      return '[' + v.length + 'x' + shapeOf(v[0], depth + 1) + ']';
    }
    var t = typeof v;
    if (t !== 'object') {
      if (t === 'string') return 'str(' + v.length + ')';
      return t;
    }
    if (depth > 2) return '{..}';
    var keys = [];
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) keys.push(k);
    }
    if (keys.length > 8) keys = keys.slice(0, 8).concat(['...']);
    return '{' + keys.join(',') + '}';
  }

  function truncateJson(v, max) {
    try {
      var s2 = JSON.stringify(v);
      if (!s2) return 'null';
      return s2.length > max ? s2.substring(0, max) + '...' : s2;
    } catch (e) {
      return '<unserializable>';
    }
  }

  function exportProbe() {
    var shapes = [];
    for (var k in probeShape) {
      if (Object.prototype.hasOwnProperty.call(probeShape, k)) {
        shapes.push({ sig: k, count: probeShape[k] });
      }
    }
    shapes.sort(function (a, b) { return b.count - a.count; });
    return JSON.stringify({
      version: VERSION,
      total: probeRing.length,
      shapes: shapes,
      events: probeRing
    });
  }

  function clearProbe() {
    probeRing.length = 0;
    probeShape = {};
    return true;
  }

  /** 记录"曾出现过的最长 fragments"，用于 response 被清空时兜底还原 */
  DSState.prototype.snapshot = function (fields) {
    try {
      var fr = fields && fields.response && fields.response.fragments;
      if (!isArray(fr) || fr.length === 0) return;
      // 只认有实际正文的片段（纯占位模板不算）
      var hasBody = false;
      for (var i = 0; i < fr.length; i++) {
        var f = fr[i];
        if (!f) continue;
        if (f.type === TEMPLATE_RESPONSE || f.type === 'TIP') continue;
        if (typeof f.content === 'string' && f.content.length > 0) { hasBody = true; break; }
      }
      if (!hasBody) return;
      var best = this.lastGoodFragments || [];
      if (fr.length > best.length) this.lastGoodFragments = cloneFragments(fr);
    } catch (e) { }
  };

  /** 只做检测，命中则返回替换后的整行 JSON */
  DSState.prototype.inspect = function (path, mode, value) {
    if (mode !== 'BATCH' || path !== 'response' || !isArray(value)) return '';

    var response = this.fields.response || {};
    var fragments = response.fragments || [];
    var msgId = response.message_id;
    // ★ B5：服务器可能整条流都不发 response/message_id。此时若直接跳过存档，
    // 正文会静默丢失。退路：用本次请求记住的 msgId，再不行用可复现的合成 key。
    if (msgId === undefined || msgId === null) {
      msgId = this.lastMsgId;
    }
    if (msgId === undefined || msgId === null) {
      msgId = 'auto-' + (this.sessId || 'nosess') + '-'
          + (response.fragments ? response.fragments.length : 0);
    }
    this.lastMsgId = msgId;

    // ★ B6：fragments 可能已被整体清空（response 被 SET 成 {} 或 fragments SET 成 []），
    // 但原文在之前的帧里已经出现过。回退到"曾见过的最长快照"，否则原文会彻底丢失。
    if (fragments.length === 0 && this.lastGoodFragments && this.lastGoodFragments.length > 0) {
      fragments = this.lastGoodFragments;
    }

    var modified = false;
    var reason = null;
    var i;

    for (i = 0; i < value.length; i++) {
      var op = value[i];
      if (!op || op.p !== 'fragments') continue;
      var frags = op.v;
      if (!isArray(frags) || frags.length === 0) continue;
      var head = frags[0];
      if (!head || head.type !== TEMPLATE_RESPONSE) continue;

      // ★ B4：BATCH 内子操作的 o 字段可能被省略，SSE 协议缺省即 SET。
      var opMode = op.o || 'SET';

      if (opMode === 'SET') {
        // ★ B4：BATCH 内的子操作可能**省略 o 字段**，SSE 协议缺省即 SET。
        // 原脚本完全不看 o 照样命中；我们若强依赖 o 会漏检 —— 这是回归。
        // 下面用 opMode 统一处理（缺省按 SET）。
        // 信号 A：fragments 被整体覆盖成占位模板
        if (fragments.length > 0) {
          saveArchive(this.sessId, msgId, cloneFragments(fragments), TEMPLATE_RESPONSE);
          this.rawBackup = cloneFragments(fragments);
          // 改成追加一条提示，原有 fragments 保持不变（前端渲染不受影响）
          value[i] = {
            p: 'fragments',
            o: 'APPEND',
            v: [{ id: fragments.length + 2, type: 'TIP', style: 'WARNING', content: tipRecall() }]
          };
          modified = true;
          reason = TEMPLATE_RESPONSE;
        } else {
          // 没有历史内容可救：诚实显示"未找到存档"
          value[i] = {
            p: 'fragments',
            o: 'APPEND',
            v: [{ id: 2, type: 'TIP', style: 'WARNING', content: tipNotFound() }]
          };
          modified = true;
          reason = TEMPLATE_RESPONSE;
        }
        continue;
      }

      if (opMode === 'APPEND') {
        // 信号 B：直接追加了一个占位模板
        if (fragments.length > 0) {
          saveArchive(this.sessId, msgId, cloneFragments(fragments), TEMPLATE_RESPONSE);
          this.rawBackup = cloneFragments(fragments);
          value[i] = {
            p: 'fragments',
            o: 'APPEND',
            v: [{ id: fragments.length + 2, type: 'TIP', style: 'WARNING', content: tipRecall() }]
          };
        } else {
          value[i] = {
            p: 'fragments',
            o: 'APPEND',
            v: [{ id: 2, type: 'TIP', style: 'WARNING', content: tipNotFound() }]
          };
        }
        modified = true;
        reason = TEMPLATE_RESPONSE;
        continue;
      }
    }

    // 信号 C：status → CONTENT_FILTER
    for (i = 0; i < value.length; i++) {
      var op2 = value[i];
      if (!op2) continue;
      if (op2.p !== 'status') continue;

      if (op2.v === CONTENT_FILTER) {
        // 只有在"前面没有因为 fragments 信号已经存档过"时才用 CONTENT_FILTER 存档。
        // 否则同一轮 BATCH 里 fragments(占位) + status(CONTENT_FILTER) 会触发两次
        // saveArchive，后写覆盖先写，把更精确的 TEMPLATE_RESPONSE 原因覆盖成 CONTENT_FILTER。
        if (!modified && msgId !== undefined && msgId !== null && fragments.length > 0) {
          saveArchive(this.sessId, msgId, cloneFragments(fragments), CONTENT_FILTER);
        }
        // 改 FINISHED，否则前端会一直转圈并把思考过程吞掉
        value[i] = { p: 'status', o: 'SET', v: 'FINISHED' };
        modified = true;
        // 首因优先：若 fragments 信号已经定性，保留它
        reason = reason || CONTENT_FILTER;
        continue;
      }

      // 信号 D：未知 status —— 只记录，不篡改（避免误伤用户主动停止）
      if (typeof op2.v === 'string') {
        var st = op2.v;
        if (st !== 'FINISHED' && st !== 'STOPPED' && st !== 'IN_PROGRESS') {
          log('suspicious', '未知 status: ' + st);
        }
      }
    }

    if (modified) {
      this.recalled = true;
      this.recallReason = reason || TEMPLATE_RESPONSE;
      stats.recalls++;
      log('recall', 'msgId=' + msgId + ' reason=' + this.recallReason
          + ' frags=' + fragments.length);
      bridge('onRecall', JSON.stringify({
        sessId: this.sessId,
        msgId: msgId === undefined ? null : msgId,
        reason: this.recallReason,
        preview: makePreview(fragments)
      }));
      return JSON.stringify({ p: path, o: mode, v: value });
    }

    return '';
  };

  DSState.prototype.apply = function (path, value, mode) {
    if (mode === 'BATCH') {
      if (!isArray(value)) return;
      for (var i = 0; i < value.length; i++) {
        var op = value[i];
        if (!op) continue;
        var subMode = op.o || 'SET';
        this.apply(joinPath(path, op.p), op.v, subMode);
      }
    } else if (mode === 'APPEND') {
      setValueByPath(this.fields, path, value, true);
    } else {
      setValueByPath(this.fields, path, value, false);
    }
  };

  function cloneFragments(fr) {
    try {
      return JSON.parse(JSON.stringify(fr));
    } catch (e) {
      return fr;
    }
  }

  /* =====================================================================
   * 5. 流式响应处理（增量）
   * ===================================================================== */
  var URL_GENERATE = [
    '/api/v0/chat/completion',
    '/api/v0/chat/edit_message',
    '/api/v0/chat/regenerate',
    '/api/v0/chat/continue',
    '/api/v0/chat/resume_stream'
  ];
  var URL_HISTORY = [
    '/api/v0/chat/history_messages',
    '/api/v0/chat_session/fetch_page',
    // ★ B10：分页接口的路径在历史上出现过两种形态，两种都要认。
    // 只写死一个会导致"路径一变就静默失效"，而这正是本功能最怕的失败模式。
    '/api/v0/chat/fetch_page',
    '/api/v0/chat_session/history_messages',
    '/api/v0/chat/fetch_messages'
  ];

  function pathOf(url) {
    if (!url) return '';
    var s = String(url);
    var q = s.indexOf('?');
    if (q >= 0) s = s.substring(0, q);
    var h = s.indexOf('#');
    if (h >= 0) s = s.substring(0, h);
    if (s.indexOf('http') === 0) {
      var d = s.indexOf('//');
      if (d >= 0) {
        var slash = s.indexOf('/', d + 2);
        s = slash >= 0 ? s.substring(slash) : '/';
      }
    }
    // ★ 关键修复：统一补前导斜杠。
    //
    //   相对路径 "api/v0/chat/completion" 以前会原样返回（无前导斜杠），
    //   而白名单写的是 "/api/v0/chat/completion"，于是永远匹配不上。
    //
    //   这正好解释了一个一直很矛盾的现象：
    //   create_pow_challenge 被抓到（它用绝对 URL），
    //   chat/completion 完全没被抓到（它用相对路径）。
    if (s.length > 0 && s.charAt(0) !== '/') s = '/' + s;
    return s;
  }

  /**
   * 路径匹配：完全相等，或 base 之后紧跟 '/'。
   *
   * ★ 为什么必须是"带边界"的前缀匹配（C4）：
   *   纯前缀 (p.indexOf(base)===0) 会把相邻接口一起吞掉：
   *     /api/v0/chat/completion        ⊃ /api/v0/chat/completion_quota
   *     /api/v0/chat/history_messages  ⊃ /api/v0/chat/history_messages_meta
   *   后果不只是分类错 —— 这些接口的返回体若恰好含
   *   {message_id, status:"CONTENT_FILTER", fragments:[]} 形状，
   *   就会被 restoreHistory 递归改写成 FINISHED + 塞入 TIP，
   *   **普通业务数据被无声破坏**。这比"不拦截"严重得多。
   *
   *   同时保留 B10 的意图：允许加子路径（/completion/extra 仍命中），
   *   这样路径演进时不会退回"静默失效"。
   */
  function pathHits(p, base) {
    if (!p || !base) return false;
    if (p === base) return true;
    if (p.length <= base.length) return false;
    if (p.substring(0, base.length) !== base) return false;
    return p.charAt(base.length) === '/';
  }

  function classify(url) {
    var p = pathOf(url);
    var i;
    for (i = 0; i < URL_GENERATE.length; i++) {
      if (pathHits(p, URL_GENERATE[i])) return 'generate';
    }
    for (i = 0; i < URL_HISTORY.length; i++) {
      if (pathHits(p, URL_HISTORY[i])) return 'history';
    }
    return null;
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  /**
   * 按响应体特征判断这是不是我们关心的接口（XHR 与 fetch 共用）。
   * 宁可漏判也不误判：只认结构明确的特征，避免把普通业务数据改坏。
   *
   * @param {string} text     响应文本
   * @param {boolean} complete 是否已完整（XHR 用 readyState===4；fetch 用 clone 读完）
   */
  function sniffByText(text, complete) {
    try {
      if (typeof text !== 'string' || text.length === 0) return null;

      // ① 流式对话：SSE 的 data: 事件里出现 response / fragments
      if (text.indexOf('data:') === 0 || text.indexOf('\ndata:') >= 0) {
        if (text.indexOf('"fragments"') >= 0 ||
            text.indexOf('"response"') >= 0 ||
            text.indexOf('"message_id"') >= 0) {
          return 'generate';
        }
      }

      // ② 历史 JSON：完整 JSON 且含 chat_messages
      if (complete) {
        var t = text.replace(/^\s+/, '');
        if (t.charAt(0) === '{' &&
            (t.indexOf('chat_messages') >= 0 || t.indexOf('"message_id"') >= 0)) {
          try { JSON.parse(t); return 'history'; } catch (e) { return null; }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 增量处理 generate 流：只解析"上次偏移之后"的完整行，避免 O(n²)。
   *
   * 返回可能被改写的文本。为了不破坏流语义，替换是"就地等长替换"：
   * 找到需要替换的行，用相同的起止偏移把新内容写回去。
   */
  function processStream(req, text) {
    if (!enabled) return text;
    if (!req.__dsState) {
      req.__dsState = new DSState(req.__dsSessId || '');
      req.__dsOffset = 0;
      req.__dsRewrites = [];
    }
    // ★ B3 的核心：判断"还有没有需要扫描的内容"。
    // 关键点：readyState=3 时，末尾没有 '\n' 收尾的行会被跳过（正常，还没收完）；
    // 但 readyState=4 之后必须把那一段尾部 flush 一次，否则"撤回恰在最后一行且
    // 无换行"就会整段漏检 —— 真实 SSE 几乎总是这样收尾。
    var atEnd = (req.readyState === 4);
    var needFlushTail = atEnd && !req.__dsFlushedTail;

    if (text.length <= req.__dsOffset && !needFlushTail) {
      // 没有新内容：仍要把累积改写重放到原始文本上，
      // 否则 getter 每次重读原始全文时，先前被替换掉的行会重新"复活"成为占位模板。
      return applyRewrites(req, text);
    }

    var start = req.__dsOffset;
    var chunk = text.substring(start);
    var lastNl = chunk.lastIndexOf('\n');

    // ★ 第二重保险：把这次观测到的正文喂给看门狗。
    // 不依赖任何撤回信号，只看"内容是否还在增长、是否正常收尾"。
    noteWatchText(req, text);

    // ★ 关键修正（B3）：真实 SSE 往往把最后一行（常常正是撤回事件）作为
    // 流的收尾，末尾没有 '\n'。若此时还要求"必须有完整行"就会整条漏检。
    // 因此当请求已结束（readyState === 4）时，把剩余片段当作完整行处理。
    if (lastNl < 0) {
      if (!atEnd) return applyRewrites(req, text);   // 真的还没结束，等下一批
      lastNl = chunk.length - 1;                      // 结束态：整段视为一行
    } else if (atEnd && lastNl < chunk.length - 1) {
      // 结束态下还有一段不以 '\n' 收尾的尾巴，也要一起处理
      lastNl = chunk.length - 1;
    }

    // 逐行扫描，记录行在 text 中的绝对偏移
    var lineStart = start;
    var scanEnd = start + lastNl + 1;
    var replaced = false;

    while (lineStart < scanEnd) {
      var nl = text.indexOf('\n', lineStart);
      if (nl < 0 || nl >= scanEnd) {
        // ★ B3 的另一半：收尾行没有换行符，用 scanEnd 当作它的边界。
        if (nl < 0 && atEnd) {
          nl = scanEnd;
        } else {
          break;
        }
      }
      var line = text.substring(lineStart, nl);

      if (line.length > 0 && line.indexOf('data:') === 0) {
        var payload = line.substring(5);
        if (payload.charAt(0) === ' ') payload = payload.substring(1);

        // ★ 原始事件探针：把真实 SSE 事件记下来。
        // 之前只能靠"猜"线上格式，反复试错；有了这段，
        // App 自己能导出真格式，排查就从猜变成看。
        probeEvent(payload);
        if (payload.length > 0 && payload !== '[DONE]') {
          var data = null;
          try { data = JSON.parse(payload); } catch (e) { data = null; }
          if (data) {
            var replacement = req.__dsState.handle(data);
            if (replacement) {
              req.__dsRewrites.push({
                s: lineStart,
                e: nl,
                t: 'data: ' + replacement
              });
              replaced = true;
            }
          }
        }
      }
      lineStart = nl + 1;
    }

    req.__dsOffset = scanEnd;
    if (atEnd) req.__dsFlushedTail = true;   // 结束态的尾部只处理一次

    // ★ 判断本次请求是否"正常收尾"：状态机走到 FINISHED/STOPPED，
    // 或流已结束且没有出现撤回信号 → 取消看门狗，不做完整性判定。
    var st = req.__dsState;
    var stStatus = st && st.fields && st.fields.response
        ? st.fields.response.status : null;
    if (stStatus === 'FINISHED' || stStatus === 'STOPPED' || stStatus === 'INCOMPLETE') {
      settleWatch(req, 'status=' + stStatus);
    } else if (atEnd) {
      // 流正常结束了：给个短暂缓冲再收尾，避免"刚结束就判撤回"
      settleWatch(req, 'stream-end');
    }

    // 无论本轮是否新增改写，都对"原始全文"重放全部累积改写并返回。
    // 关键原因：WebView 的 responseText 每次 getter 都是原始未改动的全文，
    // 若只在本轮有新增时才改写，先前被替换的行会在后续读取中"复活"。
    if (req.__dsRewrites.length === 0) return text;
    return applyRewrites(req, text);
  }

  /** 把累积的改写按偏移从后往前应用到原始文本上 */
  function applyRewrites(req, text) {
    var rw = req.__dsRewrites;
    if (!rw || rw.length === 0) return text;
    var out = text;
    for (var r = rw.length - 1; r >= 0; r--) {
      var w = rw[r];
      // 偏移必须落在有效范围内，且原位置确实是待替换的那一行
      if (w.s < 0 || w.e > out.length || w.s >= w.e) continue;
      out = out.substring(0, w.s) + w.t + out.substring(w.e);
    }
    return out;
  }

  /* =====================================================================
   * 6. 历史消息还原
   * ===================================================================== */

  /** 从 fragments 里挑出仍有实际正文的片段（排除占位与提示） */
  function extractReadable(fragments) {
    if (!isArray(fragments)) return [];
    var out = [];
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (!f) continue;
      if (f.type === TEMPLATE_RESPONSE || f.type === 'TIP') continue;
      if (typeof f.content === 'string' && f.content.length > 0) {
        out.push(f);
      }
    }
    return out;
  }

  function restoreHistory(json) {
    if (!enabled) return json;
    var parsed;
    try { parsed = JSON.parse(json); } catch (e) { return json; }

    var changed = false;

    function walk(node, sessGuess) {
      if (!node || typeof node !== 'object') return;

      if (isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], sessGuess);
        return;
      }

      var sess = sessGuess;
      if (node.chat_session && node.chat_session.id) sess = String(node.chat_session.id);
      // ★ B9：分页接口可能把会话 id 挂在每条 message 上，而不是 chat_session.id。
      // 缺这条会导致 loadArchive('', msgId) 必然 miss —— 明明有存档却显示"未找到"。
      if (node.chat_session_id !== undefined && node.chat_session_id !== null) {
        sess = String(node.chat_session_id);
      }
      if (node.session_id !== undefined && node.session_id !== null) {
        sess = String(node.session_id);
      }

      if (node.status === CONTENT_FILTER
          && node.message_id !== undefined
          && node.message_id !== null) {
        var sid = sess || '';
        var rec = loadArchive(sid, node.message_id);

        // ★ 关键：若正式存档没有，再查一次**实时暂存**。
        //   这就是"事后撤回"的还原路径：
        //   消息在生成阶段被暂存下来，之后 history 才把它标成 CONTENT_FILTER，
        //   此时暂存可能还没定稿（或定稿失败），必须也能拿来还原。
        if (!rec || !rec.fragments || rec.fragments.length === 0) {
          var live = readLive(sid, node.message_id);
          if (live) {
            var lf = extractReadable(live.fragments);
            if (!lf || lf.length === 0) {
              lf = extractReadable(extractFragmentsFromStream(live.text || ''));
            }
            if (lf && lf.length > 0) {
              rec = { fragments: lf, reason: 'LIVE_RESTORE' };
              log('restore-live', 'msgId=' + node.message_id + ' 用暂存还原');
            }
          }
        }

        if (rec && rec.fragments && rec.fragments.length > 0) {
          node.fragments = cloneFragments(rec.fragments);
          node.fragments.push({
            id: rec.fragments.length + 2,
            type: 'TIP',
            style: 'WARNING',
            content: tipRecall()
          });
          node.status = 'FINISHED';
          changed = true;
          log('restore', 'msgId=' + node.message_id);
        } else {
          // ★ B8：无存档时不能无脑覆盖 —— 服务器可能仍在返回可读 fragments，
          // 那是用户还能看到的内容，顶掉就是丢内容。
          var readable = extractReadable(node.fragments);
          if (readable.length > 0) {
            node.fragments = readable;
            node.fragments.push({
              id: readable.length + 2,
              type: 'TIP',
              style: 'WARNING',
              content: tipNotFound()
            });
            log('restore-keep', 'msgId=' + node.message_id + ' 保留服务器正文');
          } else {
            node.fragments = [{
              id: 2, type: 'TIP', style: 'WARNING', content: tipNotFound()
            }];
            log('restore-miss', 'msgId=' + node.message_id);
          }
          node.status = 'FINISHED';
          changed = true;
        }
        return;
      }

      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        if (k === 'fragments') continue;
        walk(node[k], sess);
      }
    }

    walk(parsed, '');

    if (!changed) return json;
    try {
      return JSON.stringify(parsed);
    } catch (e) {
      return json;
    }
  }

  /* =====================================================================
   * 7. XHR 钩子
   * ===================================================================== */
  /* =====================================================================
   * 7. XHR 钩子（多层次安装，绝不静默失败）
   * =====================================================================
   * 为什么要多层次：
   *   线上失效过。核心教训是——早先版本如果 getOwnPropertyDescriptor 拿不到
   *   getter 就直接 return，于是防撤回彻底失效，而页面看起来完全正常，
   *   用户只会觉得"功能没了"。这类静默失败必须被消灭。
   *
   * 安装策略：
   *   第 1 层：在当前原型上找 response/responseText 的 accessor（标准情况）
   *   第 2 层：沿原型链向上找（某些内核把 accessor 定义在父对象上）
   *   第 3 层：原型上完全没有 accessor 时，改为在 open() 之后给**每个实例**
   *            定义 own property 遮蔽（实例自有属性优先于原型）
   *   任何一层失败都会写进 __DS_STATS__ 并上报宿主，界面可见。
   */
  var stats = {
    hook: 'none',        // none | proto | chain | instance | failed
    hookErrors: 0,
    xhrSeen: 0,
    generateHits: 0,
    historyHits: 0,
    recalls: 0,
    lastUrls: [],
    layers: []
  };
  window.__DS_STATS__ = stats;

  /**
   * 记录见过的请求 URL。
   *
   * ★ 之前的 bug：只在 classify 命中白名单时才记录，
   *   于是"全部不命中"时最近命中路径是空的 —— 诊断在最需要它时失效。
   *   现在所有经过 open 的请求都记，这样才能看出真实接口叫什么。
   */
  function noteUrl(u) {
    if (!u) return;
    var s = String(u);
    // 只保留路径部分，去掉域名与查询串，便于阅读
    try { s = pathOf(s) || s; } catch (e) { }
    var list = stats.lastUrls;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === s) return;
    }
    list.push(s);
    if (list.length > 24) list.shift();
  }

  /**
   * 请求级探针：记录每个请求的方法、路径、最终响应长度与内容特征。
   *
   * 为什么必须要有它：
   *   线上出现"见到 6 个请求、生成命中 0 次"，但只记录了 settings/webid 两条。
   *   这说明对话请求要么走了别的通道，要么路径不在白名单 —— 但仅凭 URL 列表
   *   分不清是哪一种。加上响应长度与内容特征后，就能直接看出
   *   "哪个请求其实是对话流（只是路径没匹配上）"。
   */
  var reqLog = [];
  var REQ_LOG_MAX = 30;

  function noteRequest(req, url, phase, text) {
    try {
      if (reqLog.length >= REQ_LOG_MAX) return;
      var entry = {
        url: pathOf(url) || String(url || ''),
        method: req.__dsMethod || '?',
        type: req.__dsReqType || null,
        phase: phase,
        len: typeof text === 'string' ? text.length : -1,
        ctype: req.__dsCType || '',
        looksLikeSSE: typeof text === 'string'
            && (text.indexOf('data:') >= 0) && (text.indexOf('fragments') >= 0),
        looksLikeHistory: typeof text === 'string'
            && (text.indexOf('chat_messages') >= 0)
      };
      reqLog.push(entry);
    } catch (e) { }
  }

  /** 沿原型链查找某个 accessor 描述符 */
  function findAccessor(obj, name) {
    var cur = obj;
    var depth = 0;
    while (cur && depth < 8) {
      var d = Object.getOwnPropertyDescriptor(cur, name);
      if (d && typeof d.get === 'function') {
        return { desc: d, owner: cur, depth: depth };
      }
      cur = Object.getPrototypeOf ? Object.getPrototypeOf(cur) : cur.__proto__;
      depth++;
    }
    return null;
  }

  function installXhrHook() {
    var X = window.XMLHttpRequest;
    if (!X || !X.prototype) {
      stats.hook = 'failed';
      stats.layers.push('XMLHttpRequest 不存在');
      log('error', 'XMLHttpRequest 不存在，无法安装 hook');
      return;
    }
    var proto = X.prototype;

    var textAcc = findAccessor(proto, 'responseText');
    var respAcc = findAccessor(proto, 'response');

    if (!textAcc || !respAcc) {
      // ---- 第 3 层：实例级遮蔽 ----
      stats.hook = 'instance';
      stats.layers.push('原型无 accessor，改用实例级遮蔽');
      log('warn', '原型上找不到 responseText/response 的 accessor，改用实例级遮蔽');
      installInstanceLevelHook(proto);
      return;
    }

    var layer = (textAcc.depth === 0 && respAcc.depth === 0) ? 'proto' : 'chain';
    stats.hook = layer;
    stats.layers.push('accessor 位于 depth ' + textAcc.depth + '/' + respAcc.depth);

    var descText = textAcc.desc;
    var descResp = respAcc.desc;
    var origOpen = proto.open;
    var origSend = proto.send;
    var origSetHeader = proto.setRequestHeader;

    function rawText(xhr) {
      // ★ B7：若前端把 responseType 设成 'json' 等非 text 模式，
      // 真实浏览器读 responseText 会抛 InvalidStateError。
      // 此时必须改走 response getter 再序列化，否则历史还原会完全不生效。
      var rt = '';
      try { rt = xhr.responseType || ''; } catch (e) { }
      if (rt && rt !== 'text') {
        try {
          var v = descResp.get.call(xhr);
          if (typeof v === 'string') return v;
          if (v && typeof v === 'object') {
            try { return JSON.stringify(v); } catch (e2) { return ''; }
          }
          return '';
        } catch (e3) {
          return '';
        }
      }
      try { return descText.get.call(xhr); } catch (e) { return ''; }
    }
    function rawResp(xhr) {
      try { return descResp.get.call(xhr); } catch (e) { return ''; }
    }

    proto.getOriginalResponse = function () { return rawResp(this); };
    proto.getOriginalResponseText = function () { return rawText(this); };

    function compute(xhr) {
      if (xhr.readyState < 2) return null;

      var text = rawText(xhr);
      if (typeof text !== 'string' || text.length === 0) return null;

      var rt = xhr.__dsReqType;

      // ★ 兜底：URL 白名单没有命中时，用**响应内容特征**自识别。
      //
      //   为什么需要它：线上实测"见到 6 个请求、生成命中 0 次、最近路径为空"，
      //   说明接口路径可能变了（或不在我的白名单里）。只靠写死路径，
      //   一旦变名就整套静默失效 —— 这是这个功能最怕的失败模式。
      //
      //   内容特征比路径稳得多：对话流的 data: 事件里有 response/fragments/
      //   message_id 这些结构，普通接口不会长这样。
      if (!rt) {
        rt = sniffByText(text, xhr.readyState === 4);
        if (rt) {
          xhr.__dsReqType = rt;   // 记住，后续帧直接用
          noteUrl(xhr.__dsUrl || '');
          log('sniff', '按内容识别为 ' + rt + '  url=' + (xhr.__dsUrl || ''));
        } else {
          // 未识别：也记录一次响应特征，便于判断"是不是漏判了"
          if (!xhr.__dsNoted) {
            xhr.__dsNoted = true;
            noteRequest(xhr, xhr.__dsUrl, 'response', text);
          }
        }
      }

      if (!rt) return null;

      if (rt === 'generate') {
        stats.generateHits++;
        reportHealth();   // 命中是关键时刻，立刻上报
        return processStream(xhr, text);
      }
      if (rt === 'history') {
        if (xhr.readyState !== 4) return null;
        stats.historyHits++;
        reportHealth();
        return restoreHistory(text);
      }
      return null;
    }

    Object.defineProperty(proto, 'responseText', {
      configurable: true,
      enumerable: descText.enumerable,
      get: function () {
        try {
          var m = compute(this);
          if (m !== null && m !== undefined) return m;
        } catch (e) {
          stats.hookErrors++;
          log('error', 'responseText hook: ' + e);
        }
        return rawText(this);
      },
      set: function (v) {
        try { if (descText.set) descText.set.call(this, v); } catch (e) { }
      }
    });

    Object.defineProperty(proto, 'response', {
      configurable: true,
      enumerable: descResp.enumerable,
      get: function () {
        try {
          if (this.__dsReqType && this.readyState >= 2) {
            var m = compute(this);
            if (m !== null && m !== undefined) {
              if (this.responseType === 'json') {
                try { return JSON.parse(m); } catch (e) { }
              }
              return m;
            }
          }
        } catch (e) {
          stats.hookErrors++;
          log('error', 'response hook: ' + e);
        }
        return rawResp(this);
      },
      set: function (v) {
        try { if (descResp.set) descResp.set.call(this, v); } catch (e) { }
      }
    });

    proto.open = function (method, url) {
      try {
        stats.xhrSeen++;
        // ★ B1：同一 XHR 实例可能被复用（重试 / resume_stream 重发 / 连接池）。
        // 若不重置增量状态，旧的 rewrite 偏移会套到新请求的文本上，
        // 把上一次的 TIP/FINISHED 改写插进新回答正文中间 —— 可见的页面污染。
        this.__dsState = null;
        this.__dsOffset = 0;
        this.__dsRewrites = [];
        this.__dsSessId = '';
        this.__dsFinished = false;
        this.__dsFlushedTail = false;
        this.__dsNoted = false;
        this.__dsReqType = classify(url);
        this.__dsUrl = String(url);
        this.__dsMethod = String(method || '');
        this.__dsCType = '';
        noteUrl(url);
        noteRequest(this, url, 'open', null);
        // 定期上报健康状态。
        // 这一条是必须的：之前只在启动时上报一次，之后 40 个请求都发生了，
        // 诊断页读到的仍是「启动那一刻」的旧快照（8 个请求、0 命中），
        // 于是用户看到的永远是过期数据，把「其实命中了」误判成「从未命中」。
        if (stats.xhrSeen % 5 === 0) reportHealth();
      } catch (e) { }
      return origOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function (header, value) {
      try {
        var h = String(header).toLowerCase();
        if (this.__dsReqType && h === 'x-client-locale') {
          locale = String(value);
        }
        if (h === 'accept' || h === 'content-type') {
          this.__dsCType = String(value);
        }
      } catch (e) { }
      return origSetHeader.apply(this, arguments);
    };

    proto.send = function (body) {
      applySendBody(this, body);
      return origSend.apply(this, arguments);
    };

    log('install', 'XHR hooks installed (' + layer + ')');
  }

  /** 从 send 的 body / URL 里提取 chat_session_id */
  function applySendBody(xhr, body) {
    try {
      if (xhr.__dsReqType !== 'generate') return;
      var sid = null;
      if (typeof body === 'string' && body.length > 1) {
        try {
          var j = JSON.parse(body);
          sid = j.chat_session_id;
          if (sid === undefined || sid === null) sid = j.session_id;
        } catch (e0) { }
      }
      if (sid === undefined || sid === null || sid === '') {
        var m = /(?:chat_session_id|session_id)=([^&]+)/.exec(xhr.__dsUrl || '');
        if (m) {
          try { sid = decodeURIComponent(m[1]); } catch (e1) { sid = m[1]; }
        }
      }
      xhr.__dsSessId = (sid === undefined || sid === null) ? '' : String(sid);
    } catch (e) { }
  }


  /**
   * 第 3 层：原型上没有 accessor 时，改为在每个实例上定义 own property。
   *
   * 原理：实例自有属性优先于原型。我们在 open() 之前无法拿到实例，
   * 所以在 open 之后立刻给 this 定义属性；此时拿不到原始 getter，
   * 只能在 progress 事件里借助 event.target 的**已缓存文本**。
   * 因此这条路能力有限（只能读到页面自己赋过的值），
   * 但至少不会静默：会把统计与告警暴露到界面。
   */
  function installInstanceLevelHook(proto) {
    var origOpen = proto.open;
    var origSend = proto.send;

    proto.open = function (method, url) {
      try {
        stats.xhrSeen++;
        this.__dsReqType = classify(url);
        this.__dsUrl = String(url);
        noteUrl(url);   // 所有请求都记，白名单失效时也能看出真实接口
      } catch (e) { }

      var self = this;
      try {
        // 用一个自有数据属性接管读取入口
        var currentText = '';
        Object.defineProperty(self, '__dsRawText', {
          configurable: true, writable: true, value: ''
        });
        Object.defineProperty(self, 'responseText', {
          configurable: true,
          enumerable: true,
          get: function () {
            var base = self.__dsRawText || '';
            if (!self.__dsReqType || self.readyState < 2) return base;
            try {
              if (self.__dsReqType === 'generate') return processStream(self, base);
              if (self.__dsReqType === 'history' && self.readyState === 4) {
                return restoreHistory(base);
              }
            } catch (e) {
              stats.hookErrors++;
            }
            return base;
          },
          set: function (v) { self.__dsRawText = v; }
        });
        Object.defineProperty(self, 'response', {
          configurable: true,
          enumerable: true,
          get: function () {
            if (self.readyState < 2) return '';
            return self.responseText;
          },
          set: function (v) { self.__dsRawText = v; }
        });
        // 尽力而为：在 progress 时把原生文本抄进 __dsRawText
        if (typeof self.addEventListener === 'function') {
          self.addEventListener('progress', function (ev) {
            try {
              if (self.__dsRawText) return;   // 已有就不重复抄
              // 触发原生 accessor（若仍然存在）
              var acc = findAccessor(proto, 'responseText');
              if (acc) self.__dsRawText = acc.desc.get.call(self);
            } catch (e) { }
          });
        }
      } catch (e) {
        stats.hookErrors++;
        log('error', '实例级 hook 安装失败: ' + e);
      }

      return origOpen.apply(this, arguments);
    };

    proto.send = function (body) {
      applySendBody(this, body);
      return origSend.apply(this, arguments);
    };

    log('install', 'XHR hooks installed (instance-level fallback)');
  }

  /* =====================================================================
   * 8. fetch 兜底钩子（只处理历史 JSON，绝不动流式 body）
   * ===================================================================== */
  function installFetchHook() {
    if (!window.fetch || typeof window.fetch !== 'function') return;
    if (!window.Response) return;   // 旧内核无 Response，跳过

    var origFetch = window.fetch;

    window.fetch = function (input, init) {
      var url = '';
      var args = arguments;
      var self = this;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (e) { }

      var reqType = classify(url);
      noteUrl(url);   // 所有请求都记，便于看出真实接口

      var p;
      try {
        p = origFetch.apply(self, args);
      } catch (e) {
        throw e;   // 同步抛错原样抛出，不改变行为
      }

      // ★ 不再因为「路径不认识」就跳过。
      //   线上出现「见到 6 个请求、命中 0 次」，很可能是对话走了 fetch
      //   且路径不在白名单。这里对**所有** fetch 都做响应侧检查，
      //   认不认得出交给内容特征决定。
      return p.then(function (res) {
        try {
          if (!enabled) return res;
          return handleFetchResponse(res, url, reqType);
        } catch (e) {
          return res;   // 任何异常都回退原响应，绝不破坏页面
        }
      }, function (e) {
        throw e;
      });
    };

    log('install', 'fetch hook installed');
  }

  /**
   * 处理 fetch 响应。
   *
   *   A) 非流式 JSON（历史/普通接口）→ clone().text() 后可安全改写
   *   B) 流式 SSE（对话）→ 用 ReadableStream 逐块转发，边转发边累积
   *      （既让页面实时出字，又能拿到完整内容用于防撤回）
   *   C) 其它 → 原样返回
   */
  function handleFetchResponse(res, url, reqType) {
    if (!res) return res;

    var ctype = '';
    try {
      ctype = res.headers && res.headers.get
          ? (res.headers.get('content-type') || '') : '';
    } catch (e) { }

    // ---- B) 流式 ----
    var isStream = res.body && typeof res.body.getReader === 'function'
        && (ctype.indexOf('event-stream') >= 0 || reqType === 'generate');
    if (isStream) return wrapStreamResponse(res, url);

    // ---- A) 非流式：只对可能相关的做文本检查 ----
    var interesting = (reqType === 'history')
        || (res.ok && ctype.indexOf('json') >= 0);
    if (!interesting) return res;

    try {
      return res.clone().text().then(function (t) {
        try {
          if (!reqType) {
            var sniffed = sniffByText(t, true);
            if (!sniffed) return res;
            reqType = sniffed;
            log('sniff-fetch', '按内容识别为 ' + sniffed + ' url=' + url);
          }
          if (reqType === 'history') {
            var fixed = restoreHistory(t);
            if (fixed !== t) {
              return new window.Response(fixed, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers
              });
            }
          }
        } catch (e) { }
        return res;
      })['catch'](function () { return res; });
    } catch (e) {
      return res;
    }
  }

  /**
   * 流式响应包装。
   *
   * 用 ReadableStream 把原始流「转述」给页面，同时累积收到的字节。
   * 为什么必须这样做：对话流一旦被 clone().text() 读完，页面就再也拿不到
   * 实时输出（会退化成等全部结束才一次显示）。必须逐块转发。
   *
   * 局限：只有流结束才拿到完整内容，所以「改写流内容」做不到逐块生效
   * （重编码代价与风险都高）。但**保存**完全可行 —— 这正是「先都存下来」需要的。
   */
  function wrapStreamResponse(res, url) {
    try {
      if (!window.ReadableStream) return res;
      var reader = res.body.getReader();
      var acc = '';

      var wrapped = new window.ReadableStream({
        start: function (controller) {
          function pump() {
            reader.read().then(function (r) {
              if (r.done) {
                try {
                  if (enabled && acc.length > 0) onFetchStreamDone(url, acc);
                } catch (e) { }
                controller.close();
                return;
              }
              var chunk = r.value;
              try {
                if (chunk && chunk.length) {
                  if (typeof chunk === 'string') acc += chunk;
                  else acc += decodeUtf8(chunk);
                }
              } catch (e) { }
              controller.enqueue(chunk);
              pump();
            })['catch'](function (e) {
              try { controller.error(e); } catch (x) { }
            });
          }
          pump();
        },
        cancel: function (reason) {
          try { reader.cancel(reason); } catch (e) { }
        }
      });

      return new window.Response(wrapped, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    } catch (e) {
      log('error', 'wrapStreamResponse: ' + e);
      return res;
    }
  }

  /** 极简 UTF-8 解码（旧内核可能没有 TextDecoder） */
  function decodeUtf8(bytes) {
    try {
      if (window.TextDecoder) return new window.TextDecoder('utf-8').decode(bytes);
    } catch (e) { }
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  /** fetch 流结束后：走与 XHR 相同的暂存/定稿路径 */
  function onFetchStreamDone(url, text) {
    try {
      if (!text || text.length < 64) return;

      var state = new DSState('');
      var lines = String(text).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line || line.indexOf('data:') !== 0) continue;
        var payload = line.substring(5);
        if (payload.charAt(0) === ' ') payload = payload.substring(1);
        if (!payload || payload === '[DONE]') continue;
        var d = null;
        try { d = JSON.parse(payload); } catch (e) { continue; }
        state.handle(d);
      }

      var fr = state.fields && state.fields.response ? state.fields.response.fragments : null;
      var frags = extractReadable(fr);
      if (!frags || frags.length === 0) {
        frags = extractReadable(extractFragmentsFromStream(text));
      }
      if (!frags || frags.length === 0) return;

      var sessId = state.sessId || '';
      var msgId = state.lastMsgId;
      if (msgId === undefined || msgId === null) {
        msgId = 'fetch-' + (sessId || 'nosess') + '-' + frags.length;
      }

      writeLive(sessId, msgId, text, frags, { settled: false });
      var reason = state.recalled
          ? (state.recallReason || 'TEMPLATE_RESPONSE') : 'FETCH_SETTLED';
      if (commitLive(sessId, msgId, reason)) {
        stats.recalls++;
        log('fetch-commit', 'msgId=' + msgId + ' reason=' + reason
            + ' frags=' + frags.length + ' url=' + url);
        bridge('onRecall', JSON.stringify({
          sessId: sessId,
          msgId: msgId,
          reason: reason,
          preview: makePreview(frags)
        }));
        bridge('onArchiveChanged', countArchive());
      }
    } catch (e) {
      log('error', 'onFetchStreamDone: ' + e);
    }
  }

  /* =====================================================================
   * 9. 控制面
   * ===================================================================== */
  function countArchive() {
    return loadIndex().length;
  }

  function exportArchive() {
    var idx = loadIndex();
    var items = [];
    for (var i = 0; i < idx.length; i++) {
      var it = idx[i];
      var rec = loadArchive(it.sessId, it.msgId);
      items.push({
        sessId: it.sessId,
        msgId: it.msgId,
        ts: it.ts,
        reason: it.reason,
        title: it.title || '',
        preview: it.preview || '',
        text: rec ? fragmentsToText(rec.fragments) : ''
      });
    }
    try {
      return JSON.stringify({ version: VERSION, count: items.length, items: items });
    } catch (e) {
      return '{"items":[]}';
    }
  }

  function removeArchive(sessId, msgId) {
    sdel(archiveKey(sessId, msgId));
    var idx = loadIndex();
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].sessId === sessId && String(idx[i].msgId) === String(msgId)) {
        idx.splice(i, 1);
        break;
      }
    }
    saveIndex();
    bridge('onArchiveChanged', idx.length);
    return true;
  }

  function clearArchive() {
    var idx = loadIndex();
    for (var i = 0; i < idx.length; i++) {
      sdel(archiveKey(idx[i].sessId, idx[i].msgId));
    }
    idx.length = 0;
    sdel(KEY_INDEX);
    memIndex = [];
    bridge('onArchiveChanged', 0);
    return true;
  }

  function getStats() {
    return JSON.stringify({
      version: VERSION,
      enabled: enabled,
      debug: debugOn,
      total: countArchive(),
      locale: locale,
      logs: logRing.length,
      // 诊断字段：用于判断"钩子到底装上了没有"
      hook: stats.hook,
      hookErrors: stats.hookErrors,
      xhrSeen: stats.xhrSeen,
      generateHits: stats.generateHits,
      historyHits: stats.historyHits,
      recalls: stats.recalls,
      layers: stats.layers,
      lastUrls: stats.lastUrls,
      requests: reqLog,
      net: netLog
    });
  }

  /* ---------------------------------------------------------------------
   * 网络总账：把所有网络出口的请求都记下来
   * ---------------------------------------------------------------------
   * 为什么要单独做一层：线上出现「见到16个请求、生成命中0次」，
   * 而 create_pow_challenge 出现了、chat/completion 没出现。
   * 这说明「有请求在走我没挂到的通道」。只挂 XHR 会盲区。
   * 这里同时挂 fetch 和 XMLHttpRequest，并把每次调用都记成一行，
   * 便于直接看出「谁发的/走哪条通道」。
   */
  var NET_MAX = 40;
  var netLog = [];

  function netNote(channel, method, url, extra) {
    try {
      if (netLog.length >= NET_MAX) return;
      var e = {
        c: channel,
        m: String(method || ''),
        u: pathOf(url) || String(url || '')
      };
      if (extra) for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      }
      netLog.push(e);
      capNote({ c: channel, m: String(method || ''), u: pathOf(url) || String(url || ''), len: -1 });
    } catch (x) { }
  }

  /** 挂 XMLHttpRequest 与 fetch，只做记录，绝不改变行为 */
  function installNetWatch() {
    try {
      var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (proto && !proto.__dsNetHooked) {
        proto.__dsNetHooked = true;
        var oOpen = proto.open;
        proto.open = function (m, u) {
          try { netNote('xhr', m, u); } catch (e) { }
          return oOpen.apply(this, arguments);
        };
      }
    } catch (e) { }

    try {
      if (window.fetch && !window.fetch.__dsNetHooked) {
        var oFetch = window.fetch;
        var wrapped = function (input, init) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url) || '';
            var m = (init && init.method) || 'GET';
            netNote('fetch', m, u);
          } catch (e) { }
          return oFetch.apply(this, arguments);
        };
        wrapped.__dsNetHooked = true;
        window.fetch = wrapped;
      }
    } catch (e) { }

    // 额外：Worker 里发出的请求抓不到，但可以记录 Worker 的创建，
    // 用于判断「是不是有个 Worker 在跑网络」
    try {
      if (window.Worker && !window.Worker.__dsNetHooked) {
        var OW = window.Worker;
        var NW = function (scriptURL) {
          try { netNote('worker', '-', scriptURL); } catch (e) { }
          return new OW(scriptURL);
        };
        NW.prototype = OW.prototype;
        NW.__dsNetHooked = true;
        window.Worker = NW;
      }
    } catch (e) { }
  }

  installNetWatch();

  /* ---------------------------------------------------------------------
   * 主动捕获窗口
   * ---------------------------------------------------------------------
   * 用途：点「开始捕获」后 120 秒内，把每条请求的方法/路径/响应长度/内容特征
   * 都记下来，导出发给开发者。比事后看「最近路径」精确得多 ——
   * 能直接看出「发消息那一下到底走的是哪条通道、请求叫什么、返回多长」。
   */
  var capOn = false;
  var capUntil = 0;
  var capLog = [];

  function capStart(secs) {
    capOn = true;
    capLog = [];
    capUntil = Date.now() + (secs || 120) * 1000;
    log('cap', 'start for ' + (secs || 120) + 's');
    return true;
  }

  function capActive() {
    if (!capOn) return false;
    if (Date.now() > capUntil) { capOn = false; return false; }
    return true;
  }

  function capNote(entry) {
    try {
      if (!capActive()) return;
      if (capLog.length >= 60) return;
      capLog.push(entry);
    } catch (e) { }
  }

  function exportCap() {
    return JSON.stringify({
      active: capOn,
      remaining: Math.max(0, Math.round((capUntil - Date.now()) / 1000)),
      count: capLog.length,
      items: capLog,
      net: netLog
    });
  }

  /* ---------------------------------------------------------------------
   * 片段结构快照（诊断用）
   * ---------------------------------------------------------------------
   * 目的：直接看「最终保存下来的片段到底是什么」。
   * 线上出现「只有思考过程、正文只剩一个括号」，需要确认：
   *   有几种片段类型？各自的长度是多少？正文增量到底进了哪个片段？
   * 只靠事件形态推断不够，必须看状态机的最终产物。
   */
  var lastFragSnap = null;

  function snapFragments(state, tag) {
    try {
      var fr = state && state.fields && state.fields.response
          ? state.fields.response.fragments : null;
      if (!isArray(fr)) { lastFragSnap = null; return; }
      var out = [];
      for (var i = 0; i < fr.length; i++) {
        var f = fr[i];
        if (!f) continue;
        out.push({
          id: f.id,
          type: f.type,
          len: typeof f.content === 'string' ? f.content.length : -1,
          head: typeof f.content === 'string' ? f.content.substring(0, 60) : ''
        });
      }
      lastFragSnap = { tag: tag, at: Date.now(), count: out.length, frags: out };
    } catch (e) { }
  }

  function getFragSnap() {
    return JSON.stringify(lastFragSnap || { count: 0, frags: [] });
  }

  window.__DS_SHELL__ = {
    version: VERSION,
    setEnabled: function (v) { enabled = !!v; log('cfg', 'enabled=' + enabled); return enabled; },
    isEnabled: function () { return enabled; },
    setDebug: function (v) { debugOn = !!v; return debugOn; },
    count: function () { return countArchive(); },
    exportArchive: exportArchive,
    removeArchive: removeArchive,
    clearArchive: clearArchive,
    getStats: getStats,
    // 诊断：导出真实收到的 SSE 事件形态（排查"存档不全"的关键）
    exportProbe: exportProbe,
    fragSnapshot: getFragSnap,
    exportRequests: function(){ return JSON.stringify(reqLog); },
    exportNet: function(){ return JSON.stringify(netLog); },
    capStart: capStart,
    capExport: exportCap,   // 捕获窗口
    clearProbe: clearProbe,
    listLive: listLive,
    logs: function () { return logRing.slice(); },
    _internals: {
      DSState: DSState,
      restoreHistory: restoreHistory,
      processStream: processStream,
      classify: classify,
      pathOf: pathOf
    }
  };
  window.__DS_LOG__ = logRing;

  /* 健康状态上报：让宿主能区分"钩子没装上"与"装上了但没命中" */
  function reportHealth() {
    try { bridge("onHealth", getStats()); } catch (e) { }
  }
  window.__DS_REPORT_HEALTH__ = reportHealth;

  /**
   * 主动把存档快照推给宿主。
   * 目的：让存档页不必依赖"主界面还活着"才能取到数据。
   * 主界面被系统回收后，存档页仍能显示上一次推送的内容。
   */
  function pushSnapshot() {
    try { bridge('onArchiveSnapshot', exportArchive()); } catch (e) { }
  }
  window.__DS_PUSH_SNAPSHOT__ = pushSnapshot;

  /* =====================================================================
   * 9.5 第二重保险：完整性看门狗（不依赖任何撤回信号）
   * =====================================================================
   * 为什么需要它：
   *   第一重保险依赖"服务端下发 TEMPLATE_RESPONSE / CONTENT_FILTER"这类信号。
   *   但只要协议细节有偏差（信号换名、嵌套层级变化、事件时序不同），
   *   就会整套漏检 —— 而且失败是完全静默的。
   *
   *   这套看门狗完全不看信号，只看两件事：
   *     ① 中途接收到的最大正文快照
   *     ② 这次请求最终是否正常收尾
   *   如果"内容停止增长超过 GRACE_MS，且该请求没有正常结束"，
   *   就判定这次回答被中途掐断/撤回，把快照存档。
   *
   * 判定要点（避免误伤）：
   *   - 用户主动停止：status 会走到 STOPPED / FINISHED，或被 abort → 不判撤回
   *   - 正常完成：收到 FINISHED 或流正常关闭 → 不判撤回
   *   - 只有"有实质内容 + 突然不再增长 + 没有正常收尾"才判定
   */
  var STALL_GRACE_MS = 10000;   // 内容停止增长后的宽限期（用户要求：10s）
  var MAX_GROW_ROUNDS = 20;     // 定稿后最多再观察多少轮（防止定时器无限自设）

  /**
   * 定时器统一封装。
   *
   * 为什么要单独包一层：
   *   定稿后还要继续观察「有没有新内容到达」，于是会有多个定时器排队。
   *   直接 setTimeout 会带来两个问题：
   *     ① 在 Node 测试里进程被挂起的定时器拖住不退出（表现为「测试通过但超时」）；
   *        用 unref() 可以避免，同时不影响浏览器。
   *     ② 页面关闭/切换会话时这些定时器仍会跑，属于资源泄漏。
   *   统一入口便于以后集中清理。
   */
  function scheduleTick(w, delay) {
    var id = setTimeout(function () {
      try { tickWatch(w); } catch (e) { }
    }, delay);
    // Node 环境（测试台）下不阻塞进程退出；浏览器没有 unref，会走 catch
    try { if (id && typeof id.unref === 'function') id.unref(); } catch (e) { }
    return id;
  }
  var SETTLE_GRACE_MS = 3000;   // 请求已正常结束时，稍短的确认期
  var watches = [];             // 进行中的看门狗

  function startWatch(req) {
    if (!enabled) return;
    if (req.__dsWatchStarted) return;
    req.__dsWatchStarted = true;

    var w = {
      req: req,
      sessId: req.__dsSessId || '',
      timer: null,
      maxText: '',
      lastLen: 0,
      settled: false,
      node: scheduleTick(w, STALL_GRACE_MS)
    };
    watches.push(w);
  }

  /** 记录一次观测到的正文（只在内容增长时更新） */
  function noteWatchText(req, text) {
    var w = findWatch(req);
    if (!w) {
      // 首次观测到内容：启动看门狗
      startWatch(req);
      w = findWatch(req);
      if (!w) return;
    }
    if (typeof text !== 'string' || text.length === 0) return;
    if (text.length <= w.lastLen) {
      // 内容没增长：但如果暂存里还没有正式写进去，也补一次
      if (!w.liveWritten && w.maxText) {
        flushLive(w);
      }
      return;
    }
    w.lastLen = text.length;
    w.maxText = text;

    // ★ 核心：内容增长就**立即写入暂存**。
    //   这样即便后续被"事后撤回"（history 里变成 CONTENT_FILTER），
    //   本地也已经有完整正文可用于还原 —— 这正是"先都存下来"策略。
    flushLive(w);

    // ★ 如果已经定稿过，而内容还在增长 → 更新那条存档。
    //   这解决"存档只有几个字"：思考阶段停顿触发定稿后，
    //   后续到达的正文不能被丢掉，要补写进去。
    growCommitted(w);

    // 内容每次增长都重新计时：停增满 GRACE_MS 才定稿
    if (w.node) { clearTimeout(w.node); }
    w.node = scheduleTick(w, STALL_GRACE_MS);
  }

  /** 把当前收到的最新内容写进暂存（含片段） */
  function flushLive(w) {
    try {
      var req = w.req;
      var st = req.__dsState;
      var sessId = w.sessId || (st && st.sessId) || '';

      // msgId 解析顺序（保证暂存 key 稳定，不会出现 auto-xxx 与真实 id 两条）：
      //   1) 状态机里 response.message_id（首帧整体 SET 就会带上）
      //   2) 之前记录过的 lastMsgId
      //   3) 最后才用合成 key
      var msgId = null;
      try {
        if (st && st.fields && st.fields.response
            && st.fields.response.message_id !== undefined
            && st.fields.response.message_id !== null) {
          msgId = st.fields.response.message_id;
        }
      } catch (e0) { }
      if (msgId === undefined || msgId === null) {
        msgId = (st && st.lastMsgId);
      }
      if (msgId === undefined || msgId === null) {
        msgId = 'auto-' + (sessId || 'nosess');
      }
      // 记住它，后续帧保持一致（避免 key 漂移）
      try { if (st) st.lastMsgId = msgId; } catch (e1) { }

      // 若之前已经用 auto- key 写过、现在拿到真实 id，把旧 key 清掉
      if (w.liveWritten && w.liveMsgId !== msgId) {
        try { dropLive(w.liveSessId, w.liveMsgId); } catch (e2) { }
      }

      // 取 fragments 的优先级：
      //   1) 状态机累积的（结构最完整，能还原思考链/代码块样式）
      //   2) 状态机里"曾见过的最长快照"（应对 response 被清空）
      //   3) 从原始流文本重放重建（兜底，最可靠）
      var frags = null;
      try {
        var f1 = st && st.fields && st.fields.response && st.fields.response.fragments;
        f1 = extractReadable(f1);
        if (f1 && f1.length > 0) frags = f1;
      } catch (e1) { }
      if (!frags || frags.length === 0) {
        try {
          var f2 = st && st.lastGoodFragments;
          f2 = extractReadable(f2);
          if (f2 && f2.length > 0) frags = f2;
        } catch (e2) { }
      }
      if (!frags || frags.length === 0) {
        try {
          var f3 = extractFragmentsFromStream(w.maxText || '');
          f3 = extractReadable(f3);
          if (f3 && f3.length > 0) frags = f3;
        } catch (e3) { }
      }

      writeLive(sessId, msgId, w.maxText || '', frags || [], { settled: false });
      w.liveWritten = true;
      w.liveSessId = sessId;
      w.liveMsgId = msgId;
    } catch (e) {
      log('error', 'flushLive: ' + e);
    }
  }

  function findWatch(req) {
    for (var i = 0; i < watches.length; i++) {
      if (watches[i].req === req) return watches[i];
    }
    return null;
  }

  function dropWatch(w) {
    if (w.node) { try { clearTimeout(w.node); } catch (e) { } w.node = null; }
    for (var i = 0; i < watches.length; i++) {
      if (watches[i] === w) { watches.splice(i, 1); break; }
    }
  }

  /**
   * 请求收尾。
   *
   * 注意：这里**不再直接取消看门狗**。
   * 因为"事后撤回"恰恰发生在请求正常结束之后 —— 消息已经生成完、
   * 内容也稳定了，服务端随后才把它标成 CONTENT_FILTER。
   * 若在收尾时就把看门狗删掉，就永远等不到那个定稿时机，
   * 暂存会一直留着（或在下次启动时被丢弃），用户看到"存档为空"。
   *
   * 所以这里只记录状态，让宽限期照常走完，到点由 tickWatch 定稿。
   */
  function settleWatch(req, how) {
    req.__dsFinished = true;
    var w = findWatch(req);
    if (!w) return;
    w.settledHow = how;
    log('watch-settle', how);
    // 正常收尾时：把宽限期缩短为"内容停增确认期"，
    // 但仍保留窗口，以便事后撤回能被定稿。
    if (w.node) { clearTimeout(w.node); }
    w.node = scheduleTick(w, SETTLE_GRACE_MS);
  }

  /**
   * 宽限期到点后的裁决 —— 这就是"实时保存 + 停增 10s 定稿"的具体实现。
   *
   *   内容已经全程实时写在暂存里（noteWatchText/flushLive）。
   *   这里只决定"要不要转成正式存档"：
   *
   *   A) 内容停增满 GRACE_MS：
   *      无论请求是否"正常结束"，都定稿。
   *      理由：事后撤回（history 变 CONTENT_FILTER）恰恰发生在
   *      "请求已正常结束、内容也稳定"之后。若只在异常结束时才存，
   *      就永远抓不到事后撤回 —— 这正是之前"存档为空"的根因。
   *
   *   B) 没有实质内容 → 丢弃暂存，不留垃圾。
   */
  function tickWatch(w) {
    try {
      if (!enabled || !w) return;
      var req = w.req;

      var text = w.maxText || '';
      // 没有实质内容：清掉暂存，不留垃圾条目
      if (text.length < 64) {
        if (w.liveWritten) dropLive(w.liveSessId, w.liveMsgId);
        dropWatch(w);
        return;
      }

      // 定稿前记录片段结构，便于诊断「正文进了哪个片段」
      snapFragments(req.__dsState, "settle");

      // 补一次暂存（确保拿到最后一次内容）
      flushLive(w);

      var sessId = w.liveSessId || w.sessId || '';
      var msgId = w.liveMsgId;
      if (msgId === undefined || msgId === null) {
        msgId = 'auto-' + (sessId || 'nosess');
      }

      var st = req.__dsState;
      var status = st && st.fields && st.fields.response
          ? st.fields.response.status : null;

      // 定稿理由（用于存档展示）
      var reason = 'LIVE_SETTLED';
      if (status === 'CONTENT_FILTER') reason = 'CONTENT_FILTER';
      else if (status === 'STOPPED') reason = 'USER_STOPPED';
      else if (status === 'INCOMPLETE') reason = 'INCOMPLETE';
      else if (req.readyState !== 4) reason = 'STALL_WATCHDOG';

      var committed = commitLive(sessId, msgId, reason);
      if (committed) {
        stats.recalls++;
        log('watch-settle', '内容停增 ' + STALL_GRACE_MS + 'ms → 定稿'
            + ' msgId=' + msgId + ' reason=' + reason);
        bridge('onRecall', JSON.stringify({
          sessId: sessId,
          msgId: msgId,
          reason: reason,
          preview: makePreview(extractReadable(
              (readLive(sessId, msgId) || {}).fragments || []))
        }));
      }

      // ★ 关键：定稿后**不要停止监视**，而是转为"增量补写"模式。
      //
      //   线上真实表现：存档正文只有 3~6 个字（"1.\n\n听到"这种），
      //   因为 DeepSeek 思考阶段常会长时间无输出，10 秒宽限期一到
      //   就把当时收到的内容定稿了，之后到达的正文全被丢掉。
      //
      //   修复思路不是延长等待（那会走向另一个错误：永远不定稿），
      //   而是"先定稿、后补写"：宽限期到点先存一份（保证有东西可救），
      //   后续内容若继续到达，自动更新同一条存档直到内容不再增长。
      //
      //   这样既不会因停顿而丢内容，也不会永远等不到存档。
      w.committed = true;
      w.committedSessId = sessId;
      w.committedMsgId = msgId;
      w.committedLen = text.length;
      w.growRounds = w.growRounds || 0;

      // ★ 必须是有限轮次。
      //   我第一版写成「无条件再挂一个定时器」，结果 tickWatch 自我重设，
      //   在真实 setTimeout 下永不停止，直接把测试和页面卡死。
      //   现实里一条回答的停顿次数有限，给一个上限（例如 20 轮，
      //   相当于最多再观察 200 秒）足够覆盖思考停顿，又不会泄漏。
      if (text.length > 0 && w.growRounds < MAX_GROW_ROUNDS) {
        w.growRounds++;
        if (w.node) { clearTimeout(w.node); }
        w.node = scheduleTick(w, STALL_GRACE_MS);
      } else {
        if (w.node) { clearTimeout(w.node); w.node = null; }
        dropWatch(w);
      }
    } catch (e) {
      log('error', 'watchdog: ' + e);
    }
  }

  /**
   * 定稿后收到更多内容：更新同一条存档。
   *
   * 只在"内容确实变长了"时才写，避免无意义的重复写入。
   */
  function growCommitted(w) {
    try {
      if (!w || !w.committed) return false;
      var text = w.maxText || '';
      if (text.length <= (w.committedLen || 0)) return false;

      var sessId = w.committedSessId || '';
      var msgId = w.committedMsgId;
      if (msgId === undefined || msgId === null) return false;

      // 从完整流文本重建片段（比中途的暂存更完整）
      var frags = extractReadable(extractFragmentsFromStream(text));
      if (!frags || frags.length === 0) return false;

      var existing = loadArchive(sessId, msgId);
      var oldLen = 0;
      if (existing && existing.fragments) {
        oldLen = fragmentTextLength(existing.fragments);
      }
      var newLen = fragmentTextLength(frags);
      if (newLen <= oldLen) return false;

      // 直接覆盖同一条存档（这是同一条消息，不是新消息）
      saveArchive(sessId, msgId, frags, existing ? existing.reason : 'LIVE_GROW');
      w.committedLen = text.length;
      log('grow', 'msgId=' + msgId + ' 正文 ' + oldLen + ' → ' + newLen);
      bridge('onArchiveChanged', countArchive());
      return true;
    } catch (e) {
      log('error', 'growCommitted: ' + e);
      return false;
    }
  }

  /** 片段里可读文本的总长度 */
  function fragmentTextLength(fragments) {
    if (!isArray(fragments)) return 0;
    var n = 0;
    for (var i = 0; i < fragments.length; i++) {
      var f = fragments[i];
      if (!f) continue;
      if (f.type === TEMPLATE_RESPONSE || f.type === 'TIP') continue;
      if (typeof f.content === 'string') n += f.content.length;
    }
    return n;
  }

  /**
   * 从原始 SSE 文本里尽力恢复已收到的 fragments。
   * 逐行解析 data:，用独立状态机重放（不触碰正在进行的那个）。
   */
  function extractFragmentsFromStream(text) {
    try {
      var tmp = new DSState('');
      var lines = String(text).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line || line.indexOf('data:') !== 0) continue;
        var payload = line.substring(5);
        if (payload.charAt(0) === ' ') payload = payload.substring(1);
        if (!payload || payload === '[DONE]') continue;
        var data = null;
        try { data = JSON.parse(payload); } catch (e) { continue; }
        // 用 replay 模式：只累积，不触发撤回判定/存档
        tmp.replay(data);
      }
      var fr = tmp.fields && tmp.fields.response && tmp.fields.response.fragments;
      fr = extractReadable(fr);
      return fr || [];
    } catch (e) {
      return [];
    }
  }

  /** 只累积状态、不做撤回判定（给看门狗与恢复用） */
  DSState.prototype.replay = function (data) {
    try {
      var path = normalizePath(data.p !== undefined ? data.p : '');
      var mode = data.o || 'SET';
      var value = data.v;

      // 整体 SET
      if (path === '' && typeof value === 'object' && value !== null && !isArray(value)) {
        for (var k in value) {
          if (Object.prototype.hasOwnProperty.call(value, k)) this.fields[k] = value[k];
        }
        if (value.response && value.response.chat_session_id) {
          this.sessId = String(value.response.chat_session_id);
        }
        return;
      }

      // ★ 裸字符串增量（与 handle 保持一致）：
      //   线上 2200+ 个事件都是这种形态，replay 必须同样处理，
      //   否则从流文本重建时依然只能拿到骨架那几个字。
      if (path === '' && typeof value === 'string' && value.length > 0) {
        this.appendDelta(value);
        return;
      }

      // 裸数组批量
      if (path === '' && isArray(value) && value.length > 0) {
        this.applyBatchAt('', value);
        return;
      }

      if (path !== '') this.apply(path, value, mode);
      if (this.fields && this.fields.response && this.fields.response.message_id !== undefined) {
        this.lastMsgId = this.fields.response.message_id;
      }
      this.snapshot(this.fields);
    } catch (e) { }
  };

  /* =====================================================================
   * 10. 启动
   * ===================================================================== */
  try { installXhrHook(); } catch (e) { log('error', 'XHR hook 安装失败: ' + e); }
  try { installFetchHook(); } catch (e) { log('error', 'fetch hook 安装失败: ' + e); }

  bridge('onReady', VERSION);
  bridge('onArchiveChanged', countArchive());
  reportHealth();
  pushSnapshot();
})();
