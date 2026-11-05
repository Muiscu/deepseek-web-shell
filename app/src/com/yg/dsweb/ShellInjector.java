package com.yg.dsweb;

/**
 * 兜底注入器：当 shouldInterceptRequest 未能改写主文档时，
 * 在页面就绪后用 evaluateJavascript 把脚本补进当前文档。
 *
 * 为什么这条兜底是必需的（不是"可选加强"）：
 *   shouldInterceptRequest 只要任一环节不成立——没被判定为主文档、
 *   拿到非 HTML 响应、Cookie/网络异常、或 WebView 走了缓存——
 *   注入就会整条失效。此时脚本从未执行，页面看起来完全正常，
 *   用户只会觉得"防撤回不见了"。v1.0/v1.1 线上失效正是这种情况。
 *
 * 代价与取舍：
 *   补注入发生在 onPageFinished 之后，因此页面"加载阶段"发出的请求拦不到。
 *   但对话请求是用户点发送时才发出的，所以对实际使用没有影响。
 *   真正不可挽回的只有"页面一完成就自动发起的请求"。
 */
public final class ShellInjector {

    private ShellInjector() {
    }

    /**
     * 生成用于补注入的 JS。
     *
     * 关键点：
     *   1) 先判断是否已安装，已安装就直接返回，避免重复安装/覆盖状态；
     *   2) 把脚本包在 try/catch 里，任何异常都上报而不是抛给页面；
     *   3) 用 JSON 转义整段脚本文本，避免引号/换行破坏 evaluateJavascript 的表达式。
     */
    public static String buildLateInjectJs() {
        String js = Injector.script();
        if (js == null || js.length() == 0) {
            return "(function(){try{if(window.DSApp&&DSApp.log)DSApp.log('late-inject-empty-asset');}catch(e){}})();";
        }
        boolean enabled = Prefs.antiRecall();
        boolean debug = Prefs.debugLog();

        StringBuilder sb = new StringBuilder(js.length() + 512);
        sb.append("(function(){try{");
        sb.append("if(window.__DS_SHELL_INSTALLED__){");
        sb.append("if(window.DSApp&&DSApp.log)DSApp.log('late-inject-skip-already');");
        sb.append("return 'already';}");
        sb.append("window.__DS_APP_CFG__={antiRecall:").append(enabled ? "true" : "false")
                .append(",debug:").append(debug ? "true" : "false").append("};");
        sb.append(js);
        sb.append("try{if(window.DSApp&&DSApp.onReady)DSApp.onReady('late-injected');}catch(e2){}");
        sb.append("return 'installed';");
        sb.append("}catch(e){");
        sb.append("try{if(window.DSApp&&DSApp.log)DSApp.log('late-inject-fail: '+e);}catch(x){}");
        sb.append("return 'fail:'+e;}})()");
        return sb.toString();
    }

    /** 脚本是否已安装的探针（返回 "1" 表示已装，"0" 表示没有） */
    public static String probeJs() {
        return "(function(){try{return window.__DS_SHELL_INSTALLED__?'1':'0';}catch(e){return 'err';}})()";
    }
}
