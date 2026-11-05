package com.yg.dsweb;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 纯代码 UI 工具。目标是：不依赖 AndroidX、不写复杂 layout xml、在 API 22 上视觉一致。
 */
public final class Ui {

    private Ui() {
    }

    public static int dp(Context c, float v) {
        return (int) (v * c.getResources().getDisplayMetrics().density + 0.5f);
    }

    public static float sp(Context c, float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v,
                c.getResources().getDisplayMetrics());
    }

    public static int color(Context c, int res) {
        return c.getResources().getColor(res);
    }

    public static int statusBarHeight(Context c) {
        int id = c.getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (id > 0) {
            return c.getResources().getDimensionPixelSize(id);
        }
        return dp(c, 24);
    }

    public static void toast(Context c, CharSequence s) {
        Toast.makeText(c, s, Toast.LENGTH_SHORT).show();
    }

    public static LinearLayout column(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(android.view.Gravity.CENTER_VERTICAL);
        return l;
    }

    public static TextView text(Context c, CharSequence s, float spSize, int color) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(spSize);
        t.setTextColor(color);
        return t;
    }

    public static View divider(Context c) {
        View v = new View(c);
        v.setBackgroundColor(color(c, R.color.divider));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(c, 0.7f));
        v.setLayoutParams(lp);
        return v;
    }

    /** 圆角实心背景 */
    public static GradientDrawable roundRect(int fill, float radiusPx) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(fill);
        d.setCornerRadius(radiusPx);
        return d;
    }

    /** 按下态水波纹（API 21+ 原生支持） */
    public static RippleDrawable ripple(int maskColor, float radiusPx, int contentColor) {
        GradientDrawable mask = roundRect(0xFFFFFFFF, radiusPx);
        GradientDrawable content = roundRect(contentColor, radiusPx);
        return new RippleDrawable(android.content.res.ColorStateList.valueOf(maskColor),
                content, mask);
    }

    public static StateListDrawable pressedBg(int normal, int pressed, float radiusPx) {
        StateListDrawable d = new StateListDrawable();
        GradientDrawable p = roundRect(pressed, radiusPx);
        d.addState(new int[]{android.R.attr.state_pressed}, p);
        d.addState(new int[]{}, roundRect(normal, radiusPx));
        return d;
    }

    /** 列表行：标题 + 可选副标题 + 右侧箭头/开关 */
    public static LinearLayout listRow(Context c, CharSequence title, CharSequence sub) {
        LinearLayout row = row(c);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(c, 18), dp(c, 14), dp(c, 18), dp(c, 14));
        TextView t = text(c, title, 16f, color(c, R.color.text_primary));
        row.addView(t);
        if (sub != null && sub.length() > 0) {
            TextView s = text(c, sub, 12.5f, color(c, R.color.text_secondary));
            s.setPadding(0, dp(c, 4), 0, 0);
            row.addView(s);
        }
        return row;
    }

    public static void applySystemBars(Activity a) {
        try {
            a.getWindow().setStatusBarColor(color(a, R.color.brand));
            a.getWindow().setNavigationBarColor(color(a, R.color.bg));
        } catch (Throwable ignored) {
        }
        if (Build.VERSION.SDK_INT >= 21 && isLightBrand()) {
            // 品牌蓝偏深，用浅色（白）状态栏图标
            a.getWindow().getDecorView().setSystemUiVisibility(0);
        }
    }

    public static boolean isLightBrand() {
        int brand = 0xFF4D6BFE;
        int r = (brand >> 16) & 0xFF, g = (brand >> 8) & 0xFF, b = brand & 0xFF;
        double lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return lum > 160; // 亮色底 → 需要深色图标
    }

    /** 简单相对时间 */
    public static String relTime(long ts) {
        long d = System.currentTimeMillis() - ts;
        if (d < 60_000L) return "刚刚";
        if (d < 3_600_000L) return (d / 60_000L) + " 分钟前";
        if (d < 86_400_000L) return (d / 3_600_000L) + " 小时前";
        if (d < 30L * 86_400_000L) return (d / 86_400_000L) + " 天前";
        return (d / (30L * 86_400_000L)) + " 个月前";
    }

    public static String humanSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024 * 1024) return String.format("%.1f MB", bytes / (1024.0 * 1024));
        return String.format("%.2f GB", bytes / (1024.0 * 1024 * 1024));
    }

    public static void openUrl(Context c, String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Throwable t) {
            toast(c, "无法打开链接");
        }
    }

    public static void copyText(Context c, CharSequence s) {
        try {
            android.content.ClipboardManager cm = (android.content.ClipboardManager)
                    c.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(android.content.ClipData.newPlainText("text", s));
            toast(c, c.getString(R.string.toast_copied));
        } catch (Throwable t) {
            toast(c, "复制失败");
        }
    }

    /** 让某个 View 的触摸更"跟手"：点击时轻微缩放 */
    public static void pressScale(final View v) {
        v.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View view, android.view.MotionEvent e) {
                switch (e.getActionMasked()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        view.animate().scaleX(0.94f).scaleY(0.94f).setDuration(90).start();
                        break;
                    case android.view.MotionEvent.ACTION_UP:
                    case android.view.MotionEvent.ACTION_CANCEL:
                        view.animate().scaleX(1f).scaleY(1f).setDuration(120).start();
                        break;
                }
                return false;
            }
        });
    }

    public static int alpha(int color, float a) {
        int aa = (int) (255 * a);
        return Color.argb(aa, Color.red(color), Color.green(color), Color.blue(color));
    }
}
