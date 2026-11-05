package com.yg.dsweb;

import android.app.Activity;

/**
 * 构建期/运行期一致性守卫。
 *
 * 为什么需要它：
 *   ArchiveActivity 曾经"写了类但忘了在 AndroidManifest 里登记"，
 *   结果点"查看存档"直接抛 ActivityNotFoundException 闪退。
 *   这类问题编译器不会报，跑起来才炸，而且只在点那个入口时才炸。
 *
 *   这里在启动时做一次自检，把"代码里有 Activity 类 / manifest 没声明"
 *   这种不一致提前暴露成一条明确日志，而不是等用户点进去才闪退。
 *
 * 同时提供一个安全启动包装：任何 Activity 启动失败都转成 Toast，
 * 不再让整个 App 崩掉。
 */
public final class ActivityGuard {

    private ActivityGuard() {
    }

    /** 需要自检的 Activity 类名（新增 Activity 时请同步加到这里） */
    private static final String[] EXPECTED = {
            ".MainActivity",
            ".CompatActivity",
            ".SettingsActivity",
            ".ArchiveActivity"
    };

    /**
     * 自检：逐个尝试解析 Intent，确认 manifest 里确实声明了。
     * 返回未声明的清单（空数组表示全 OK）。
     */
    public static String[] findUndeclared() {
        java.util.ArrayList<String> missing = new java.util.ArrayList<String>();
        android.content.Context ctx = App.ctx();
        for (int i = 0; i < EXPECTED.length; i++) {
            String cls = App.ctx().getPackageName() + EXPECTED[i];
            try {
                android.content.Intent probe = new android.content.Intent();
                probe.setClassName(ctx.getPackageName(), cls);
                if (ctx.getPackageManager().resolveActivity(probe, 0) == null) {
                    missing.add(cls);
                }
            } catch (Throwable t) {
                missing.add(cls + " (" + t.getClass().getSimpleName() + ")");
            }
        }
        return missing.toArray(new String[0]);
    }

    /** 启动 Activity，失败时提示而不是崩溃 */
    public static boolean start(Activity from, Class<?> target) {
        try {
            from.startActivity(new android.content.Intent(from, target));
            return true;
        } catch (Throwable t) {
            android.util.Log.e("DSWeb", "startActivity failed: " + target, t);
            // 再试一次用显式组件名（某些 ROM 对 Class 形式解析异常）
            try {
                android.content.Intent i = new android.content.Intent();
                i.setClassName(from.getPackageName(), target.getName());
                from.startActivity(i);
                return true;
            } catch (Throwable t2) {
                Ui.toast(from, "无法打开页面：" + target.getSimpleName());
                return false;
            }
        }
    }
}
