package com.yg.dsweb;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 设置 / 关于页。
 *
 * 刻意做成纯代码视图：不带 AndroidX Preference，避免引入依赖树；
 * 每一项都是"开关 + 说明"，让用户知道开关背后的实际影响。
 */
public class SettingsActivity extends Activity {

    private boolean aboutMode;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Ui.applySystemBars(this);
        aboutMode = getIntent() != null && getIntent().getBooleanExtra("about", false);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Ui.color(this, R.color.bg));
        setContentView(sv);

        LinearLayout col = Ui.column(this);
        col.setPadding(Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 36));
        sv.addView(col, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 返回
        TextView back = Ui.text(this, "← 返回", 15f, Ui.color(this, R.color.accent_text));
        back.setPadding(0, Ui.dp(this, 4), 0, Ui.dp(this, 12));
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        col.addView(back);

        TextView title = Ui.text(this, aboutMode ? "关于" : "设置", 24f,
                Ui.color(this, R.color.text_primary));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);

        if (aboutMode) {
            buildAbout(col);
        } else {
            buildSettings(col);
        }
    }

    // ============================================================

    private void buildSettings(LinearLayout col) {
        // ---- 防撤回 ----
        col.addView(section("防 撤 回"));
        addSwitch(col, "启用防撤回拦截",
                "在响应流被服务端改写成“已屏蔽/已撤回”时，本地替换为提示并保留原文。关闭后完全旁路，零性能开销。",
                Prefs.antiRecall(), new OnToggle() {
                    @Override
                    public void onChanged(boolean v) {
                        Prefs.setAntiRecall(v);
                    }
                });

        addSwitch(col, "启动时即注入",
                "在 HTML 到达 WebView 之前插入钩子脚本，保证能拦截第一次请求。关闭后仅在页面就绪后注入（会漏掉首轮）。",
                Prefs.injectOnPageStart(), new OnToggle() {
                    @Override
                    public void onChanged(boolean v) {
                        Prefs.setInjectOnPageStart(v);
                    }
                });

        addAction(col, "查看撤回存档",
                "浏览所有被拦截回复的原文（本地存储，不上传）。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        ActivityGuard.start(SettingsActivity.this, ArchiveActivity.class);
                    }
                });

        addAction(col, "导出存档为 JSON",
                "把全部存档写到你选择的目录，便于备份。",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Ui.toast(SettingsActivity.this, "请在主界面菜单中执行导出");
                    }
                });

        // ---- 界面 ----
        col.addView(section("界 面"));
        addSwitch(col, "显示兼容提示横幅",
                "当 WebView 内核低于推荐版本时，在主界面顶部提示。",
                Prefs.showBanner(), new OnToggle() {
                    @Override
                    public void onChanged(boolean v) {
                        Prefs.setShowBanner(v);
                    }
                });

        addSwitch(col, "保持屏幕常亮",
                "阅读长回答时不自动息屏。会略微增加耗电。",
                Prefs.keepScreenOn(), new OnToggle() {
                    @Override
                    public void onChanged(boolean v) {
                        Prefs.setKeepScreenOn(v);
                    }
                });

        // ---- 高级 ----
        col.addView(section("高 级"));
        addSwitch(col, "详细日志",
                "把前端钩子与注入过程写入 logcat（tag: DSWeb / DSWebJS）。",
                Prefs.debugLog(), new OnToggle() {
                    @Override
                    public void onChanged(boolean v) {
                        Prefs.setDebugLog(v);
                    }
                });

        addAction(col, "自定义 User-Agent",
                "当前: " + abbrev(EngineInfo.userAgent(), 70),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        showUaDialog();
                    }
                });

        addAction(col, "引擎与兼容性",
                EngineInfo.gradeLabel(),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        ActivityGuard.start(SettingsActivity.this, CompatActivity.class);
                    }
                });

        addAction(col, "重置撤回计数",
                "当前计数: " + Prefs.recallCount(),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Prefs.resetRecallCount();
                        Ui.toast(SettingsActivity.this, "已重置");
                        recreate();
                    }
                });

        addAction(col, "查看最近一次崩溃",
                CrashGuard.lastCrash() == null ? "无记录" : "有记录，点击查看",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        String s = CrashGuard.lastCrash();
                        if (s == null) {
                            Ui.toast(SettingsActivity.this, "没有崩溃记录");
                        } else {
                            new android.app.AlertDialog.Builder(SettingsActivity.this)
                                    .setTitle("最近一次崩溃")
                                    .setMessage(s)
                                    .setPositiveButton("关闭", null)
                                    .setNeutralButton("清除", new android.content.DialogInterface.OnClickListener() {
                                        @Override
                                        public void onClick(android.content.DialogInterface d, int w) {
                                            CrashGuard.clear();
                                        }
                                    })
                                    .show();
                        }
                    }
                });
    }

    // ============================================================

    private void buildAbout(LinearLayout col) {
        LinearLayout card = card();
        TextView name = Ui.text(this, "DeepSeek 网页版外壳", 18f,
                Ui.color(this, R.color.text_primary));
        name.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(name);

        TextView ver = Ui.text(this, buildVersionLine(), 12.5f,
                Ui.color(this, R.color.text_secondary));
        ver.setLineSpacing(Ui.sp(this, 4), 1f);
        LinearLayout.LayoutParams vLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vLp.topMargin = Ui.dp(this, 8);
        card.addView(ver, vLp);
        col.addView(card);

        col.addView(section("说 明"));
        LinearLayout c2 = card();
        TextView t = Ui.text(this,
                "本应用不修改、不代理、不缓存服务端内容，只是把官方网页放进系统 WebView 并加了一层界面。"
                        + "防撤回功能的原理是在页面内部拦截 XHR 响应流：当服务端把一条消息改写成"
                        + "“已屏蔽”时，本地用先前收到的完整内容替换，并把原文存入本机 localStorage。"
                        + "\n\n所有存档只存在你的设备上，本应用不联网上传任何对话内容。",
                13f, Ui.color(this, R.color.text_secondary));
        t.setLineSpacing(Ui.sp(this, 5), 1f);
        c2.addView(t);
        col.addView(c2);

        col.addView(section("开 源 信 息"));
        LinearLayout c3 = card();
        TextView t3 = Ui.text(this,
                "防撤回逻辑参考并重写了 GreasyFork 上 Franky T 的 “DeepSeek Anti-recall” 脚本思路"
                        + "（XHR getter 钩子 + SSE 状态机 + localStorage 存档），"
                        + "针对当前线上版本（commit 26090614）做了增量解析、"
                        + "resume_stream 边界、fetch 兜底与存档结构升级。",
                13f, Ui.color(this, R.color.text_secondary));
        t3.setLineSpacing(Ui.sp(this, 5), 1f);
        c3.addView(t3);
        col.addView(c3);
    }

    private String buildVersionLine() {
        StringBuilder sb = new StringBuilder();
        sb.append("版本 1.0.0  ·  包名 ").append(getPackageName());
        sb.append('\n').append("minSdk 22（Android 5.1）  ·  targetSdk 34");
        sb.append('\n').append("WebView: ").append(EngineInfo.webViewPackage())
                .append("  Chromium ").append(EngineInfo.chromeMajor() < 0
                        ? "?" : String.valueOf(EngineInfo.chromeMajor()));
        sb.append('\n').append("设备: ").append(android.os.Build.MANUFACTURER)
                .append(' ').append(android.os.Build.MODEL)
                .append("  Android ").append(android.os.Build.VERSION.RELEASE);
        return sb.toString();
    }

    // ============================================================

    private interface OnToggle {
        void onChanged(boolean v);
    }

    private LinearLayout card() {
        LinearLayout c = Ui.column(this);
        c.setBackgroundResource(R.drawable.bg_card);
        c.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 10);
        c.setLayoutParams(lp);
        return c;
    }

    private TextView section(String s) {
        TextView t = Ui.text(this, s, 12f, Ui.color(this, R.color.text_secondary));
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLetterSpacing(0.06f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 26);
        lp.bottomMargin = Ui.dp(this, 2);
        t.setLayoutParams(lp);
        return t;
    }

    private void addSwitch(LinearLayout parent, String title, String desc,
                           boolean initial, final OnToggle cb) {
        LinearLayout rowCard = Ui.row(this);
        rowCard.setBackgroundResource(R.drawable.bg_card);
        rowCard.setPadding(Ui.dp(this, 16), Ui.dp(this, 13), Ui.dp(this, 14), Ui.dp(this, 13));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 10);
        rowCard.setLayoutParams(lp);

        LinearLayout textCol = Ui.column(this);
        TextView t = Ui.text(this, title, 15f, Ui.color(this, R.color.text_primary));
        t.setTypeface(Typeface.DEFAULT_BOLD);
        textCol.addView(t);
        TextView d = Ui.text(this, desc, 12f, Ui.color(this, R.color.text_secondary));
        d.setLineSpacing(Ui.sp(this, 3), 1f);
        LinearLayout.LayoutParams dLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dLp.topMargin = Ui.dp(this, 4);
        textCol.addView(d, dLp);

        LinearLayout.LayoutParams tLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        rowCard.addView(textCol, tLp);

        final SwitchButton sw = new SwitchButton(this, initial);
        LinearLayout.LayoutParams sLp = new LinearLayout.LayoutParams(
                Ui.dp(this, 48), Ui.dp(this, 28));
        sLp.leftMargin = Ui.dp(this, 12);
        rowCard.addView(sw, sLp);

        sw.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                sw.toggle();
                cb.onChanged(sw.isChecked());
            }
        });
        // 整行也可点
        rowCard.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                sw.toggle();
                cb.onChanged(sw.isChecked());
            }
        });
        parent.addView(rowCard);
    }

    private void addAction(LinearLayout parent, String title, String desc,
                           View.OnClickListener l) {
        LinearLayout rowCard = Ui.column(this);
        rowCard.setBackgroundResource(R.drawable.bg_card);
        rowCard.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 10);
        rowCard.setLayoutParams(lp);
        rowCard.setOnClickListener(l);
        rowCard.setClickable(true);
        Ui.pressScale(rowCard);

        TextView t = Ui.text(this, title, 15f, Ui.color(this, R.color.text_primary));
        t.setTypeface(Typeface.DEFAULT_BOLD);
        rowCard.addView(t);
        if (desc != null && desc.length() > 0) {
            TextView d = Ui.text(this, desc, 12f, Ui.color(this, R.color.text_secondary));
            d.setLineSpacing(Ui.sp(this, 3), 1f);
            LinearLayout.LayoutParams dLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            dLp.topMargin = Ui.dp(this, 4);
            rowCard.addView(d, dLp);
        }
        parent.addView(rowCard);
    }

    private void showUaDialog() {
        final EditText et = new EditText(this);
        et.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        et.setText(Prefs.uaOverride() == null ? EngineInfo.userAgent() : Prefs.uaOverride());
        et.setTextSize(12f);
        et.setPadding(Ui.dp(this, 14), Ui.dp(this, 10), Ui.dp(this, 14), Ui.dp(this, 10));

        new android.app.AlertDialog.Builder(this)
                .setTitle("自定义 User-Agent")
                .setMessage("留空则使用系统默认。修改后需重启 App 生效。")
                .setView(et)
                .setNegativeButton("取消", null)
                .setNeutralButton("恢复默认", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) {
                        Prefs.setUaOverride(null);
                        Ui.toast(SettingsActivity.this, "已恢复默认，重启后生效");
                    }
                })
                .setPositiveButton("保存", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) {
                        String s = et.getText().toString().trim();
                        Prefs.setUaOverride(s.length() == 0 ? null : s);
                        Ui.toast(SettingsActivity.this, "已保存，重启后生效");
                    }
                })
                .show();
    }

    private static String abbrev(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    // ---- 自绘开关：避免依赖 AndroidX SwitchCompat，且样式统一 ----
    static class SwitchButton extends View {
        private boolean checked;
        private final android.graphics.Paint paint = new android.graphics.Paint(
                android.graphics.Paint.ANTI_ALIAS_FLAG);

        SwitchButton(android.content.Context c, boolean init) {
            super(c);
            checked = init;
        }

        boolean isChecked() {
            return checked;
        }

        void toggle() {
            checked = !checked;
            animate().cancel();
            invalidate();
        }

        @Override
        protected void onDraw(android.graphics.Canvas canvas) {
            super.onDraw(canvas);
            int w = getWidth(), h = getHeight();
            float r = h / 2f;
            int onColor = Ui.color(getContext(), R.color.brand);
            int offColor = 0xFFD1D5DB;
            paint.setColor(checked ? onColor : offColor);
            canvas.drawRoundRect(0, 0, w, h, r, r, paint);

            float knobR = r - Ui.dp(getContext(), 2.5f);
            float cx = checked ? w - r : r;
            paint.setColor(0x33000000);
            canvas.drawCircle(cx, r + Ui.dp(getContext(), 1f), knobR, paint);
            paint.setColor(0xFFFFFFFF);
            canvas.drawCircle(cx, r, knobR, paint);
        }
    }
}
