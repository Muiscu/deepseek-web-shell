package com.yg.dsweb;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 兼容性说明页。
 *
 * 这是"安卓 5.1 能不能用"这个问题的正面回答：
 * 我们不是靠猜，而是把实测到的 WebView 内核版本、网页所需的最低版本、
 * 以及这台机器上可行的升级路径，全部摆在用户面前。
 */
public class CompatActivity extends Activity {

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Ui.applySystemBars(this);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Ui.color(this, R.color.bg));
        sv.setFillViewport(true);
        setContentView(sv);

        LinearLayout col = Ui.column(this);
        col.setPadding(Ui.dp(this, 20), Ui.dp(this, 20), Ui.dp(this, 20), Ui.dp(this, 32));
        sv.addView(col, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ---- 顶部返回 ----
        LinearLayout top = Ui.row(this);
        TextView back = Ui.text(this, "← 返回", 15f, Ui.color(this, R.color.accent_text));
        back.setPadding(0, Ui.dp(this, 4), Ui.dp(this, 12), Ui.dp(this, 12));
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        top.addView(back);
        col.addView(top);

        // ---- 标题 ----
        TextView title = Ui.text(this, "引擎与兼容性", 24f, Ui.color(this, R.color.text_primary));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);

        TextView sub = Ui.text(this,
                "本 App 只是一个贴近原生的 WebView 外壳；页面能否渲染，取决于系统 WebView 内核版本。",
                13f, Ui.color(this, R.color.text_secondary));
        sub.setLineSpacing(Ui.sp(this, 4), 1f);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = Ui.dp(this, 8);
        col.addView(sub, subLp);

        // ---- 当前状态卡 ----
        col.addView(sectionTitle("当前设备"));
        LinearLayout statusCard = card();
        TextView status = Ui.text(this, EngineInfo.summary(), 13f,
                Ui.color(this, R.color.text_primary));
        status.setLineSpacing(Ui.sp(this, 5), 1f);
        status.setTextIsSelectable(true);
        statusCard.addView(status);
        col.addView(statusCard);

        // ---- 结论 ----
        col.addView(sectionTitle("结论"));
        LinearLayout verdictCard = card();
        // ---- 防撤回工作状态（放最前面：这是用户最关心的） ----
        col.addView(sectionTitle("防撤回状态"));
        LinearLayout recallCard = card();
        TextView recallVerdict = Ui.text(this, ShellHealth.verdict(), 14f,
                Ui.color(this, R.color.text_primary));
        recallVerdict.setTypeface(Typeface.DEFAULT_BOLD);
        recallVerdict.setLineSpacing(Ui.sp(this, 4), 1f);
        recallCard.addView(recallVerdict);

        TextView recallDetail = Ui.text(this, ShellHealth.describe(), 12.5f,
                Ui.color(this, R.color.text_secondary));
        recallDetail.setLineSpacing(Ui.sp(this, 5), 1f);
        recallDetail.setTextIsSelectable(true);
        LinearLayout.LayoutParams rdLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rdLp.topMargin = Ui.dp(this, 10);
        recallCard.addView(recallDetail, rdLp);
        col.addView(recallCard);

        // ★ 进本页时实时拉一次最新状态。
        //   之前只显示 ShellHealth 里的缓存，而脚本只在启动时上报一次，
        //   于是用户看到的永远是「启动那一刻」的旧数据 —— 8 个请求、0 命中，
        //   把「其实已经命中」误判成「从未命中」。这是诊断最不该错的错。
        final TextView fVerdict = recallVerdict;
        final TextView fDetail = recallDetail;
        refreshHealthLive(fVerdict, fDetail);

        addAction(col, "刷新状态（重新拉取）",
                "从页面实时读取最新的钩子/命中/存档数据。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        refreshHealthLive(fVerdict, fDetail);
                        Ui.toast(CompatActivity.this, "已刷新");
                    }
                });

        // ---- 引擎结论 ----
        col.addView(sectionTitle("引擎"));
        int g = EngineInfo.grade();
        TextView verdict = Ui.text(this,
                (g >= 3 ? "✅ " : (g == 2 ? "⚠️ " : "⛔ ")) + EngineInfo.gradeLabel(),
                15f, Ui.color(this, R.color.text_primary));
        verdict.setTypeface(Typeface.DEFAULT_BOLD);
        verdictCard.addView(verdict);
        TextView advice = Ui.text(this, EngineInfo.advice(), 13f,
                Ui.color(this, R.color.text_secondary));
        advice.setLineSpacing(Ui.sp(this, 5), 1f);
        LinearLayout.LayoutParams aLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        aLp.topMargin = Ui.dp(this, 10);
        verdictCard.addView(advice, aLp);
        col.addView(verdictCard);

        // ---- 为什么 ----
        col.addView(sectionTitle("为什么会这样"));
        LinearLayout why = card();
        TextView whyText = Ui.text(this, whyText(), 13f, Ui.color(this, R.color.text_secondary));
        whyText.setLineSpacing(Ui.sp(this, 5), 1f);
        why.addView(whyText);
        col.addView(why);

        // ---- 操作 ----
        col.addView(sectionTitle("可以做的事"));

        addAction(col, "继续进入（可能白屏）",
                "仅在你想自己验证时使用。若页面空白，这是内核无法解析 JS 导致。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Intent i = new Intent(CompatActivity.this, MainActivity.class);
                        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                        startActivity(i);
                        finish();
                    }
                });

        addAction(col, "复制诊断信息",
                "把上面的内核信息复制出来，方便排查或反馈。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Ui.copyText(CompatActivity.this, EngineInfo.summary()
                                + "\nUA: " + EngineInfo.userAgent());
                    }
                });

        addAction(col, "打开系统浏览器试试",
                "用本机已安装的浏览器访问 chat.deepseek.com。若浏览器能打开，说明是 WebView 内核问题。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Ui.openUrl(CompatActivity.this, "https://chat.deepseek.com/");
                    }
                });

        addAction(col, "重新检测引擎",
                "安装/更新 WebView 后点这里，立即重新读取内核版本。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        EngineInfo.init(CompatActivity.this);
                        recreate();
                    }
                });

        addAction(col, "① 开始捕获网络请求（120 秒）",
                "点这里 → 立刻回主界面发一条消息 → 等回答完 → 回来点②导出。"
                        + "这会记录发消息那一下所有网络活动，用于定位真实通道。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        startCapture();
                    }
                });

        addAction(col, "② 导出捕获结果",
                "把刚才捕获的请求清单导出来（含通道、方法、路径、响应长度）。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        exportCapture();
                    }
                });

        addAction(col, "抓取真实事件格式（诊断用）",
                "先发一条消息，再点这里。会把页面实际收到的 SSE 事件形态导出到文件，"
                        + "用于定位「存档不全」这类问题。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        captureProbe();
                    }
                });

        addAction(col, "查看暂存与存档明细",
                ProbeStore.has() ? "已有诊断数据" : "查看当前暂存/存档的实际内容",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        showLiveDetail();
                    }
                });

        addAction(col, "关闭启动提示横幅",
                "不再每次进入都提示（不影响本页随时查看）。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Prefs.setShowBanner(false);
                        Ui.toast(CompatActivity.this, "已关闭横幅提示");
                    }
                });

        // ---- 脚注 ----
        TextView foot = Ui.text(this,
                "实测依据：对线上 bundle（commit 26090614）做 ECMAScript 版本探测，"
                        + "最低需要 ES2019（阻塞点为可选 catch 绑定），对应 Chromium ≥ "
                        + EngineInfo.MIN_CHROME_SAFE + "。"
                        + "Android 5.1 出厂的 System WebView 为 Chromium 37，"
                        + "但可升级到 Chromium " + EngineInfo.ANDROID51_WEBVIEW_MAX + " 左右，"
                        + "升级后即可正常使用。",
                11.5f, Ui.color(this, R.color.text_secondary));
        foot.setLineSpacing(Ui.sp(this, 3), 1f);
        LinearLayout.LayoutParams fLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        fLp.topMargin = Ui.dp(this, 24);
        col.addView(foot, fLp);
    }

    private String whyText() {
        return "DeepSeek 网页前端是一个现代 React 应用，其 JS bundle 使用了 "
                + "ES2019 语法（例如 try{...}catch{} 这种省略绑定名的写法）。"
                + "这类语法在解析阶段就会被判定为 SyntaxError，导致整个 bundle 不执行，"
                + "页面只剩空白的 <div id=\"root\">。\n\n"
                + "这不是网络问题，也不是本 App 的 bug —— 是 JS 引擎版本不够。"
                + "Android 5.1 出厂的 System WebView 停在 Chromium 37（2014 年），"
                + "跑不动这些新语法。\n\n"
                + "但 Android 5.1 的 WebView 是可以升级的：实测可到 Chromium "
                + EngineInfo.ANDROID51_WEBVIEW_MAX + " 左右，"
                + "远高于网页要求的 " + EngineInfo.MIN_CHROME_SAFE + "。"
                + "装好新版 WebView/Chrome 后，本 App 在 5.1 上可以完整运行。\n\n"
                + "所以本 App 的策略是：启动即检测内核，"
                + "不满足就停下并直接告诉你怎么升级，而不是让用户对着白屏猜。";
    }

    private TextView sectionTitle(String s) {
        TextView t = Ui.text(this, s, 13f, Ui.color(this, R.color.text_secondary));
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLetterSpacing(0.04f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 26);
        lp.bottomMargin = Ui.dp(this, 8);
        t.setLayoutParams(lp);
        return t;
    }

    private LinearLayout card() {
        LinearLayout c = Ui.column(this);
        c.setBackgroundResource(R.drawable.bg_card);
        c.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        c.setLayoutParams(lp);
        return c;
    }

    /**
     * 抓取真实 SSE 事件形态并导出到文件。
     *
     * 这是排查"存档只存两个字符"的核心手段：
     * 页面把自己实际收到的每个 data: 事件（含形态签名与样例）吐出来，
     * 不用再靠猜线上协议。
     */
    /** 开始捕获窗口：回主界面发消息，这期间的网络活动都会被记录 */
    /** 从页面实时拉取最新健康状态并刷新两个 TextView */
    private void refreshHealthLive(final TextView verdictView, final TextView detailView) {
        MainActivity host = MainActivity.instance();
        if (host == null || host.getWebView() == null) {
            verdictView.setText("⛔ 主界面未打开，读不到页面状态。\n请先回主界面加载对话页。");
            detailView.setText(ShellHealth.describe());
            return;
        }
        String js = "(function(){try{"
                + "var s=window.__DS_SHELL__;"
                + "if(!s)return '{\"error\":\"shell-missing\"}';"
                + "return s.getStats?s.getStats():'{\"error\":\"no-getStats\"}';"
                + "}catch(e){return JSON.stringify({error:String(e)});}})();";
        host.evaluateJsForResult(js, new MainActivity.JsResult() {
            @Override
            public void onResult(String value) {
                try {
                    String raw = stripQuotes(value);
                    ShellHealth.put(raw);
                    verdictView.setText(ShellHealth.verdict());
                    detailView.setText(ShellHealth.describe());
                } catch (Throwable t) {
                    verdictView.setText("读取状态失败：" + t.getMessage());
                }
            }
        });
    }

    private void startCapture() {
        MainActivity host = MainActivity.instance();
        if (host == null || host.getWebView() == null) {
            Ui.toast(this, "请先返回主界面打开对话页");
            return;
        }
        String js = "(function(){try{"
                + "var s=window.__DS_SHELL__;"
                + "if(!s||!s.capStart)return 'no-shell';"
                + "s.capStart(120);"
                + "return 'started';"
                + "}catch(e){return 'err:'+e;}})();";
        host.evaluateJsForResult(js, new MainActivity.JsResult() {
            @Override
            public void onResult(String value) {
                if (value != null && value.contains("started")) {
                    Ui.toast(CompatActivity.this,
                            "已开始捕获（120 秒）\n现在回主界面发一条消息");
                } else {
                    Ui.toast(CompatActivity.this, "开始失败：" + value);
                }
            }
        });
    }

    /** 导出捕获结果并保存到文件 */
    private void exportCapture() {
        MainActivity host = MainActivity.instance();
        if (host == null || host.getWebView() == null) {
            Ui.toast(this, "请先返回主界面打开对话页");
            return;
        }
        String js = "(function(){try{"
                + "var s=window.__DS_SHELL__;"
                + "if(!s||!s.capExport)return '{\"error\":\"no-shell\"}';"
                + "return s.capExport();"
                + "}catch(e){return JSON.stringify({error:String(e)});}})();";
        host.evaluateJsForResult(js, new MainActivity.JsResult() {
            @Override
            public void onResult(String value) {
                try {
                    String raw = stripQuotes(value);
                    saveToFileNamed(raw, "net-capture");

                    org.json.JSONObject o = new org.json.JSONObject(raw);
                    if (o.has("error")) {
                        showDialog("导出失败", o.optString("error"));
                        return;
                    }
                    showDialog("捕获结果", describeCapture(o));
                } catch (Throwable t) {
                    showDialog("导出失败", String.valueOf(t.getMessage()));
                }
            }
        });
    }

    private String describeCapture(org.json.JSONObject o) {
        StringBuilder sb = new StringBuilder();
        sb.append("捕获中：").append(o.optBoolean("active", false) ? "是" : "否")
                .append("　剩余：").append(o.optInt("remaining", 0)).append(" 秒\n");
        sb.append("记录条数：").append(o.optInt("count", 0)).append("\n\n");

        org.json.JSONArray items = o.optJSONArray("items");
        if (items != null && items.length() > 0) {
            sb.append("捕获到的请求：\n");
            for (int i = 0; i < items.length() && i < 40; i++) {
                org.json.JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                sb.append("  [").append(it.optString("c")).append("] ")
                        .append(it.optString("m")).append(' ')
                        .append(it.optString("u")).append('\n');
            }
        } else {
            sb.append("（捕获窗口内没有记录到请求）\n");
        }

        org.json.JSONArray net = o.optJSONArray("net");
        if (net != null && net.length() > 0) {
            sb.append("\n全部网络总账（").append(net.length()).append(" 条）：\n");
            for (int i = 0; i < net.length() && i < 40; i++) {
                org.json.JSONObject it = net.optJSONObject(i);
                if (it == null) continue;
                sb.append("  [").append(it.optString("c")).append("] ")
                        .append(it.optString("m")).append(' ')
                        .append(it.optString("u")).append('\n');
            }
        }
        sb.append("\n（文件已保存到 App 目录，可发给开发者）");
        return sb.toString();
    }

    private void saveToFileNamed(String json, String prefix) {
        try {
            java.io.File dir = ArchiveDir.get();
            java.io.File f = new java.io.File(dir,
                    prefix + "-" + ArchiveDir.stamp() + ".json");
            java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
            fos.write(json.getBytes("UTF-8"));
            fos.close();
            android.util.Log.d("DSWeb", "saved: " + f.getAbsolutePath());
        } catch (Throwable t) {
            android.util.Log.e("DSWeb", "save failed", t);
        }
    }

    private void captureProbe() {
        MainActivity host = MainActivity.instance();
        if (host == null || host.getWebView() == null) {
            Ui.toast(this, "请先返回主界面打开对话页");
            return;
        }
        String js = "(function(){try{"
                + "if(!window.__DS_SHELL__)return '{\"error\":\"shell-missing\"}';"
                + "var p=window.__DS_SHELL__.exportProbe?window.__DS_SHELL__.exportProbe():null;"
                + "if(!p)return '{\"error\":\"probe-missing\"}';"
                + "var l=window.__DS_SHELL__.listLive?window.__DS_SHELL__.listLive():[];"
                + "var o=JSON.parse(p);o.live=l;return JSON.stringify(o);"
                + "}catch(e){return JSON.stringify({error:String(e)});}})();";

        host.evaluateJsForResult(js, new MainActivity.JsResult() {
            @Override
            public void onResult(String value) {
                try {
                    String raw = stripQuotes(value);
                    ProbeStore.put(raw);
                    saveToFile(raw);

                    org.json.JSONObject o = new org.json.JSONObject(raw);
                    if (o.has("error")) {
                        showDialog("抓取失败", o.optString("error"));
                        return;
                    }
                    showDialog("事件格式已导出",
                            ProbeStore.describe()
                                    + "\n文件已保存到 App 目录，可发给开发者。");
                } catch (Throwable t) {
                    showDialog("抓取失败", String.valueOf(t.getMessage()));
                }
            }
        });
    }

    /** 查看暂存与存档的实际内容（判断"存了几个字符"的最直接证据） */
    private void showLiveDetail() {
        MainActivity host = MainActivity.instance();
        if (host == null || host.getWebView() == null) {
            Ui.toast(this, "请先返回主界面打开对话页");
            return;
        }
        String js = "(function(){try{"
                + "var s=window.__DS_SHELL__;if(!s)return '{\"error\":\"shell-missing\"}';"
                + "var out={live:[],arch:[],frags:null};"
                + "if(s.listLive)out.live=s.listLive();"
                + "try{var a=JSON.parse(s.exportArchive());out.arch=a.items||[];}catch(e){}"
                + "try{if(s.fragSnapshot)out.frags=JSON.parse(s.fragSnapshot());}catch(e){}"
                + "return JSON.stringify(out);"
                + "}catch(e){return JSON.stringify({error:String(e)});}})();";

        host.evaluateJsForResult(js, new MainActivity.JsResult() {
            @Override
            public void onResult(String value) {
                try {
                    String raw = stripQuotes(value);
                    org.json.JSONObject o = new org.json.JSONObject(raw);
                    if (o.has("error")) {
                        showDialog("读取失败", o.optString("error"));
                        return;
                    }
                    showDialog("暂存与存档明细", buildDetail(o));
                } catch (Throwable t) {
                    showDialog("读取失败", String.valueOf(t.getMessage()));
                }
            }
        });
    }

    private String buildDetail(org.json.JSONObject o) {
        StringBuilder sb = new StringBuilder();
        org.json.JSONArray live = o.optJSONArray("live");
        org.json.JSONArray arch = o.optJSONArray("arch");
        sb.append("【暂存】").append(live == null ? 0 : live.length()).append(" 条\n");
        if (live != null) {
            for (int i = 0; i < live.length() && i < 5; i++) {
                org.json.JSONObject it = live.optJSONObject(i);
                if (it == null) continue;
                sb.append("  msgId=").append(it.optString("msgId"))
                        .append("  文本长度=").append(it.optString("text").length())
                        .append("  片段数=");
                org.json.JSONArray fr = it.optJSONArray("fragments");
                sb.append(fr == null ? 0 : fr.length()).append('\n');
            }
        }
        sb.append("\n【正式存档】").append(arch == null ? 0 : arch.length()).append(" 条\n");
        if (arch != null) {
            for (int i = 0; i < arch.length() && i < 5; i++) {
                org.json.JSONObject it = arch.optJSONObject(i);
                if (it == null) continue;
                sb.append("  msgId=").append(it.optString("msgId"))
                        .append("  reason=").append(it.optString("reason"))
                        .append("  正文长度=").append(it.optString("text").length()).append('\n');
                String t = it.optString("text");
                if (t.length() > 0) {
                    sb.append("    预览：")
                            .append(t.length() > 60 ? t.substring(0, 60) + "…" : t)
                            .append('\n');
                }
            }
        }

        // ★ 片段结构：判断「正文进了哪个片段」的唯一直接证据
        org.json.JSONObject snap = o.optJSONObject("frags");
        if (snap != null) {
            org.json.JSONArray frs = snap.optJSONArray("frags");
            sb.append("\n【最近一次定稿的片段结构】")
                    .append(snap.optString("tag", "")).append('\n');
            if (frs == null || frs.length() == 0) {
                sb.append("  （没有片段）\n");
            } else {
                for (int i = 0; i < frs.length(); i++) {
                    org.json.JSONObject f = frs.optJSONObject(i);
                    if (f == null) continue;
                    sb.append("  #").append(i)
                            .append(" type=").append(f.optString("type"))
                            .append(" id=").append(f.optString("id"))
                            .append(" 长度=").append(f.optInt("len"))
                            .append('\n');
                    String head = f.optString("head");
                    if (head.length() > 0) {
                        sb.append("      ").append(head).append('\n');
                    }
                }
            }
        }
        return sb.toString();
    }

    private void saveToFile(String json) {
        try {
            java.io.File dir = ArchiveDir.get();
            java.io.File f = new java.io.File(dir,
                    "sse-probe-" + ArchiveDir.stamp() + ".json");
            java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
            fos.write(json.getBytes("UTF-8"));
            fos.close();
            android.util.Log.d("DSWeb", "probe saved: " + f.getAbsolutePath());
        } catch (Throwable t) {
            android.util.Log.e("DSWeb", "probe save failed", t);
        }
    }

    private void showDialog(String title, String body) {
        android.widget.ScrollView sv = new android.widget.ScrollView(this);
        android.widget.TextView tv = Ui.text(this, body, 12f,
                Ui.color(this, R.color.text_primary));
        tv.setTextIsSelectable(true);
        tv.setPadding(Ui.dp(this, 18), Ui.dp(this, 14), Ui.dp(this, 18), Ui.dp(this, 14));
        tv.setTypeface(android.graphics.Typeface.MONOSPACE);
        sv.addView(tv);
        new android.app.AlertDialog.Builder(this)
                .setTitle(title)
                .setView(sv)
                .setPositiveButton("关闭", null)
                .setNeutralButton("复制", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) {
                        Ui.copyText(CompatActivity.this, body);
                    }
                })
                .show();
    }

    private static String stripQuotes(String raw) {
        if (raw == null) return "{}";
        String s = raw.trim();
        if (s.startsWith("\"") && s.endsWith("\"") && s.length() >= 2) {
            try {
                return new org.json.JSONArray("[" + s + "]").getString(0);
            } catch (Throwable t) {
                return s.substring(1, s.length() - 1);
            }
        }
        if ("null".equals(s) || "undefined".equals(s)) return "{}";
        return s;
    }

    private void addAction(LinearLayout parent, String title, String desc,
                           View.OnClickListener l) {
        LinearLayout row = Ui.column(this);
        row.setBackgroundResource(R.drawable.bg_card);
        row.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 10);
        row.setLayoutParams(lp);
        row.setClickable(true);
        row.setOnClickListener(l);
        Ui.pressScale(row);

        TextView t = Ui.text(this, title, 15f, Ui.color(this, R.color.text_primary));
        t.setTypeface(Typeface.DEFAULT_BOLD);
        row.addView(t);
        TextView d = Ui.text(this, desc, 12.5f, Ui.color(this, R.color.text_secondary));
        d.setLineSpacing(Ui.sp(this, 3), 1f);
        LinearLayout.LayoutParams dLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dLp.topMargin = Ui.dp(this, 5);
        row.addView(d, dLp);
        parent.addView(row);
    }
}
