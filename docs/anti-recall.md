# 防撤回模块技术说明

本文只讲 `app/assets/ds_shell.js` 的实现细节与验证方法。

---

## 零、v1.1.0 修复的 10 个缺陷（线上失效的真实原因）

v1.0.0 上线后防撤回失效。复核确认**协议没变**（当前线上 bundle 仍是
`h.parse(t.responseText)`，`responseType` 默认 `"text"`，
`TEMPLATE_RESPONSE`/`CONTENT_FILTER` 信号仍在），**引擎也支持**（真机实测
`getOwnPropertyDescriptor` 拿得到 getter）。失效纯属实现缺陷。

| 编号 | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| **B3** | 撤回事件恰为流末行且末尾无 `\n` | **主功能整体漏检**：TIP 不出现、原文不存档 | `readyState===4` 时把尾部当完整行 flush（`__dsFlushedTail` 标记一次性） |
| **B1** | `open` 未重置增量状态 | XHR 复用（重试/resume_stream）时把上次的 TIP 插进新回答正文 | `open` 里重置 `__dsState/__dsOffset/__dsRewrites/__dsSessId` |
| B2 | 整体 SET 用 `=== undefined` 守卫 | resume_stream 重放时 `message_id` 卡在旧值，存档写错 msgId | 整体事件直接 `fields = {}` 重建 |
| B4 | 子操作强依赖 `o === 'SET'` | BATCH 省略 `o`（协议缺省即 SET）时漏检，**相对原脚本是回归** | `var opMode = op.o \|\| 'SET'` |
| B5 | 无 `message_id` 时整段跳过存档 | 正文静默丢失 | 三级兜底：`response.message_id → lastMsgId → 'auto-…'` |
| B6 | `fragments` 被清空后不存档 | response 被 SET 成 `{}` 时原文彻底丢 | `snapshot()` 保留"最长且含正文"的快照，**放在 apply 之后** |
| B7 | `responseType='json'` 时 `rawText` 抛错吞成 `''` | 历史还原完全不生效 | 非 text 模式改走 `descResp.get` 再序列化 |
| B8 | 无存档时无脑覆盖 fragments | 服务器仍在返回的可读正文被 TIP 顶掉 | `extractReadable()` 有正文则保留并 push TIP |
| B9 | 分页接口 sess 只挂在 message 上 | 有存档却显示"未找到" | `walk` 补 `node.chat_session_id` / `node.session_id` |
| B10 | 路径精确等匹配 | 路径一变就静默失效 | 改前缀匹配 + 补 `/api/v0/chat/fetch_page` 等变体 |

> B3 修复时踩过二次坑：第一版用 `lastNl = chunk.length` 导致 `scanEnd` 越界 1
> （`offset=597` 而 `len=596`），`applyRewrites` 因 `w.e > out.length` 把改写整条丢弃，
> 表现为"存档成功但 TIP 不显示"。正确写法是 `chunk.length - 1`。

---

## 零之二、v1.2.0：三层保险（针对"计数仍为 0"）

v1.1.0 装上去后计数仍为 0，说明**钩子根本没生效**。两个原因：

### 原因 1：所谓"双保险"是假的（已修）

`onPageFinished` 里原本只调 `applyShellConfig()`，而它依赖 `__DS_SHELL__` 已存在。
如果 `shouldInterceptRequest` 没命中主文档，脚本从未执行，这句补丁等于什么都没做。

**修法**：新增 `ShellInjector`，先探测 `window.__DS_SHELL_INSTALLED__`，
没装就立即用 `evaluateJavascript` 把脚本真正补进当前文档。
已验证：`node tools/js-test/lateinject.js` → 5/5 PASS（含"拦截失败→补注入→能拦截撤回"）。

### 原因 2：整条链路静默失败，用户看不到

现在脚本会通过 `DSApp.onHealth` 上报健康状态，设置页「引擎与兼容性」顶部直接显示：

```
防撤回状态
  ✅ 工作正常：钩子在 proto 层，对话接口命中 3 次，已拦截 1 次。
  脚本版本：1.2.0
  钩子层级：proto
  见到请求：12 次
  生成命中：3 次
  ...
```

它能把失败分成三类，每类结论不同：

| 显示 | 含义 | 下一步 |
|---|---|---|
| ⛔ 钩子未安装 | `getOwnPropertyDescriptor` 拿不到 getter | 换内核 / 反馈 |
| ⚠ 钩子已装但 0 请求 | 脚本在跑，页面没发请求 | 正常（还没发消息） |
| ⚠ 有请求但 0 命中 | **接口路径变了** | 看「最近命中路径」 |
| ✅ 命中但 0 拦截 | 路径对，撤回信号变了 | 看第二重保险是否兜住 |

## 零之三、第二重保险：完整性看门狗（不依赖任何信号）

第一重保险依赖"服务端下发 TEMPLATE_RESPONSE / CONTENT_FILTER"。
只要协议细节有偏差（换名、嵌套变化、时序不同），就会整套漏检 —— 且完全静默。

这套看门狗**完全不看信号**，只判断两件事：

1. 中途收到的**最大正文快照**（逐次增长时更新）
2. 这次请求**是否正常收尾**

若"内容停止增长超过 10 秒"且"该请求没有正常结束"（没走 FINISHED/STOPPED、
也没正常关闭），就判定为被中途掐断，把快照存档，reason 记为 `STALL_WATCHDOG`。

**防误伤是重点**（这是它能否默认开启的关键）：

| 场景 | 判定 | 理由 |
|---|---|---|
| 正常完成（FINISHED） | 不存 | 状态机已收敛 |
| 用户点停止（STOPPED） | 不存 | 是用户意图，不是撤回 |
| 内容 < 64 字符 | 不存 | 空回答无可救 |
| 关闭开关 | 完全不触发 | 零副作用 |
| 信号已拦截 + 看门狗 | 只存 1 条 | 按 reason 去重，不重复 |

验证：`node tools/js-test/watchdog.js` → 8/8 PASS（含全部 5 类防误伤）。

## 一、它为什么能工作

DeepSeek 前端（commit `26090614`）的流式对话流程：

```
POST /api/v0/chat/completion   (SSE)
  ↓
自研 HTTP 库（底层 XMLHttpRequest，responseType="text"）
  ↓
addEventListener("progress") → 读 xhr.responseText 增量解析
```

关键事实（实测确认，非推测）：

| 事实 | 依据 |
|---|---|
| 底层用 `XMLHttpRequest` | `vendors.js` 里 `new XMLHttpRequest; p.open(n,e,!0); p.responseType=o` |
| SSE 靠 `onDownloadProgress` + `responseText` | `main.js` 里 `onDownloadProgress` / `SSEParse` 逻辑 |
| **没有** `EventSource` | 两个 bundle 里计数为 0 |
| **没有** `ReadableStream.getReader` | 同上 |
| 响应头 CSP 只有 `frame-ancestors 'none'` | 无 `script-src`，内联脚本可执行 |

因此 **`XMLHttpRequest.prototype` 的 `responseText` getter 钩子** 是有效且唯一可靠的位置。

### 撤回是怎么发生的

服务端在下发一条回复的过程中，若触发内容拦截，会在同一条 SSE 流里追加一个
`BATCH` 事件，把 `response.fragments` 覆盖成占位模板，并把 `status` 置为
`CONTENT_FILTER`。前端据此渲染"已屏蔽"占位。

我们的钩子在该行到达前篡改它：把占位模板替换成提示片段，把 `CONTENT_FILTER`
改成 `FINISHED`（否则前端会一直转圈并吞掉思考过程），同时把**已经收到过的完整内容**
存进 `localStorage`。

---

## 二、相对原始脚本（GreasyFork, Franky T）的改动

原脚本 434 行，机制正确但有几个真实缺陷。逐条对照：

| # | 原脚本问题 | 本实现 |
|---|---|---|
| 1 | 每个 `progress` 事件把**整个** `responseText` 重新 `split('\n')` 全量重解析 → 长回答 O(n²) | 增量：`__dsOffset` 记录已处理偏移，只解析新增完整行 |
| 2 | 原 getter 在 `readyState < 2` 调用会抛 `InvalidStateError`，冒泡会打断页面请求 | 所有原 getter 调用包 `try/catch`，且 `readyState >= 2` 才读 |
| 3 | 存档只存裸 `fragments` 数组（无版本/时间/原因/会话标题） | 结构化 `{v,ts,sessId,msgId,reason,fragments,locale,title}` + `__ds_archive_index` 索引 |
| 4 | 不兼容旧格式，升级后老存档丢失 | `loadArchive` 检测：是数组就按旧格式包装，向后兼容 |
| 5 | 只 hook XHR；站点若改 `fetch` 即失效 | 额外 hook `fetch`（仅历史 JSON，绝不动流式 body，异常一律回退原值）|
| 6 | 只认 `TEMPLATE_RESPONSE` 一种信号 | 覆盖 4 类：①fragments SET 成占位 ②fragments APPEND 占位 ③status→CONTENT_FILTER ④未知 status（**只记录不篡改**，防误伤"用户主动停止"）|
| 7 | 历史还原硬编码 `data.biz_data.chat_messages` 层级 | 递归遍历任意 JSON，兼容 `chat_session/fetch_page` 分页形态 |
| 8 | `localStorage` 写满/被禁时抛异常打断流 | 降级到内存 `memStore` + `DSApp.onArchiveError` 上报 + 环形日志 |
| 9 | 无控制面，无法在不重载页面的情况下开关 | `__DS_SHELL__`：`setEnabled/isEnabled/count/exportArchive/removeArchive/clearArchive/getStats` |

### 我自己修掉的三个真 bug

**Bug 1 — 改写丢失（最严重）**
`processStream` 原本在本轮没有新增改写时 `return text`（原始文本）。
但 WebView 的 `responseText` getter **每次读到的都是原始未改动全文**，
所以先前被替换掉的行会在下一次读取时"复活"，TIP 提示一闪而过。
修正：无论本轮是否有新增，都对原始全文重放累积的 `req.__dsRewrites`（`applyRewrites`）。

**Bug 2 — 存档原因被覆盖**
同一轮 BATCH 里 `fragments(占位)` 与 `status(CONTENT_FILTER)` 同时命中时，
`saveArchive` 被调用两次，后写把更精确的 `TEMPLATE_RESPONSE` 覆盖成 `CONTENT_FILTER`。
修正：首因优先 + `!modified` 守卫，一轮只存一次。

**Bug 3 — 测试台的隔离问题（不是实现问题，但会掩盖实现问题）**
mock 的 `XMLHttpRequest` 原型在多个测试 env 间共享，第二个 env 会在**已被 hook 过**的原型上
再包一层，导致改写重复应用（文本从 648→666→684 字节不断膨胀）、`count` 归零。
修正：每个 env 生成独立原型，并把 accessor **复制为自己的 own property**
（否则 `getOwnPropertyDescriptor` 在派生原型上返回 undefined，脚本会误判"没有 getter"而跳过安装）。

---

## 三、如何验证

```bash
node tools/js-test/run.js
```

16 个用例，全 PASS：

```
PASS  ES5 syntax (acorn ecmaVersion=5)
PASS  正常回答：不篡改、不存档
PASS  生成中撤回：篡改为 TIP + 写入存档
PASS  思考阶段 CONTENT_FILTER：改 FINISHED + 存档 + 思考不丢
PASS  历史消息：有存档 → 还原原文 + 追加提示
PASS  历史消息：无存档 → 显示"未找到"占位
PASS  增量解析与一次性解析结果等价（长对话）
PASS  长对话性能：增量解析耗时线性（不 O(n²)）      ← 913KB / 50ms
PASS  关闭防撤回：完全旁路（流不变、无存档）
PASS  普通 XHR 完全不受影响
PASS  readyState<2 触发读取不抛 InvalidStateError
PASS  localStorage 配额满：降级内存 + 上报 + 不崩
PASS  导出/删除/清空 闭环
PASS  流中出现坏 JSON 行：跳过且不影响后续
PASS  向后兼容：能读旧格式（裸 fragments 数组）存档
PASS  会话 ID 提取：body 与 URL 两种来源
```
另外还有一套**对抗性审计**（20 个探针，逐条覆盖上方 B1–B10 的每个缺陷）：

```bash
node tools/js-test/audit/adversarial.js
# → === 20 ok, 0 bug(s) confirmed ===
# → no defects found
```

这套审计是独立于实现写的（先写断言、再看实现是否满足），
因此它能抓到"实现自测全绿但线上失效"这类问题 —— v1.0.0 正是这样。


### 测试台的两个关键设计（否则测不出真问题）

1. **必须在每个 chunk 后读 `xhr.responseText`**
   钩子的触发条件是"有人读 `responseText`"。真实站点每个 progress 都读；
   若测试只 `_appendChunk` 而不读，钩子永远不会执行 —— 我第一次就踩了这个坑，
   表现为"全部用例失败但直接调用 internals 却正确"。

2. **`response`/`responseText` 必须是 prototype 上的 accessor**
   如果是实例上的数据属性，会遮蔽原型访问器，`getOwnPropertyDescriptor` 拿不到 getter，
   钩子无法安装。

### 端到端注入验证

```bash
# 用真实 idx.html + 真实脚本，验证 Injector 的等价算法
tools/inject-test/E2E.java → 7/7 PASS
```

断言：
- payload 完整注入
- HTML 无损（去掉 payload 等于原文，逐字节）
- payload 紧跟 `<head>`
- payload 早于前端 bundle 的 `<script>`
- 脚本体内无裸 `</script>`（否则提前闭合）
- SRI `integrity=` 数量未变
- `<script` 总数恰好 +1

---

## 四、已知边界

1. **依赖主文档可被拦截。** 若站点将来用 Service Worker 预缓存主文档，
   `shouldInterceptRequest` 拿不到 HTML，只能退化为"页面就绪后补注入"，会漏掉首轮请求。
   设置里有「启动时即注入」开关可感知此差异。

2. **只能救"已经下发过"的内容。** 如果服务端从一开始就没发全文（直接返回占位），
   本地无从还原 —— 此时会显示"⛔ 已拦截，本地存档中未找到"，而不是假装有内容。

3. **存档随 WebView 数据一起消失。** 清除浏览数据/卸载 App 会一起没。
   因此提供「导出 JSON」到文件。

4. **`fetch` 钩子只处理历史 JSON。** 流式 `response.body` 一旦被读取就无法安全重放，
   强行包装会破坏 SSE。所以流式场景仍依赖 XHR 路径（而当前线上正是 XHR）。

5. **ES5 是硬约束。** 脚本要在 Chromium 37 这种跑不动前端的机器上也能安全执行，
   以便上报诊断。已用 acorn `ecmaVersion: 5` 作为构建期断言。
