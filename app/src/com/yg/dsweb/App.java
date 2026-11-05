package com.yg.dsweb;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.webkit.CookieManager;

/**
 * 应用入口。
 *
 * 单例只持有 Application Context，禁止在此处创建 WebView（多进程/预加载会炸）。
 * 退出前台时统一 flush Cookie，规避 Android 5.x CookieManager 的经典丢 Cookie 问题。
 */
public class App extends Application {

    private static App sInstance;

    public static App get() {
        return sInstance;
    }

    public static Context ctx() {
        return sInstance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        Prefs.init(this);
        EngineInfo.init(this);
        CrashGuard.install();

        // 自检：Activity 类存在但 manifest 未声明 → 一点就闪退。
        // 这类问题编译器不报，必须在启动时暴露出来。
        String[] missing = ActivityGuard.findUndeclared();
        if (missing.length > 0) {
            StringBuilder sb = new StringBuilder("AndroidManifest 缺少 Activity 声明: ");
            for (String m : missing) sb.append(m).append(' ');
            android.util.Log.e("DSWeb", sb.toString());
        }
    }

    /** 把内存中的 Cookie 落盘；5.x 与 7+ 都需要显式调用才稳。 */
    public static void flushCookies() {
        try {
            CookieManager.getInstance().flush();
        } catch (Throwable ignored) {
            // 某些 ROM 的 CookieManager 未初始化会抛，忽略
        }
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= TRIM_MEMORY_UI_HIDDEN) {
            flushCookies();
        }
    }

    /**
     * 当前 WebView 的实现包名，用于提示用户升级。
     * API 26+ 改用 WebView.getCurrentWebViewPackage()，低版本走回退探测。
     */
    public static String webViewPackageName() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                android.webkit.WebView pkg = null;
                try {
                    Object p = android.webkit.WebView.class
                            .getMethod("getCurrentWebViewPackage")
                            .invoke(null);
                    if (p instanceof android.content.pm.PackageInfo) {
                        return ((android.content.pm.PackageInfo) p).packageName;
                    }
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
        // 低版本：检查哪个包存在
        String[] candidates = {
                "com.google.android.webview",
                "com.android.webview",
                "com.android.chrome"
        };
        for (String name : candidates) {
            try {
                get().getPackageManager().getPackageInfo(name, 0);
                return name;
            } catch (Throwable ignored) {
            }
        }
        return "unknown";
    }
}
