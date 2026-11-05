package com.yg.dsweb;

/** 保存最近一次脚本健康状态（跨页面可用，供诊断页读取）。 */
public final class ShellHealth {

    private static volatile String sLast = null;

    private ShellHealth() {
    }

    public static void put(String json) {
        sLast = json;
    }

    public static String get() {
        return sLast;
    }

    public static void clear() {
        sLast = null;
    }

    /** 把 JSON 变成人能读的几行，缺字段也安全 */
    public static String describe() {
        String s = sLast;
        if (s == null) return "（还没有收到脚本状态）";
        try {
            org.json.JSONObject o = new org.json.JSONObject(s);
            StringBuilder sb = new StringBuilder();
            sb.append("脚本版本：").append(o.optString("version", "?")).append('\n');
            sb.append("钩子层级：").append(o.optString("hook", "?"));
            String layers = o.optString("layers", "");
            if (layers.length() > 0) sb.append("  (").append(layers).append(")");
            sb.append('\n');
            sb.append("见到请求：").append(o.optInt("xhrSeen", 0)).append(" 次\n");
            sb.append("生成命中：").append(o.optInt("generateHits", 0)).append(" 次\n");
            sb.append("历史命中：").append(o.optInt("historyHits", 0)).append(" 次\n");
            sb.append("拦截撤回：").append(o.optInt("recalls", 0)).append(" 次\n");
            sb.append("存档条数：").append(o.optInt("total", 0)).append(" 条\n");
            sb.append("开启状态：").append(o.optBoolean("enabled", true) ? "开" : "关").append('\n');
            sb.append("钩子异常：").append(o.optInt("hookErrors", 0)).append(" 次");
            String urls = o.optString("lastUrls", "");
            if (urls.length() > 0) {
                sb.append("\n最近命中路径：").append(urls);
            }
            return sb.toString();
        } catch (Throwable t) {
            return s;
        }
    }

    /** 一句话结论，直接回答"防撤回到底有没有在工作" */
    public static String verdict() {
        String s = sLast;
        if (s == null) {
            return "⛔ 尚未收到脚本状态：脚本可能没有注入成功。"
                    + "请确认已在设置里打开「启动时即注入」，然后重新加载页面。";
        }
        try {
            org.json.JSONObject o = new org.json.JSONObject(s);
            String hook = o.optString("hook", "none");
            int seen = o.optInt("xhrSeen", 0);
            int gen = o.optInt("generateHits", 0);
            int hist = o.optInt("historyHits", 0);

            if ("none".equals(hook) || "failed".equals(hook)) {
                return "⛔ 钩子未安装（hook=" + hook + "）。这是失效的直接原因。";
            }
            if (seen == 0) {
                return "⚠ 钩子已装在 " + hook + " 层，但还没观察到任何请求。"
                        + "请发一条消息后再回来查看。";
            }
            if (gen == 0 && hist == 0) {
                return "⚠ 已观察到 " + seen + " 个请求，但没有一个命中对话接口。"
                        + "可能是接口路径变了 —— 请把下方「最近命中路径」发我。";
            }
            return "✅ 工作正常：钩子在 " + hook + " 层，对话接口命中 "
                    + (gen + hist) + " 次，已拦截 " + o.optInt("recalls", 0) + " 次。";
        } catch (Throwable t) {
            return "无法解析脚本状态。";
        }
    }
}
