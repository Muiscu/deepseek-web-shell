package com.yg.dsweb;

/**
 * 主文档抓取 + 注入。
 *
 * shouldInterceptRequest 里我们必须自己把 HTML 拿回来，因为：
 *   - 原始响应体已被 WebView 消费，无法"只改一点再交回去"；
 *   - WebResourceResponse 必须提供新的 InputStream。
 *
 * 实现要点：
 *   1) 只在子线程被调用，可安全做阻塞 IO；
 *   2) 必须带上 CookieManager 里的 Cookie，否则会拿到登录页而不是会话页；
 *   3) 请求头尽量贴近浏览器（UA / Accept / Accept-Language），降低被风控概率；
 *   4) 失败时返回 null —— WebView 会回退到自己加载原文档（无注入但不崩）。
 */
public final class MainAssetFetcher {

    private static final String TAG = "DSFetch";

    private MainAssetFetcher() {
    }

    public static android.webkit.WebResourceResponse fetchAndInject(String url) {
        java.net.HttpURLConnection conn = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(12_000);
            conn.setReadTimeout(20_000);
            conn.setRequestMethod("GET");
            conn.setUseCaches(false);

            // —— 请求头 ——
            conn.setRequestProperty("User-Agent", WebViewSetup.buildUserAgent(null));
            conn.setRequestProperty("Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            conn.setRequestProperty("Accept-Language", acceptLanguage());
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setRequestProperty("Pragma", "no-cache");
            // WebView 自己的标记，缺了有时会被要求二次校验
            try {
                conn.setRequestProperty("X-Requested-With",
                        App.ctx().getPackageName());
            } catch (Throwable ignored) {
            }

            // —— Cookie：最关键的一步 ——
            String cookie = null;
            try {
                cookie = android.webkit.CookieManager.getInstance().getCookie(url);
            } catch (Throwable ignored) {
            }
            if (cookie != null && cookie.length() > 0) {
                conn.setRequestProperty("Cookie", cookie);
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 400) {
                // 3xx 已由 followRedirects 处理；4xx/5xx 交回 WebView
                closeQuietly(conn);
                return null;
            }

            String contentType = conn.getContentType();
            if (contentType == null) contentType = "text/html; charset=utf-8";
            String mime = contentType;
            String charset = "utf-8";
            int semi = contentType.indexOf(';');
            if (semi > 0) {
                mime = contentType.substring(0, semi).trim();
                String rest = contentType.substring(semi + 1).toLowerCase();
                int ci = rest.indexOf("charset=");
                if (ci >= 0) {
                    String cs = rest.substring(ci + 8).trim();
                    if (cs.indexOf(';') > 0) cs = cs.substring(0, cs.indexOf(';')).trim();
                    cs = cs.replace("\"", "").trim();
                    if (cs.length() > 0 && isValidCharset(cs)) charset = cs;
                }
            }
            if (!"text/html".equalsIgnoreCase(mime)
                    && !"application/xhtml+xml".equalsIgnoreCase(mime)) {
                closeQuietly(conn);
                return null;
            }

            byte[] raw = readAll(conn.getInputStream());
            if (raw == null || raw.length == 0) {
                closeQuietly(conn);
                return null;
            }
            String html = new String(raw, charset);
            String injected = Injector.injectIntoHtml(html);

            // 注意：WebResourceResponse.setResponseHeaders 的参数类型是 Map<String, String>，
            // 不是 HTTP 那样的多值 Map（这个签名在不同 API level 上都一致）。
            java.util.Map<String, String> respHeaders =
                    new java.util.HashMap<String, String>();
            respHeaders.put("Cache-Control", "no-store, no-cache");
            respHeaders.put("Content-Type", "text/html; charset=" + charset);
            collectSetCookie(conn, url);

            byte[] out = injected.getBytes(charset);

            android.webkit.WebResourceResponse resp =
                    new android.webkit.WebResourceResponse(mime, charset,
                            new java.io.ByteArrayInputStream(out));
            try {
                resp.setStatusCodeAndReasonPhrase(code, "OK");
            } catch (Throwable ignored) {
            }
            resp.setResponseHeaders(respHeaders);
            return resp;
        } catch (Throwable t) {
            if (Prefs.debugLog()) android.util.Log.w(TAG, "fetch failed: " + url, t);
            closeQuietly(conn);
            return null;
        }
    }

    private static void collectSetCookie(java.net.HttpURLConnection conn, String url) {
        try {
            java.util.Map<String, java.util.List<String>> h = conn.getHeaderFields();
            for (java.util.Map.Entry<String, java.util.List<String>> e : h.entrySet()) {
                if (e.getKey() == null) continue;
                if (!"set-cookie".equalsIgnoreCase(e.getKey())) continue;
                for (String v : e.getValue()) {
                    try {
                        android.webkit.CookieManager.getInstance().setCookie(url, v);
                    } catch (Throwable ignored) {
                    }
                }
            }
            android.webkit.CookieManager.getInstance().flush();
        } catch (Throwable ignored) {
        }
    }

    private static boolean isValidCharset(String cs) {
        try {
            return java.nio.charset.Charset.isSupported(cs);
        } catch (Throwable t) {
            return false;
        }
    }

    private static String acceptLanguage() {
        try {
            java.util.Locale l = App.ctx().getResources().getConfiguration().locale;
            if (l == null) l = java.util.Locale.getDefault();
            String lang = l.getLanguage();
            String ctry = l.getCountry();
            if (ctry != null && ctry.length() > 0) {
                return lang + "-" + ctry + "," + lang + ";q=0.9,en;q=0.6";
            }
            return lang + ",en;q=0.6";
        } catch (Throwable t) {
            return "zh-CN,zh;q=0.9,en;q=0.6";
        }
    }

    private static byte[] readAll(java.io.InputStream in) throws java.io.IOException {
        if (in == null) return null;
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(64 * 1024);
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        try {
            in.close();
        } catch (Throwable ignored) {
        }
        return bos.toByteArray();
    }

    private static void closeQuietly(java.net.HttpURLConnection c) {
        if (c == null) return;
        try {
            c.disconnect();
        } catch (Throwable ignored) {
        }
    }
}
