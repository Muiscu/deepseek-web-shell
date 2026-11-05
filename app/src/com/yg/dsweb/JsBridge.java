package com.yg.dsweb;

import android.webkit.JavascriptInterface;

/**
 * JS <-> Java 桥。
 *
 * 设计原则：
 *   1) 任何方法都不得抛异常回 JS（JS 侧 catch 不住会影响页面主流程）；
 *   2) 不得在桥方法里做耗时操作（在 WebView 的 JavaBridge 线程同步执行，阻塞会卡页面）；
 *   3) 所有回调都 post 回主线程再更新 UI。
 *
 * 安全：本类只暴露给 chat.deepseek.com 的主文档。宿主在 onPageStarted 时
 * addJavascriptInterface，在页面离开站点时 removeJavascriptInterface。
 */
public final class JsBridge {

    private static final String NAME = "DSApp";

    private final MainActivity host;

    public JsBridge(MainActivity host) {
        this.host = host;
    }

    public static String name() {
        return NAME;
    }

    /** 脚本侧检测到撤回。payload 为 JSON 字符串。 */
    @JavascriptInterface
    public void onRecall(final String payload) {
        try {
            host.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    host.handleRecall(payload);
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /** 脚本侧上报存档条目变化（新增/删除），用于刷新徽标数字。 */
    @JavascriptInterface
    public void onArchiveChanged(int total) {
        try {
            final int n = total;
            host.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    host.updateBadge(n);
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /**
     * 存档快照推送。
     *
     * 为什么需要它：存档页若依赖"主界面还活着"才能取数据，
     * 一旦主界面被系统回收就打不开。脚本主动推送快照后，
     * 存档页即使脱离主界面也有数据可显示。
     */
    @JavascriptInterface
    public void onArchiveSnapshot(final String json) {
        try {
            ArchiveStore.put(json);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 原始 SSE 事件探针数据。
     *
     * 排查"存档只存了两个字符"这类问题时，光靠猜线上格式会反复试错；
     * 让页面把真实收到的 SSE 事件形态导出来，定位就从"猜"变成"看"。
     */
    @JavascriptInterface
    public void onProbe(final String json) {
        try {
            ProbeStore.put(json);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 脚本侧上报健康状态（钩子装在哪一层、见到多少请求、命中多少次）。
     * 这是排查"防撤回没反应"的关键：能区分"钩子没装上"与"装上了但没命中"。
     */
    @JavascriptInterface
    public void onHealth(final String statsJson) {
        try {
            host.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    host.onShellHealth(statsJson);
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /** 通用日志（仅 debug 开关打开时才记）。 */
    @JavascriptInterface
    public void log(final String msg) {
        if (!Prefs.debugLog()) return;
        android.util.Log.d("DSWebJS", String.valueOf(msg));
    }

    /** 存档写入失败（配额满 / localStorage 被禁） */
    @JavascriptInterface
    public void onArchiveError(final String reason) {
        try {
            host.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    host.onArchiveError(reason);
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /** 脚本已安装完成 */
    @JavascriptInterface
    public void onReady(final String info) {
        try {
            host.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    host.onShellReady(info);
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /** 脚本请求宿主打开外部链接（例如分享/协议链接） */
    @JavascriptInterface
    public void openExternal(final String url) {
        try {
            host.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    host.openExternalUrl(url);
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /** 脚本侧把存档导出为文本，交给宿主保存/分享 */
    @JavascriptInterface
    public void exportArchive(final String json) {
        try {
            host.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    host.saveArchiveExport(json);
                }
            });
        } catch (Throwable ignored) {
        }
    }
}
