package com.yg.dsweb;

/**
 * 底部弹出的操作菜单。自己实现 popup，避免 PopupWindow 在 API 22 上的定位与入场动画坑。
 * 表现：半透明遮罩 + 底部圆角面板 + 若干行操作。
 */
public final class AppMenu {

    public interface Listener {
        void onNewChat();

        void onToggleAntiRecall(boolean enabled);

        void onArchive();

        void onEngine();

        void onSettings();

        void onShare();

        void onExternal();

        void onClearCache();

        void onReload();

        void onAbout();
    }

    private final android.app.Activity act;

    public AppMenu(android.app.Activity act) {
        this.act = act;
    }

    public void show(final Listener l) {
        final android.app.Dialog dlg = new android.app.Dialog(act, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        android.view.Window w = dlg.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0x00000000));
            w.setLayout(android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT);
            w.setGravity(android.view.Gravity.BOTTOM);
            w.setWindowAnimations(android.R.style.Animation_Dialog);
        }

        android.widget.FrameLayout root = new android.widget.FrameLayout(act);
        root.setBackgroundColor(0x66000000);
        root.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                dlg.dismiss();
            }
        });

        android.widget.LinearLayout panel = Ui.column(act);
        panel.setBackgroundColor(Ui.color(act, R.color.surface));
        panel.setPadding(0, Ui.dp(act, 6), 0, Ui.dp(act, 6));
        panel.setClickable(true);

        // 拖动条
        android.view.View handle = new android.view.View(act);
        android.graphics.drawable.GradientDrawable hd = Ui.roundRect(
                0xFFD1D5DB, Ui.dp(act, 2.5f));
        handle.setBackground(hd);
        android.widget.LinearLayout.LayoutParams hl = new android.widget.LinearLayout.LayoutParams(
                Ui.dp(act, 36), Ui.dp(act, 5));
        hl.topMargin = Ui.dp(act, 8);
        hl.bottomMargin = Ui.dp(act, 4);
        hl.gravity = android.view.Gravity.CENTER_HORIZONTAL;
        panel.addView(handle, hl);

        addItem(panel, dlg, "新建对话", null,
                new Runnable() {
                    @Override
                    public void run() {
                        l.onNewChat();
                    }
                });

        addItem(panel, dlg, Prefs.antiRecall() ? "防撤回：已开启" : "防撤回：已关闭",
                Prefs.antiRecall() ? "点击关闭" : "点击开启",
                new Runnable() {
                    @Override
                    public void run() {
                        l.onToggleAntiRecall(!Prefs.antiRecall());
                    }
                });

        addItem(panel, dlg, "撤回存档", "查看 / 导出被拦截的回复",
                new Runnable() {
                    @Override
                    public void run() {
                        l.onArchive();
                    }
                });

        addItem(panel, dlg, "引擎与兼容性", "查看 WebView 内核诊断",
                new Runnable() {
                    @Override
                    public void run() {
                        l.onEngine();
                    }
                });

        panel.addView(Ui.divider(act));

        addItem(panel, dlg, "重新加载", null,
                new Runnable() {
                    @Override
                    public void run() {
                        l.onReload();
                    }
                });

        addItem(panel, dlg, "分享当前页面", null,
                new Runnable() {
                    @Override
                    public void run() {
                        l.onShare();
                    }
                });

        addItem(panel, dlg, "用其它浏览器打开", null,
                new Runnable() {
                    @Override
                    public void run() {
                        l.onExternal();
                    }
                });

        addItem(panel, dlg, "清理缓存", "不影响登录状态与存档",
                new Runnable() {
                    @Override
                    public void run() {
                        l.onClearCache();
                    }
                });

        panel.addView(Ui.divider(act));

        addItem(panel, dlg, "设置", null,
                new Runnable() {
                    @Override
                    public void run() {
                        l.onSettings();
                    }
                });

        addItem(panel, dlg, "关于", null,
                new Runnable() {
                    @Override
                    public void run() {
                        l.onAbout();
                    }
                });

        // 底部安全区
        android.view.View spacer = new android.view.View(act);
        android.widget.LinearLayout.LayoutParams sl = new android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(act, 8));
        panel.addView(spacer, sl);

        android.widget.FrameLayout.LayoutParams pl = new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
        pl.gravity = android.view.Gravity.BOTTOM;
        root.addView(panel, pl);

        dlg.setContentView(root);
        dlg.setCanceledOnTouchOutside(true);
        dlg.show();
    }

    private void addItem(android.widget.LinearLayout panel, final android.app.Dialog dlg,
                         String title, String sub, final Runnable action) {
        android.widget.LinearLayout row = Ui.column(act);
        row.setPadding(Ui.dp(act, 20), Ui.dp(act, 14), Ui.dp(act, 20), Ui.dp(act, 14));
        row.setClickable(true);

        android.widget.TextView t = Ui.text(act, title, 16f, Ui.color(act, R.color.text_primary));
        row.addView(t);
        if (sub != null) {
            android.widget.TextView s = Ui.text(act, sub, 12f,
                    Ui.color(act, R.color.text_secondary));
            android.widget.LinearLayout.LayoutParams sl =
                    new android.widget.LinearLayout.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
            sl.topMargin = Ui.dp(act, 3);
            row.addView(s, sl);
        }
        row.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                dlg.dismiss();
                action.run();
            }
        });
        Ui.pressScale(row);
        panel.addView(row);
    }
}
