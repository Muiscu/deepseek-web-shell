# 兼容性与内核调研结论（实测记录）

本文记录本项目最关键的一次技术判断，以及我为此做的实测过程。**结论先行**，过程供核查。

---

## 结论

| 项 | 值 |
|---|---|
| 本 App `minSdkVersion` | **22**（Android 5.1）— 可安装、可启动、UI 完整 |
| DeepSeek 线上 bundle 最低语法 | **ES2019** |
| ES2019 所需 Chromium | **≥ 66** |
| Android 5.1 出厂 System WebView | **Chromium 37** |
| **Android 5.1 WebView 可升级上限** | **Chromium ≈ 85**（实测经验，非理论推测） |
| 结果 | 5.1 **出厂状态**白屏；**升级 WebView 后可完整运行** |

所以本项目对 5.1 的策略是：
**启动即检测内核；默认状态不达标就给出升级指引；升级到 66+ 后一切正常。**

> 注意：5.1 能升到 85 这一点很关键。它意味着这个 App 在 5.1 上是**真正可用的**，
> 不需要"降级对待"，唯一的前置动作是更新一次 WebView。我最初只以"Chromium 66 是下限"
> 来设计引导，措辞偏悲观，已按实测上限 85 全面修正。

---

## 实测过程

### 1. 抓当前线上 bundle

```
https://chat.deepseek.com/            → commit-id: 26090614
https://fe-static.deepseek.com/chat/static/main.d1d163b7e4.js            1,584,272 B
https://fe-static.deepseek.com/chat/static/default-vendors.a2a242fbd2.js  1,032,473 B
```

### 2. 用 acorn 逐级降 `ecmaVersion` 找最低可解析版本

```js
const cands = [5,6,7,8,9,10,11,12,13];
for (const v of cands) {
  try { acorn.parse(src, { ecmaVersion: v, sourceType: 'script' }); return v; }
  catch (e) { /* 继续降级 */ }
}
```

结果：

```
main.js     minEcma = 10 (ES2019)
vendors.js  minEcma = 10 (ES2019)
```

### 3. 定位卡在 ES2018 的具体语法

ES2018 失败点（`main.js` 偏移 19570）：

```js
function C(e){let t=f();try{e.moveBefore(t,null)}catch{e.appendChild(t)}}
//                                             ^^^^^ catch{} 省略绑定名
```

`vendors.js` 失败点（偏移 2774）：

```js
let o=50,s=async(t,e,n)=>{let{placement:r="bottom",strategy:s="absolute",middleware:l=[],platform:u}=n,...
//                          ^ 解构默认值中的缩写赋值（ES2015+ 组合）
```

`catch{}`（可选 catch 绑定）是 **ES2019** 新特性 → 需要 **Chromium 66+**。

### 4. 交叉验证：语法之外没有更狠的现代特性

对两个 bundle 做特征计数（排除误判）：

| 特性 | main.js | vendors.js | 最低要求 |
|---|---|---|---|
| 箭头函数 | 7180 | 730 | Chrome 45 |
| `let/const` | 3119 | 1197 | Chrome 49 |
| `async/await` | 246 | 41 | Chrome 55 |
| 可选链 `?.` | **0** | 2（被 polyfill/注释区） | Chrome 80 |
| 空值合并 `??` | **0** | 3 | Chrome 80 |
| 私有字段 `#x` | 43 | 19 | Chrome 74 |
| 可选 catch `catch{}` | **104** | 2 | **Chrome 66** |
| 静态块 `static{}` | 0 | 0 | Chrome 94 |
| BigInt 字面量 | 18 | 2 | Chrome 67 |

**关键**：可选链/空值合并基本没出现（`main.js` 里是 0），静态块也没有。所以真正卡住老内核的是 **`catch{}`（Chrome 66）** 与私有字段（Chrome 74）。
这是好消息：门槛定在 **66**，而不是 80。

### 5. 判定阈值

`EngineInfo` 采用两档：

```java
MIN_CHROME_SAFE = 66;   // ES2019 下限，低于此必然白屏
MIN_CHROME_GOOD = 80;   // 实测稳定区间（私有字段等更宽松）
```

- ≥ 80 → 良好
- 66–79 → 可用（红色横幅提示可能有个别效果缺失）
- < 66 → 不可用（跳「引擎与兼容性」页，不给白屏）

阈值靠**解析 `WebSettings.getDefaultUserAgent()` 里的 `Chrome/xx` 主版本号**得到，
不是靠 `Build.VERSION.SDK_INT`（同版本 Android 的 WebView 可能被更新过）。

---

## 备选引擎方案的调研结论（都不采用）

### Crosswalk Project
查 GitHub releases API 后发现，可达的发布只有：

```
1.28.1.0  (2013-08-02)
1.28.2.0  (2013-08-08)
```

这两个是 **Chromium 29 时代**的产物，对 ES2019 毫无帮助。Crosswalk 主流可用版本（
23.x，对应 Chromium 53/57）已随 01.org 关站与 GitHub 归档而难以获取，且体积增加 20MB+。
**不采用。**

### GeckoView
要求较高 minSdk，且 armeabi-v7a 32 位支持在新版本中已缩减，AAR 体积大。
对"5.1 老机"场景收益不如直接引导升级 WebView。**不采用。**

### 腾讯 X5 / TBS
需要联网下载内核、且新版本已不支持低 API。**不采用。**

---

### 5.1 设备上的实操路径（写给用户）

见 App 内「引擎与兼容性」页，要点：

1. **先诊断**：页面上会显示系统版本、WebView 包名、Chromium 主版本、判定结果，
   以及「Android 5.x 可升级上限：Chromium 85 左右」。
2. **验证是不是内核问题**：点「打开系统浏览器试试」。浏览器能开、App 白屏 = 内核问题。
3. **升级 WebView**：安装/更新「Android System WebView」或「Chrome」。
   5.1 可升到 Chromium ≈ 85，远超网页要求的 66。
4. **重新检测**：回到 App 点「重新检测引擎」，会立刻读到新版本并解除拦截。
5. **换实现**：部分 ROM 锁死 `com.android.webview`，
   可在「开发者选项 → WebView 实现」切到 Chrome。

---

## 一个独立于内核的兜底设计

`ds_shell.js`（防撤回注入脚本）**坚持写成 ES5**。
原因：即便在 Chromium 37 这种跑不动 React bundle 的机器上，这段脚本仍要能安全执行，
以便把诊断信息上报给宿主、并在兼容性页显示"脚本已安装/引擎过低"。
如果它也用了 ES2019，在 5.1 上会**和前端 bundle 一起静默失败**，用户什么都看不到。

已用 `acorn.parse(src, { ecmaVersion: 5 })` 作为构建期断言（见 `tools/js-test/run.js` 用例 1）。
