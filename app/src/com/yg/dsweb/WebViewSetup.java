package com.yg.dsweb;

import android.annotation.TargetApi;
import android.app.Activity;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * WebView 配置集中处。
 *
 * 这里的每一项都是踩过坑的选择，注释里写清"为什么"，
 * 因为本项目要求兼容 API 22，很多默认值在新旧系统上语义不同。
 */
public final class WebViewSetup {

    private WebViewSetup() {
    }

    /** 目标站点能力基线；拿不到真实 UA 时用它兜底。 */
    public static final String BASE_UA =
            "Mozilla/5.0 (Linux; Android %s; %s Build/%s) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/%s.0.0.0 Mobile Safari/537.36";

    /**
     * 构造一个已经调好参数的 WebView。
     * 注意：调用方必须在 Activity 的 Context 下创建（主题/资源解析需要），
     * 并自行把它加进视图树后再加载 URL。
     */
    @SuppressWarnings({"deprecation", "SetJavaScriptEnabled"})
    public static WebView create(Activity act) {
        WebView wv = null;

        try {
            wv = new WebView(act);
        } catch (Throwable t) {
            // 极少数机器 WebView 缺失（系统包被裁掉）
            throw new IllegalStateException("当前设备没有可用的 WebView 组件", t);
        }

        WebSettings s = wv.getSettings();

        // —— 基础能力 ——
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // localStorage：防撤回存档必须
        // —— 缩放 ——
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                           // 防止系统字号放大把布局撑爆

        // —— 视口与适配 ——
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        // —— 缓存：默认走服务端策略，避免"永远看不到新回复" ——
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // —— 混合内容：站点全 HTTPS，禁止明文即可（更安全） ——
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        // —— 存储与数据库 ——
        try {
            s.setDatabaseEnabled(true);
        } catch (Throwable ignored) {
        }

        // —— 文件访问 ——
        s.setAllowFileAccess(false);                  // 站点不需要，关掉更安全
        s.setAllowContentAccess(false);
        if (Build.VERSION.SDK_INT >= 16) {
            s.setAllowFileAccessFromFileURLs(false);
            s.setAllowUniversalAccessFromFileURLs(false);
        }

        // —— 定位/地理 ——
        s.setGeolocationEnabled(false);

        // —— 媒体 ——
        if (Build.VERSION.SDK_INT >= 17) {
            s.setMediaPlaybackRequiresUserGesture(true);
        }
        s.setJavaScriptCanOpenWindowsAutomatically(false);

        // —— 保存表单：登录态更稳 ——
        s.setSaveFormData(true);
        s.setSavePassword(false);

        // —— 字体与渲染 ——
        if (Build.VERSION.SDK_INT >= 21) {
            s.setOffscreenPreRaster(true);
        }

        // —— UA：必须伪装成移动浏览器，站点才会给移动布局 ——
        s.setUserAgentString(buildUserAgent(act));

        // —— 滚动条与过度滚动 ——
        wv.setVerticalScrollBarEnabled(true);
        wv.setHorizontalScrollBarEnabled(false);
        wv.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);

        // —— 背景色：避免首帧白/黑闪 ——
        wv.setBackgroundColor(Ui.color(act, R.color.bg));
        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        return wv;
    }

    /**
     * UA 构造。关键点：保留系统真实 UA 里已有的 WebView 版本信息，
     * 只把机型与 Android 版本段替换掉——部分风控会校验 Chrome 大版本与 UA 其余字段的一致性。
     */
    public static String buildUserAgent(Activity act) {
        String custom = Prefs.uaOverride();
        if (custom != null && custom.trim().length() > 0) {
            return custom.trim();
        }
        android.content.Context ctx = act != null ? act : App.ctx();
        String real = null;
        try {
            real = WebSettings.getDefaultUserAgent(ctx);
        } catch (Throwable t) {
            real = null;
        }
        if (real != null && real.length() > 0) {
            int m = EngineInfo.parseChromeMajor(real);
            // 真实 UA 只有在标记为移动端、且 Chrome 版本合理时才原样使用
            if (real.contains("Mobile") && m > 0) {
                return real;
            }
            if (m > 0) {
                return real.replace(" Safari/537.36", " Mobile Safari/537.36")
                        .replace("Safari/537.36 Mah", "Mobile Safari/537.36 Mah");
            }
        }
        int chromeVer = EngineInfo.chromeMajor();
        if (chromeVer <= 0) chromeVer = 80;
        return String.format(BASE_UA,
                Build.VERSION.RELEASE,
                sanitizeModel(Build.MODEL),
                sanitizeModel(Build.ID),
                chromeVer);
    }

    private static String sanitizeModel(String s) {
        if (s == null) return "unknown";
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == ';' || c == '(' || c == ')' || c == '"' || c == ' ') sb.append('_');
            else sb.append(c);
        }
        String r = sb.toString().trim();
        return r.length() == 0 ? "unknown" : r;
    }

    /** 安全销毁：先从视图树摘除，再 destroy，最后置空。 */
    public static void destroy(WebView wv) {
        if (wv == null) return;
        try {
            ViewGroup parent = (ViewGroup) wv.getParent();
            if (parent != null) parent.removeView(wv);
        } catch (Throwable ignored) {
        }
        try {
            wv.stopLoading();
        } catch (Throwable ignored) {
        }
        try {
            wv.setWebChromeClient(null);
            wv.setWebViewClient(null);
        } catch (Throwable ignored) {
        }
        try {
            wv.loadUrl("about:blank");
        } catch (Throwable ignored) {
        }
        try {
            wv.clearHistory();
        } catch (Throwable ignored) {
        }
        try {
            wv.removeAllViews();
        } catch (Throwable ignored) {
        }
        try {
            wv.destroy();
        } catch (Throwable ignored) {
        }
    }
}
