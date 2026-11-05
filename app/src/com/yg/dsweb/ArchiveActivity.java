package com.yg.dsweb;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 撤回存档浏览页。
 *
 * 数据来源：脚本把每条被拦截的回复写进 WebView 的 localStorage，
 * 这里通过 evaluateJavascript 读取，再由 bridge 回传 JSON。
 * 之所以不在 Java 侧直接读：localStorage 属于 WebView 的私有存储区，
 * 没有公开 API 可读，必须走 JS。
 */
public class ArchiveActivity extends Activity {

    private LinearLayout listCol;
    private TextView emptyView;
    private TextView statView;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // 兜底：整页构建过程任何异常都不能让 App 崩掉，退化成可读的错误页。
        try {
            Ui.applySystemBars(this);
            buildUi();
            loadArchive();
        } catch (Throwable t) {
            android.util.Log.e("DSWeb", "ArchiveActivity onCreate failed", t);
            try {
                LinearLayout fallback = Ui.column(this);
                fallback.setPadding(Ui.dp(this, 24), Ui.dp(this, 80), Ui.dp(this, 24), 0);
                fallback.setBackgroundColor(Ui.color(this, R.color.bg));
                fallback.addView(Ui.text(this, "存档页加载失败", 17f,
                        Ui.color(this, R.color.text_primary)));
                fallback.addView(Ui.text(this, String.valueOf(t.getMessage()), 12.5f,
                        Ui.color(this, R.color.text_secondary)));
                setContentView(fallback);
            } catch (Throwable ignored) {
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从主界面返回时刷新一次（主界面可能刚拉到新数据）
        try {
            if (ArchiveStore.has()) render(ArchiveStore.get());
        } catch (Throwable ignored) {
        }
    }

    private void buildUi() {
        LinearLayout root = Ui.column(this);
        root.setBackgroundColor(Ui.color(this, R.color.bg));
        setContentView(root);

        // 顶部栏
        LinearLayout bar = Ui.row(this);
        bar.setBackgroundColor(Ui.color(this, R.color.brand));
        bar.setPadding(Ui.dp(this, 8), 0, Ui.dp(this, 8), 0);
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 54));
        root.addView(bar, bl);

        TextView back = Ui.text(this, "←", 22f, Ui.color(this, R.color.icon_on_brand));
        back.setGravity(Gravity.CENTER);
        back.setPadding(0, 0, 0, 0);
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        bar.addView(back, new LinearLayout.LayoutParams(Ui.dp(this, 40), Ui.dp(this, 44)));

        TextView title = Ui.text(this, "撤回存档", 17f, Ui.color(this, R.color.icon_on_brand));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tl.leftMargin = Ui.dp(this, 4);
        bar.addView(title, tl);

        TextView refresh = Ui.text(this, "刷新", 14f, Ui.color(this, R.color.icon_on_brand));
        refresh.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadArchive();
            }
        });
        bar.addView(refresh);

        TextView clear = Ui.text(this, "清空", 14f, Ui.color(this, R.color.icon_on_brand));
        clear.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        clear.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                confirmClear();
            }
        });
        bar.addView(clear);

        statView = Ui.text(this, "读取中…", 12f, Ui.color(this, R.color.text_secondary));
        statView.setPadding(Ui.dp(this, 18), Ui.dp(this, 12), Ui.dp(this, 18), Ui.dp(this, 10));
        root.addView(statView);

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        root.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        listCol = Ui.column(this);
        listCol.setPadding(Ui.dp(this, 16), Ui.dp(this, 4), Ui.dp(this, 16), Ui.dp(this, 30));
        sv.addView(listCol, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        emptyView = Ui.text(this, "暂无存档。\n\n当一条回复被拦截时，原文会自动保存在这里。",
                13f, Ui.color(this, R.color.text_secondary));
        emptyView.setGravity(Gravity.CENTER);
        emptyView.setLineSpacing(Ui.sp(this, 5), 1f);
        emptyView.setPadding(Ui.dp(this, 24), Ui.dp(this, 80), Ui.dp(this, 24), 0);
        listCol.addView(emptyView);
    }

    /**
     * 读取存档。
     *
     * 三级取数策略（避免"主界面被回收就打不开"）：
     *   1) 先用 ArchiveStore 里的快照立刻渲染（有就马上显示）；
     *   2) 若主界面还活着，再异步请求一次最新数据并刷新；
     *   3) 两者都没有才提示用户。
     */
    private void loadArchive() {
        // 1) 有快照先渲染，保证立刻有内容
        if (ArchiveStore.has()) {
            render(ArchiveStore.get());
        }

        // 2) 尝试拉最新
        MainActivity host = MainActivity.instance();
        if (host == null || host.getWebView() == null) {
            if (!ArchiveStore.has()) {
                statView.setText("暂无可显示的数据。\n请先返回主界面打开一次对话页面。");
            } else {
                long ts = ArchiveStore.updatedAt();
                statView.setText("共 " + countItems(ArchiveStore.get()) + " 条"
                        + " · 快照于 " + Ui.relTime(ts));
            }
            return;
        }

        String js = "(function(){try{"
                + "if(!window.__DS_SHELL__){return JSON.stringify({error:'shell-missing'});}"
                + "var a=window.__DS_SHELL__.exportArchive();"
                + "return typeof a==='string'?a:JSON.stringify(a);"
                + "}catch(e){return JSON.stringify({error:String(e)});}})();";
        host.evaluateJsForResult(js, new MainActivity.JsResult() {
            @Override
            public void onResult(String value) {
                try {
                    String j = unquote(value);
                    JSONObject probe = new JSONObject(j);
                    if (probe.has("error")) {
                        if (!ArchiveStore.has()) {
                            statView.setText("读取失败：" + probe.optString("error")
                                    + "\n（可直接返回主界面重试）");
                        }
                        return;
                    }
                    ArchiveStore.put(j);
                } catch (Throwable ignored) {
                }
                render(value);
            }
        });
    }

    private int countItems(String json) {
        try {
            JSONObject o = new JSONObject(json);
            JSONArray arr = o.optJSONArray("items");
            return arr == null ? 0 : arr.length();
        } catch (Throwable t) {
            return 0;
        }
    }

    private void render(String raw) {
        listCol.removeAllViews();
        List<ArchiveEntry> entries = new ArrayList<ArchiveEntry>();
        try {
            String json = unquote(raw);
            JSONObject o = new JSONObject(json);
            if (o.has("error")) {
                statView.setText("读取失败：" + o.optString("error"));
                return;
            }
            JSONArray arr = o.optJSONArray("items");
            if (arr == null) arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject it = arr.optJSONObject(i);
                if (it == null) continue;
                entries.add(ArchiveEntry.parse(it));
            }
        } catch (Throwable t) {
            statView.setText("解析失败：" + t.getMessage());
            return;
        }

        if (entries.isEmpty()) {
            statView.setText("共 0 条");
            listCol.addView(emptyView);
            return;
        }
        statView.setText("共 " + entries.size() + " 条 · 仅存于本机");
        for (ArchiveEntry e : entries) {
            listCol.addView(buildCard(e));
        }
    }

    private View buildCard(final ArchiveEntry e) {
        LinearLayout card = Ui.column(this);
        card.setBackgroundResource(R.drawable.bg_card);
        card.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = Ui.dp(this, 10);
        card.setLayoutParams(lp);

        // 头部：时间 + 原因
        LinearLayout head = Ui.row(this);
        TextView time = Ui.text(this, Ui.relTime(e.ts), 12f,
                Ui.color(this, R.color.text_secondary));
        head.addView(time);
        TextView reason = Ui.text(this, "  ·  " + e.reasonLabel(), 12f,
                Ui.color(this, R.color.badge_bg));
        head.addView(reason);
        card.addView(head);

        // 预览
        TextView preview = Ui.text(this, e.preview, 14f,
                Ui.color(this, R.color.text_primary));
        preview.setLineSpacing(Ui.sp(this, 4), 1f);
        preview.setMaxLines(6);
        preview.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams pl = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pl.topMargin = Ui.dp(this, 8);
        card.addView(preview, pl);

        // 操作
        LinearLayout actions = Ui.row(this);
        LinearLayout.LayoutParams al = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        al.topMargin = Ui.dp(this, 10);
        card.addView(actions, al);

        actions.addView(actionBtn("查看全文", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showFull(e);
            }
        }));
        actions.addView(actionBtn("复制", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Ui.copyText(ArchiveActivity.this, e.fullText);
            }
        }));
        actions.addView(actionBtn("删除", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                deleteEntry(e);
            }
        }));

        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showFull(e);
            }
        });
        return card;
    }

    private View actionBtn(String s, View.OnClickListener l) {
        TextView t = Ui.text(this, s, 13f, Ui.color(this, R.color.accent_text));
        t.setPadding(0, Ui.dp(this, 6), Ui.dp(this, 22), Ui.dp(this, 6));
        t.setOnClickListener(l);
        return t;
    }

    private void showFull(ArchiveEntry e) {
        ScrollView sv = new ScrollView(this);
        TextView tv = Ui.text(this, e.fullText, 14f, Ui.color(this, R.color.text_primary));
        tv.setTextIsSelectable(true);
        tv.setLineSpacing(Ui.sp(this, 5), 1f);
        tv.setPadding(Ui.dp(this, 20), Ui.dp(this, 16), Ui.dp(this, 20), Ui.dp(this, 16));
        sv.addView(tv);

        new AlertDialog.Builder(this)
                .setTitle(e.sessionTitle.length() > 0 ? e.sessionTitle : "撤回的回复")
                .setView(sv)
                .setPositiveButton("关闭", null)
                .setNeutralButton("复制全文", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        Ui.copyText(ArchiveActivity.this, e.fullText);
                    }
                })
                .show();
    }

    private void deleteEntry(ArchiveEntry e) {
        MainActivity host = MainActivity.instance();
        if (host == null || host.getWebView() == null) return;
        String js = "(function(){try{return window.__DS_SHELL__.removeArchive("
                + JSONObject.quote(e.sessId) + "," + e.msgId + ");}catch(e){return false;}})();";
        host.evaluateJsForResult(js, new MainActivity.JsResult() {
            @Override
            public void onResult(String value) {
                loadArchive();
            }
        });
    }

    private void confirmClear() {
        new AlertDialog.Builder(this)
                .setTitle("清空全部存档")
                .setMessage("这会永久删除本机保存的所有撤回原文，无法恢复。")
                .setNegativeButton("取消", null)
                .setPositiveButton("清空", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        MainActivity host = MainActivity.instance();
                        if (host == null || host.getWebView() == null) return;
                        host.evaluateJsForResult(
                                "(function(){try{return window.__DS_SHELL__.clearArchive();}"
                                        + "catch(e){return false;}})();",
                                new MainActivity.JsResult() {
                                    @Override
                                    public void onResult(String value) {
                                        loadArchive();
                                    }
                                });
                    }
                })
                .show();
    }

    /** evaluateJavascript 返回的是带引号的 JSON 字符串字面量，这里剥一层 */
    private static String unquote(String raw) {
        if (raw == null) return "{}";
        String s = raw.trim();
        if (s.startsWith("\"") && s.endsWith("\"") && s.length() >= 2) {
            try {
                return new JSONArray("[" + s + "]").getString(0);
            } catch (Throwable t) {
                return s.substring(1, s.length() - 1);
            }
        }
        if ("null".equals(s) || "undefined".equals(s)) return "{}";
        return s;
    }

    // ============================================================

    static final class ArchiveEntry {
        String sessId = "";
        long msgId = 0;
        long ts = 0;
        String reason = "";
        String sessionTitle = "";
        String preview = "";
        String fullText = "";

        static ArchiveEntry parse(JSONObject o) {
            ArchiveEntry e = new ArchiveEntry();
            e.sessId = o.optString("sessId", o.optString("sess_id", ""));
            e.msgId = o.optLong("msgId", o.optLong("msg_id", 0));
            e.ts = o.optLong("ts", 0);
            e.reason = o.optString("reason", "");
            e.sessionTitle = o.optString("title", "");
            e.preview = o.optString("preview", "");
            e.fullText = o.optString("text", o.optString("fullText", ""));
            if (e.fullText.length() == 0) e.fullText = e.preview;
            if (e.preview.length() == 0 && e.fullText.length() > 0) {
                e.preview = e.fullText.length() > 120
                        ? e.fullText.substring(0, 120) + "…" : e.fullText;
            }
            return e;
        }

        String reasonLabel() {
            if ("TEMPLATE_RESPONSE".equals(reason)) return "被拦截";
            if ("CONTENT_FILTER".equals(reason)) return "内容过滤";
            return reason.length() > 0 ? reason : "未知";
        }
    }
}
