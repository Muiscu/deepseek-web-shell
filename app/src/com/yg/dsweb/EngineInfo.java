package com.yg.dsweb;

/**
 * 运行时环境探测：不只看 SDK 版本号，更要看 WebView 实际内核版本。
 *
 * 为什么这是本项目最核心的类：
 * 我们已用 acorn 对线上 bundle（main.d1d163b7e4.js / default-vendors.a2a242fbd2.js）
 * 做 ECMAScript 版本探测，结论是最低需要 **ES2019**（阻塞点是可选 catch 绑定 `catch{}`），
 * 对应 **Chromium 66+**。而 Android 5.1 出厂的 System WebView 是 Chromium 37，
 * 必然白屏（语法解析期 SyntaxError，整包不执行）。
 *
 * 因此 App 必须能在启动时判定"这台机器能不能跑"，并给出可执行的升级路径，
 * 而不是让用户对着白屏猜。
 */
public final class EngineInfo {

    /** 判定阈值 */
    public static final int MIN_CHROME_SAFE = 66;   // ES2019 下限
    public static final int MIN_CHROME_GOOD = 80;   // 实测稳定区间

    private static int sChromeMajor = -1;
    private static String sUa = "";
    private static String sVersionName = "";
    private static int sSdkInt = 0;

    private EngineInfo() {
    }

    static void init(android.content.Context c) {
        sSdkInt = android.os.Build.VERSION.SDK_INT;
        try {
            sUa = android.webkit.WebSettings.getDefaultUserAgent(c);
        } catch (Throwable t) {
            sUa = "";
        }
        sChromeMajor = parseChromeMajor(sUa);
        try {
            android.content.pm.PackageInfo pi = c.getPackageManager()
                    .getPackageInfo(App.webViewPackageName(), 0);
            sVersionName = pi.versionName == null ? "" : pi.versionName;
        } catch (Throwable t) {
            sVersionName = "";
        }
    }

    /** 从 UA 里取 Chrome/xx.0 的主版本号 */
    public static int parseChromeMajor(String ua) {
        if (ua == null) return -1;
        int i = ua.indexOf("Chrome/");
        if (i < 0) i = ua.indexOf("Chromium/");
        if (i < 0) return -1;
        int start = i + (ua.startsWith("Chrome/", i) ? 7 : 9);
        int end = start;
        while (end < ua.length() && Character.isDigit(ua.charAt(end))) end++;
        if (end == start) return -1;
        try {
            return Integer.parseInt(ua.substring(start, end));
        } catch (Throwable t) {
            return -1;
        }
    }

    /**
     * 纯字符串层面的 ES 语法能力粗测：不依赖 WebView 实例。
     * 用于在"创建 WebView 之前"就判定，避免旧内核上创建 WebView 触发原生崩溃。
     */
    public static boolean likelySupportsModernJs() {
        return sChromeMajor >= MIN_CHROME_SAFE;
    }

    public static int chromeMajor() {
        return sChromeMajor;
    }

    public static String userAgent() {
        return sUa;
    }

    public static String webViewVersionName() {
        return sVersionName;
    }

    public static int sdkInt() {
        return sSdkInt;
    }

    public static String webViewPackage() {
        return App.webViewPackageName();
    }

    /**
     * 引擎状态等级：
     *  3 = 良好（>=80）
     *  2 = 可用（>=66，可能个别效果缺失）
     *  1 = 危险（<66，页面必然白屏）
     *  0 = 完全探测不到
     */
    public static int grade() {
        if (sChromeMajor < 0) return 0;
        if (sChromeMajor >= MIN_CHROME_GOOD) return 3;
        if (sChromeMajor >= MIN_CHROME_SAFE) return 2;
        return 1;
    }

    public static boolean canRenderSite() {
        return sChromeMajor >= MIN_CHROME_SAFE;
    }

    public static String gradeLabel() {
        switch (grade()) {
            case 3:
                return "良好";
            case 2:
                return "可用（部分新特性缺失）";
            case 1:
                return "不可用（版本过低，页面无法渲染）";
            default:
                return "未知";
        }
    }

    /** 一句话诊断，用于兼容性页与横幅 */
    public static String summary() {
        StringBuilder sb = new StringBuilder();
        sb.append("系统 Android ").append(android.os.Build.VERSION.RELEASE)
                .append("（API ").append(sSdkInt).append("）");
        sb.append('\n').append("WebView 内核 Chromium ")
                .append(sChromeMajor < 0 ? "未知" : String.valueOf(sChromeMajor));
        sb.append('\n').append("WebView 包 ").append(webViewPackage());
        if (sVersionName.length() > 0) {
            sb.append(" 版本 ").append(sVersionName);
        }
        sb.append('\n').append("网页要求：Chromium ")
                .append(MIN_CHROME_SAFE).append("+（ES2019 语法下限）");
        if (sSdkInt <= 22) {
            sb.append('\n').append("Android 5.x 可升级上限：Chromium ")
                    .append(ANDROID51_WEBVIEW_MAX).append(" 左右");
        }
        sb.append('\n').append("当前判定：").append(gradeLabel());
        return sb.toString();
    }

    /**
     * 该机型上可行的升级建议（按优先级）。
     * 返回的是"要不要给用户看引导"的判断，不是命令。
     */
    /** Android 5.1 上 WebView 实务可升级到的 Chromium 上限（实测经验值，约 85） */
    public static final int ANDROID51_WEBVIEW_MAX = 85;

    public static String advice() {
        int g = grade();
        if (g >= 3) {
            return "引擎满足要求，无需任何处理。";
        }
        if (g == 2) {
            return "引擎刚好达到语法下限（Chromium " + sChromeMajor + "）。"
                    + "多数功能可用；若遇到界面错位、按钮无响应或排版错乱，"
                    + "建议把 WebView 升到 Chromium 85 左右。";
        }
        // g <= 1
        StringBuilder sb = new StringBuilder();
        sb.append("当前内核是 Chromium ").append(sChromeMajor < 0 ? "（未知）" : sChromeMajor)
                .append("，低于 DeepSeek 网页要求的 ").append(MIN_CHROME_SAFE)
                .append("，网页 JS 无法解析，会白屏。\n\n");
        sb.append("好消息：Android 5.0/5.1 的 System WebView 其实可以升级到 Chromium ")
                .append(ANDROID51_WEBVIEW_MAX).append(" 左右，")
                .append("升完之后本 App 与网页都能正常跑。\n\n");
        sb.append("操作步骤：\n");
        sb.append("1) 安装/更新「Android System WebView」或「Chrome」。")
                .append("两者任一提供 WebView 实现即可；装好后本 App 会立刻检测到新内核。\n");
        sb.append("2) 若系统锁死了 com.android.webview（部分国产 ROM），")
                .append("到「开发者选项 → WebView 实现」切换为 Chrome。\n");
        sb.append("3) 回到本页点「重新检测引擎」确认版本已变。\n");
        sb.append("4) 仍无法升级时，可在本机浏览器里访问 chat.deepseek.com —— ")
                .append("浏览器能开说明只是 WebView 内核问题。\n");
        return sb.toString();
    }
}
