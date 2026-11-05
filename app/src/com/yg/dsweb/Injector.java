package com.yg.dsweb;

import android.content.res.AssetManager;
import android.text.TextUtils;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;

/**
 * 主文档注入器。
 *
 * 为什么要这么做：
 *   DeepSeek 前端是 React SPA，bundle 执行后立刻发 XHR。若用 evaluateJavascript 在
 *   onPageStarted/onPageFinished 注入，时机必然晚于第一次请求（onPageStarted 时 document
 *   可能还没 root，onPageFinished 已经整页跑完）。唯一可靠办法是在 HTML 到达 WebView 之前
 *   就把脚本内联进 <head> 最前面 —— 即 shouldInterceptRequest 改写主文档。
 *
 * 关键约束：
 *   1) shouldInterceptRequest 在子线程被调用，返回值必须是全新的全量 WebResourceResponse，
 *      不能返回原响应体（已消费）。
 *   2) 不得改动原 HTML 的其它任何字节（SRI 校验的是外部脚本，内联插入不影响它）。
 *   3) 脚本必须自带 <script> 包裹，且内部不能出现字面量 "</script>"。
 */
public final class Injector {

    private static final String TAG = "DSInjector";

    /** 缓存脚本，避免每次请求都读 assets */
    private static volatile String sScript = null;

    private Injector() {
    }

    /** 读取打包在 assets 里的注入脚本（带缓存）。 */
    public static String script() {
        if (sScript != null) return sScript;
        synchronized (Injector.class) {
            if (sScript != null) return sScript;
            String s = readAsset("ds_shell.js");
            if (s == null) s = "";
            sScript = s;
            return s;
        }
    }

    /** 重新载入（切换开关后无需重启进程） */
    public static void reload() {
        synchronized (Injector.class) {
            sScript = null;
        }
    }

    private static String readAsset(String name) {
        AssetManager am = App.ctx().getAssets();
        InputStream in = null;
        try {
            in = am.open(name);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(64 * 1024);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), Charset.forName("UTF-8"));
        } catch (Throwable t) {
            android.util.Log.e(TAG, "readAsset failed: " + name, t);
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    /**
     * 把注入脚本拼成一个完整的 <script> 块。
     * 关闭防撤回时仍然注入——因为还需要 bridge 上报状态、以及"已拦截"徽标的重置逻辑。
     * 真正的旁路由脚本内部 setEnabled 控制，避免开关切换要重新加载页面。
     */
    public static String buildInlineScript() {
        String js = script();
        if (TextUtils.isEmpty(js)) return "";
        boolean enabled = Prefs.antiRecall();
        StringBuilder sb = new StringBuilder(js.length() + 256);
        sb.append("<script>\n");
        sb.append("(function(){try{\n");
        sb.append("window.__DS_APP_CFG__={antiRecall:").append(enabled ? "true" : "false")
                .append(",debug:").append(Prefs.debugLog() ? "true" : "false").append("};\n");
        sb.append(js);
        sb.append("\n}catch(e){try{if(window.DSApp&&DSApp.log)DSApp.log('inject-error: '+e);}catch(_){}}})();\n");
        sb.append("</").append("script>");
        return sb.toString();
    }

    /**
     * 改写 HTML：在 <head> 之后（或 <html> 之后 / 文档最前）插入脚本。
     * 顺序优先级：<head ...> 的闭合 '>' 之后 > 文档最前（跳过 DOCTYPE）。
     */
    public static String injectIntoHtml(String html) {
        if (html == null || html.length() == 0) return html;
        String payload = buildInlineScript();
        if (TextUtils.isEmpty(payload)) return html;

        int headIdx = indexOfIgnoreCase(html, "<head");
        if (headIdx >= 0) {
            int tagEnd = html.indexOf('>', headIdx);
            if (tagEnd > 0) {
                int at = tagEnd + 1;
                return html.substring(0, at) + payload + html.substring(at);
            }
        }
        // 没有 head：插到 <html> 之后，或跳过 DOCTYPE 后
        int htmlIdx = indexOfIgnoreCase(html, "<html");
        if (htmlIdx >= 0) {
            int tagEnd = html.indexOf('>', htmlIdx);
            if (tagEnd > 0) {
                int at = tagEnd + 1;
                return html.substring(0, at) + payload + html.substring(at);
            }
        }
        int docStart = 0;
        String lower = html.length() > 64 ? html.substring(0, 64).toLowerCase() : html.toLowerCase();
        if (lower.startsWith("<!doctype")) {
            int e = html.indexOf('>');
            if (e > 0) docStart = e + 1;
        }
        return html.substring(0, docStart) + payload + html.substring(docStart);
    }

    private static int indexOfIgnoreCase(String s, String needle) {
        int n = needle.length();
        int max = s.length() - n;
        for (int i = 0; i <= max; i++) {
            if (s.regionMatches(true, i, needle, 0, n)) return i;
        }
        return -1;
    }

    /** 首页/对话页才需要注入（其它资源不要碰） */
    public static boolean shouldInject(String url, String mime) {
        if (url == null) return false;
        if (!url.startsWith("https://")) return false;
        String u = url.toLowerCase();
        if (u.endsWith(".js") || u.endsWith(".css") || u.endsWith(".png") || u.endsWith(".jpg")
                || u.endsWith(".jpeg") || u.endsWith(".gif") || u.endsWith(".webp")
                || u.endsWith(".svg") || u.endsWith(".woff") || u.endsWith(".woff2")
                || u.endsWith(".ttf") || u.endsWith(".ico") || u.endsWith(".json")
                || u.endsWith(".map")) {
            return false;
        }
        if (mime != null) {
            String m = mime.toLowerCase();
            if (m.contains("javascript") || m.contains("css") || m.contains("image")
                    || m.contains("font") || m.contains("video") || m.contains("audio")) {
                return false;
            }
            if (!m.contains("html")) return false;
        }
        return true;
    }
}
