package com.yg.dsweb;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.animation.AlphaAnimation;
import android.view.animation.Animation;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * 主界面：自绘标题栏 + WebView + 进度条 + 兼容告警横幅。
 *
 * 为什么不用 ActionBar/Toolbar：本工程不引入 AndroidX，用最朴素的 View 组合，
 * 在 API 22 上零兼容风险，且能精确控制状态栏与内容区的衔接。
 */
public class MainActivity extends Activity {

    private static final String URL_HOME = "https://chat.deepseek.com/";
    private static final String HOST = "chat.deepseek.com";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_PERM_STORAGE = 1002;

    private FrameLayout root;
    private WebView webView;
    private LinearLayout titleBar;
    private ProgressBar progress;
    private TextView progressTv;
    private LinearLayout banner;
    private FrameLayout errorView;
    private FrameLayout loadingView;
    private TextView badgeView;
    private FrameLayout badgeWrap;

    private ValueCallback<Uri[]> fileCallback;
    private WebChromeClient.FileChooserParams pendingParams;

    private boolean pageFinishedOnce = false;
    private boolean webViewBroken = false;
    private int lastProgress = 0;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private String lastErrorUrl = null;

    // ============================================================
    // 生命周期
    // ============================================================

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        sInstance = new java.lang.ref.WeakReference<MainActivity>(this);
        Ui.applySystemBars(this);

        if (!EngineInfo.canRenderSite() && Prefs.showBanner()) {
            // 引擎过低：直接进兼容性引导页，不给白屏
            Intent it = new Intent(this, CompatActivity.class);
            ActivityGuard.start(this, CompatActivity.class);
            finish();
            return;
        }

        buildUi();
        setupWebView();

        String startUrl = URL_HOME;
        Uri data = getIntent() == null ? null : getIntent().getData();
        if (data != null && HOST.equals(data.getHost())) {
            startUrl = data.toString();
        }
        webView.loadUrl(startUrl);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null) return;
        Uri data = intent.getData();
        if (data != null && HOST.equals(data.getHost()) && webView != null) {
            webView.loadUrl(data.toString());
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        setKeepScreenOn(Prefs.keepScreenOn());
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
        refreshBanner();
        // 开关可能在设置页被改：同步给已加载页面，不必重载
        applyShellConfig();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        App.flushCookies();
        super.onPause();
    }

    @Override
    protected void onStop() {
        super.onStop();
        App.flushCookies();
    }

    @Override
    protected void onDestroy() {
        try {
            if (webView != null) {
                webView.removeJavascriptInterface(JsBridge.name());
            }
        } catch (Throwable ignored) {
        }
        WebViewSetup.destroy(webView);
        webView = null;
        if (sInstance != null && sInstance.get() == this) {
            sInstance = new java.lang.ref.WeakReference<MainActivity>(null);
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // 先让菜单/错误页收起
        if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
            errorView.setVisibility(View.GONE);
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE_CHOOSER) {
            if (fileCallback == null) return;
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCallback = null;
            pendingParams = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    private void setKeepScreenOn(boolean on) {
        if (on) {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    // ============================================================
    // UI 构建
    // ============================================================

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Ui.color(this, R.color.bg));
        setContentView(root);

        // ---- 竖向容器：标题栏 + 横幅 + WebView 区 ----
        LinearLayout col = Ui.column(this);

        titleBar = buildTitleBar();
        col.addView(titleBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 56)));

        banner = buildBanner();
        banner.setVisibility(View.GONE);
        col.addView(banner, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout webContainer = new FrameLayout(this);
        LinearLayout.LayoutParams webLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        col.addView(webContainer, webLp);

        // 进度条贴在标题栏下沿
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressDrawable(makeProgressDrawable());
        FrameLayout.LayoutParams pLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 2));
        pLp.gravity = Gravity.TOP;
        webContainer.addView(progress, pLp);

        // WebView 由 setupWebView 创建后加入
        // 加载态
        loadingView = buildLoadingView();
        loadingView.setVisibility(View.VISIBLE);
        webContainer.addView(loadingView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 错误态
        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        webContainer.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(col, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 给标题栏补状态栏高度（全屏非沉浸式，系统栏已占位则不需要）
        applyInsets();

        this.webContainer = webContainer;
    }

    private FrameLayout webContainer;

    // ============================================================
    // 对外接口（供存档页 / 设置页调用）
    // ============================================================

    public interface JsResult {
        void onResult(String value);
    }

    private static java.lang.ref.WeakReference<MainActivity> sInstance =
            new java.lang.ref.WeakReference<MainActivity>(null);

    public static MainActivity instance() {
        return sInstance == null ? null : sInstance.get();
    }

    public WebView getWebView() {
        return webView;
    }

    /** 执行 JS 并回调结果（API 19+ 走 evaluateJavascript） */
    public void evaluateJsForResult(String js, final JsResult cb) {
        if (webView == null) {
            if (cb != null) cb.onResult("null");
            return;
        }
        try {
            webView.evaluateJavascript(js, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (cb != null) cb.onResult(value);
                }
            });
        } catch (Throwable t) {
            if (cb != null) cb.onResult("null");
        }
    }

    private void applyInsets() {
        // 非 FLAG_LAYOUT_NO_LIMITS 时系统已给内容区留出状态栏，无需手动 padding
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(Ui.color(this, R.color.brand));
        }
    }

    private LinearLayout buildTitleBar() {
        LinearLayout bar = Ui.row(this);
        bar.setBackgroundColor(Ui.color(this, R.color.brand));
        bar.setPadding(Ui.dp(this, 14), 0, Ui.dp(this, 4), 0);

        // 标题（含"已拦截"徽标）。左侧不再放重复的菜单按钮 ——
        // 它和右侧「更多」调用的是同一个 showMenu()，属于冗余。
        LinearLayout center = Ui.row(this);
        center.setGravity(Gravity.CENTER);
        TextView title = Ui.text(this, "DeepSeek", 17f, Ui.color(this, R.color.icon_on_brand));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setSingleLine(true);
        center.addView(title);

        badgeWrap = new FrameLayout(this);
        badgeView = new TextView(this);
        badgeView.setTextColor(Color.WHITE);
        badgeView.setTextSize(11f);
        badgeView.setGravity(Gravity.CENTER);
        badgeView.setTypeface(Typeface.DEFAULT_BOLD);
        badgeView.setBackgroundResource(R.drawable.bg_badge);
        badgeView.setMinWidth(Ui.dp(this, 18));
        badgeView.setPadding(Ui.dp(this, 5), 0, Ui.dp(this, 5), 0);
        badgeWrap.addView(badgeView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(this, 18)));
        badgeWrap.setVisibility(View.GONE);
        LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(this, 18));
        bLp.leftMargin = Ui.dp(this, 6);
        center.addView(badgeWrap, bLp);

        LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(center, cLp);

        // 右：更多（唯一入口，替代原来左侧那个重复的菜单按钮）
        ImageView moreBtn = new ImageView(this);
        moreBtn.setImageResource(R.drawable.ic_more_vert);
        moreBtn.setColorFilter(Ui.color(this, R.color.icon_on_brand));
        moreBtn.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        moreBtn.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
        moreBtn.setBackgroundResource(R.drawable.bg_icon_btn);
        moreBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showMenu();
            }
        });
        LinearLayout.LayoutParams rLp = new LinearLayout.LayoutParams(
                Ui.dp(this, 44), Ui.dp(this, 44));
        rLp.rightMargin = Ui.dp(this, 4);
        bar.addView(moreBtn, rLp);

        return bar;
    }

    private LinearLayout buildBanner() {
        LinearLayout b = Ui.row(this);
        b.setBackgroundResource(R.drawable.bg_banner);
        b.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = Ui.dp(this, 10);
        lp.rightMargin = Ui.dp(this, 10);
        lp.topMargin = Ui.dp(this, 6);
        b.setLayoutParams(lp);

        TextView t = Ui.text(this, "", 12.5f, Ui.color(this, R.color.banner_text));
        t.setLineSpacing(Ui.sp(this, 2), 1f);
        LinearLayout.LayoutParams tLp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        b.addView(t, tLp);
        b.setTag(t);

        b.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ActivityGuard.start(MainActivity.this, CompatActivity.class);
            }
        });
        return b;
    }

    private void refreshBanner() {
        if (banner == null) return;
        boolean need = Prefs.showBanner() && EngineInfo.grade() <= 2;
        banner.setVisibility(need ? View.VISIBLE : View.GONE);
        if (need) {
            TextView t = (TextView) banner.getTag();
            t.setText(getString(R.string.banner_old_webview,
                    EngineInfo.chromeMajor() < 0 ? "?" : String.valueOf(EngineInfo.chromeMajor())));
        }
    }

    private FrameLayout buildLoadingView() {
        FrameLayout f = new FrameLayout(this);
        f.setBackgroundColor(Ui.color(this, R.color.bg));
        LinearLayout c = Ui.column(this);
        c.setGravity(Gravity.CENTER);
        ProgressBar pb = new ProgressBar(this);
        LinearLayout.LayoutParams pLp = new LinearLayout.LayoutParams(
                Ui.dp(this, 34), Ui.dp(this, 34));
        pLp.gravity = Gravity.CENTER_HORIZONTAL;
        c.addView(pb, pLp);
        TextView tv = Ui.text(this, getString(R.string.loading), 13f,
                Ui.color(this, R.color.text_secondary));
        LinearLayout.LayoutParams tLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tLp.gravity = Gravity.CENTER_HORIZONTAL;
        tLp.topMargin = Ui.dp(this, 14);
        c.addView(tv, tLp);
        FrameLayout.LayoutParams cLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cLp.gravity = Gravity.CENTER;
        f.addView(c, cLp);
        return f;
    }

    private FrameLayout buildErrorView() {
        FrameLayout f = new FrameLayout(this);
        f.setBackgroundColor(Ui.color(this, R.color.bg));
        f.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // 吞掉点击，避免穿透到 WebView
            }
        });

        LinearLayout c = Ui.column(this);
        c.setGravity(Gravity.CENTER);
        c.setPadding(Ui.dp(this, 32), 0, Ui.dp(this, 32), 0);

        TextView title = Ui.text(this, getString(R.string.error_title), 17f,
                Ui.color(this, R.color.text_primary));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        c.addView(title);

        TextView desc = Ui.text(this, getString(R.string.error_desc), 13f,
                Ui.color(this, R.color.text_secondary));
        desc.setGravity(Gravity.CENTER);
        desc.setLineSpacing(Ui.sp(this, 3), 1f);
        LinearLayout.LayoutParams dLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dLp.topMargin = Ui.dp(this, 10);
        c.addView(desc, dLp);

        TextView retry = Ui.text(this, getString(R.string.error_retry), 15f, Color.WHITE);
        retry.setTypeface(Typeface.DEFAULT_BOLD);
        retry.setGravity(Gravity.CENTER);
        retry.setBackgroundResource(R.drawable.bg_button_brand);
        LinearLayout.LayoutParams rLp = new LinearLayout.LayoutParams(
                Ui.dp(this, 132), Ui.dp(this, 42));
        rLp.topMargin = Ui.dp(this, 24);
        rLp.gravity = Gravity.CENTER_HORIZONTAL;
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                errorView.setVisibility(View.GONE);
                if (lastErrorUrl != null && webView != null) {
                    webView.loadUrl(lastErrorUrl);
                } else if (webView != null) {
                    webView.reload();
                }
            }
        });
        c.addView(retry, rLp);

        FrameLayout.LayoutParams cLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cLp.gravity = Gravity.CENTER;
        f.addView(c, cLp);
        return f;
    }

    private android.graphics.drawable.Drawable makeProgressDrawable() {
        android.graphics.drawable.LayerDrawable layers;
        android.graphics.drawable.GradientDrawable bg =
                new android.graphics.drawable.GradientDrawable();
        bg.setColor(Color.TRANSPARENT);

        android.graphics.drawable.GradientDrawable bar =
                new android.graphics.drawable.GradientDrawable();
        bar.setColors(new int[]{Ui.color(this, R.color.brand),
                Ui.color(this, R.color.brand_dark),
                Ui.color(this, R.color.brand)});
        bar.setOrientation(android.graphics.drawable.GradientDrawable.Orientation.LEFT_RIGHT);

        layers = new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[]{
                bg, new android.graphics.drawable.ClipDrawable(bar,
                Gravity.LEFT, android.graphics.drawable.ClipDrawable.HORIZONTAL)
        });
        layers.setId(0, android.R.id.background);
        layers.setId(1, android.R.id.progress);
        return layers;
    }

    // ============================================================
    // WebView
    // ============================================================

    private void setupWebView() {
        try {
            webView = WebViewSetup.create(this);
        } catch (Throwable t) {
            webViewBroken = true;
            Intent it = new Intent(this, CompatActivity.class);
            it.putExtra("broken", true);
            ActivityGuard.start(this, CompatActivity.class);
            finish();
            return;
        }

        webView.addJavascriptInterface(new JsBridge(this), JsBridge.name());

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        webContainer.addView(webView, 0, lp);

        webView.setWebViewClient(new DsWebViewClient());
        webView.setWebChromeClient(new DsWebChromeClient());
    }

    /** 给已加载的页面同步开关状态（不重载） */
    private void applyShellConfig() {
        if (webView == null || pageFinishedOnce == false) return;
        StringBuilder js = new StringBuilder();
        js.append("(function(){try{")
                .append("window.__DS_APP_CFG__={antiRecall:")
                .append(Prefs.antiRecall() ? "true" : "false")
                .append(",debug:").append(Prefs.debugLog() ? "true" : "false").append("};")
                .append("if(window.__DS_SHELL__&&window.__DS_SHELL__.setEnabled)")
                .append("window.__DS_SHELL__.setEnabled(")
                .append(Prefs.antiRecall() ? "true" : "false").append(");")
                .append("if(window.__DS_SHELL__&&window.__DS_SHELL__.setDebug)")
                .append("window.__DS_SHELL__.setDebug(")
                .append(Prefs.debugLog() ? "true" : "false").append(");")
                .append("if(window.__DS_SHELL__&&window.__DS_SHELL__.reportCount&&DSApp)")
                .append("DSApp.onArchiveChanged(window.__DS_SHELL__.count());")
                .append("}catch(e){}})();");
        evaluate(js.toString());
    }

    private void evaluate(final String js) {
        if (webView == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 19) {
                webView.evaluateJavascript(js, null);
            } else {
                // API 22 最低，这段实际不会走到，保留兜底
                webView.loadUrl("javascript:" + js);
            }
        } catch (Throwable ignored) {
        }
    }

    // ---------- WebViewClient ----------

    private class DsWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigate(url);
        }

        /** 旧的 String 重载：在 API 21+ 上不会被主文档调用，直接放行 */
        @Override
        public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return null;
        }

        /**
         * API 21+ 的主入口。用 isForMainFrame() 精确判定"这是不是主文档"，
         * 而不是靠 URL 猜——主文档的拦截发生在 onPageStarted 之前，
         * 任何依赖 onPageStarted 记录的状态在这里都还没准备好。
         */
        @Override
        public android.webkit.WebResourceResponse shouldInterceptRequest(
                WebView view, android.webkit.WebResourceRequest req) {
            try {
                if (req == null) return null;
                if (!req.isForMainFrame()) return null;   // 资源/接口/iframe 全部放行
                if (!Prefs.injectOnPageStart()) return null;
                Uri u = req.getUrl();
                if (u == null || !HOST.equals(u.getHost())) return null;
                if (!"https".equalsIgnoreCase(u.getScheme())) return null;
                return MainAssetFetcher.fetchAndInject(u.toString());
            } catch (Throwable t) {
                if (Prefs.debugLog()) android.util.Log.w("DSWeb", "intercept failed", t);
                return null;
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            mPendingMainFrameUrl = url;
            pageFinishedOnce = false;
            lastProgress = 0;
            if (loadingView != null) loadingView.setVisibility(View.VISIBLE);
            if (errorView != null) errorView.setVisibility(View.GONE);
            if (progress != null) {
                progress.setVisibility(View.VISIBLE);
                progress.setProgress(3);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            pageFinishedOnce = true;
            if (loadingView != null) {
                fadeOut(loadingView);
            }
            if (progress != null) {
                ui.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (progress != null) progress.setVisibility(View.INVISIBLE);
                    }
                }, 200);
            }
            // 真正的双保险：先探测脚本是否已在页面里；若没有，立即补注入。
            //
            // 为什么必须这么做：shouldInterceptRequest 只要有任何一环失败
            // （没命中主文档 / 拿到非 HTML / Cookie 异常 ...），脚本就从未执行。
            // 之前的"双保险"只调 applyShellConfig()，而它依赖 __DS_SHELL__ 存在 ——
            // 等于什么都没做，于是功能彻底静默失效。这是本次线上失效的直接原因。
            webView.evaluateJavascript(SHELL_PROBE_JS, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    boolean installed = value != null && value.indexOf("1") >= 0;
                    if (installed) {
                        applyShellConfig();
                        evaluate("(function(){try{if(window.__DS_SHELL__&&DSApp&&DSApp.onReady)"
                                + "DSApp.onReady(window.__DS_SHELL__.version||'?');}catch(e){}})();");
                    } else {
                        injectShellNow();
                    }
                }
            });
        }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description,
                                    String failingUrl) {
            // 只有主文档失败才显示错误页，资源失败忽略
            if (failingUrl == null) return;
            String u = failingUrl.toLowerCase();
            if (u.contains(".js") || u.contains(".css") || u.contains(".png")
                    || u.contains(".jpg") || u.contains(".svg") || u.contains(".woff")) {
                return;
            }
            lastErrorUrl = failingUrl;
            showErrorPage();
        }

        @Override
        public void onReceivedHttpError(WebView view, android.webkit.WebResourceRequest req,
                                        android.webkit.WebResourceResponse res) {
            // 只有主文档 5xx 才当错误；子资源/接口错误交给页面自己处理
            if (req == null || res == null) return;
            if (!req.isForMainFrame()) return;
            if (res.getStatusCode() >= 500) {
                if (loadingView != null) fadeOut(loadingView);
                showErrorPage();
            }
        }
    }

    /** 记录当前主文档 URL，用于诊断日志 */
    private volatile String mPendingMainFrameUrl = null;

    private static final String SHELL_PROBE_JS = ShellInjector.probeJs();

    /** 补注入：把脚本打进当前已加载的文档 */
    private void injectShellNow() {
        if (webView == null) return;
        webView.evaluateJavascript(ShellInjector.buildLateInjectJs(), new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                android.util.Log.d("DSWeb", "late inject => " + value);
                if (value != null && value.contains("installed")) {
                    applyShellConfig();
                }
            }
        });
    }

    private void showErrorPage() {
        if (errorView == null) return;
        errorView.setVisibility(View.VISIBLE);
        if (loadingView != null) loadingView.setVisibility(View.GONE);
        if (progress != null) progress.setVisibility(View.INVISIBLE);
    }

    private void fadeOut(final View v) {
        if (v == null || v.getVisibility() != View.VISIBLE) return;
        AlphaAnimation a = new AlphaAnimation(1f, 0f);
        a.setDuration(160);
        a.setAnimationListener(new Animation.AnimationListener() {
            @Override
            public void onAnimationStart(Animation animation) {
            }

            @Override
            public void onAnimationEnd(Animation animation) {
                v.setVisibility(View.GONE);
                v.clearAnimation();
            }

            @Override
            public void onAnimationRepeat(Animation animation) {
            }
        });
        v.startAnimation(a);
    }

    private boolean handleNavigate(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();

        if (scheme.startsWith("javascript")) {
            return false;
        }
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            // tel: mailto: intent: 等交给系统
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Throwable ignored) {
            }
            return true;
        }
        String host = u.getHost();
        if (HOST.equals(host)) {
            return false; // 站内：WebView 自己处理
        }
        openExternalUrl(url);
        return true;
    }

    // ---------- WebChromeClient ----------

    private class DsWebChromeClient extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (progress != null) {
                if (newProgress >= 100) {
                    progress.setVisibility(View.INVISIBLE);
                } else {
                    progress.setVisibility(View.VISIBLE);
                    progress.setProgress(newProgress);
                }
            }
            if (newProgress > lastProgress + 15 && newProgress < 90) {
                // 页面还在起步，保持 loading
            }
            lastProgress = newProgress;
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            super.onReceivedTitle(view, title);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;
            pendingParams = params;
            try {
                Intent i = params.createIntent();
                startActivityForResult(i, REQ_FILE_CHOOSER);
                return true;
            } catch (Throwable t) {
                fileCallback = null;
                return false;
            }
        }

        @Override
        public void onPermissionRequest(final android.webkit.PermissionRequest request) {
            request.deny();
            // 说明：站点主要用文字输入；如需语音输入，可在此按需授予 RECORD_AUDIO
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(
                String origin, android.webkit.GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }
    }

    // ============================================================
    // 桥回调
    // ============================================================

    void handleRecall(String payload) {
        Prefs.incRecallCount();
        // 只在脚本上报里计数 + 提示一次轻量反馈
        int n = Prefs.recallCount();
        updateBadge(n);
        if (Prefs.debugLog()) {
            android.util.Log.d("DSWeb", "recall: " + payload);
        }
    }

    void updateBadge(int n) {
        if (badgeWrap == null || badgeView == null) return;
        if (n <= 0) {
            badgeWrap.setVisibility(View.GONE);
            return;
        }
        badgeWrap.setVisibility(View.VISIBLE);
        badgeView.setText(n > 99 ? "99+" : String.valueOf(n));
    }

    void onArchiveError(String reason) {
        if (Prefs.debugLog()) {
            Ui.toast(this, "存档写入失败: " + reason);
        }
    }

    void onShellReady(String info) {
        if (Prefs.debugLog()) {
            android.util.Log.d("DSWeb", "shell ready: " + info);
        }
        // 页面就绪后把当前存档数同步到徽标，并汇报一次健康状态
        evaluate("(function(){try{if(window.__DS_SHELL__&&DSApp)"
                + "DSApp.onArchiveChanged(window.__DS_SHELL__.count());}catch(e){}})();");
        evaluate("(function(){try{if(window.__DS_REPORT_HEALTH__)"
                + "window.__DS_REPORT_HEALTH__();}catch(e){}})();");
    }

    /** 脚本健康状态：钩子装在哪层 / 见到多少请求 / 命中多少 */
    private String mShellHealth = null;

    void onShellHealth(String statsJson) {
        mShellHealth = statsJson;
        ShellHealth.put(statsJson);
        android.util.Log.d("DSWeb", "health: " + statsJson);
        // 解析出 generateHits 用于极简的"是否在工作"判断
        try {
            org.json.JSONObject o = new org.json.JSONObject(statsJson);
            int gen = o.optInt("generateHits", 0);
            int hist = o.optInt("historyHits", 0);
            if (gen > 0 || hist > 0) {
                // 钩子确实在工作
            }
        } catch (Throwable ignored) {
        }
    }

    public static String lastHealth() {
        return ShellHealth.get();
    }

    void openExternalUrl(String url) {
        if (url == null) return;
        Uri u = Uri.parse(url);
        if (HOST.equals(u.getHost())) {
            if (webView != null) webView.loadUrl(url);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Throwable t) {
            Ui.toast(this, "无法打开该链接");
        }
    }

    void saveArchiveExport(final String json) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    java.io.File dir = ArchiveDir.get();
                    java.io.File f = new java.io.File(dir,
                            "deepseek-archive-" + ArchiveDir.stamp() + ".json");
                    java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
                    fos.write(json.getBytes("UTF-8"));
                    fos.close();
                    final String path = f.getAbsolutePath();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Ui.toast(MainActivity.this, "已导出: " + path);
                        }
                    });
                } catch (Throwable t) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Ui.toast(MainActivity.this, getString(R.string.dl_failed));
                        }
                    });
                }
            }
        }).start();
    }

    // ============================================================
    // 菜单
    // ============================================================

    private void showMenu() {
        new AppMenu(this).show(new AppMenu.Listener() {
            @Override
            public void onNewChat() {
                if (webView != null) webView.loadUrl(URL_HOME);
            }

            @Override
            public void onToggleAntiRecall(boolean enabled) {
                Prefs.setAntiRecall(enabled);
                applyShellConfig();
                Ui.toast(MainActivity.this,
                        enabled ? "防撤回已开启" : "防撤回已关闭");
            }

            @Override
            public void onArchive() {
                ActivityGuard.start(MainActivity.this, ArchiveActivity.class);
            }

            @Override
            public void onEngine() {
                ActivityGuard.start(MainActivity.this, CompatActivity.class);
            }

            @Override
            public void onSettings() {
                ActivityGuard.start(MainActivity.this, SettingsActivity.class);
            }

            @Override
            public void onShare() {
                if (webView == null) return;
                String url = webView.getUrl();
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, url == null ? URL_HOME : url);
                startActivity(Intent.createChooser(i, "分享"));
            }

            @Override
            public void onExternal() {
                openExternalUrl(webView == null || webView.getUrl() == null
                        ? URL_HOME : webView.getUrl());
            }

            @Override
            public void onClearCache() {
                clearCacheConfirm();
            }

            @Override
            public void onReload() {
                if (webView != null) webView.reload();
            }

            @Override
            public void onAbout() {
                startActivity(new Intent(MainActivity.this, SettingsActivity.class)
                        .putExtra("about", true));
            }
        });
    }

    private void clearCacheConfirm() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("清理缓存")
                .setMessage("将清除网页缓存（不影响登录状态与撤回存档）。")
                .setNegativeButton("取消", null)
                .setPositiveButton("清理", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) {
                        if (webView == null) return;
                        webView.clearCache(true);
                        Ui.toast(MainActivity.this, "已清理缓存");
                    }
                })
                .show();
    }
}
