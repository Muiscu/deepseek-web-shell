package com.yg.dsweb;

/** 原始 SSE 探针数据的存放点（诊断用）。 */
public final class ProbeStore {

    private static volatile String sLast = null;

    private ProbeStore() {
    }

    public static void put(String json) {
        if (json == null || json.length() == 0) return;
        sLast = json;
    }

    public static String get() {
        return sLast;
    }

    public static void clear() {
        sLast = null;
    }

    public static boolean has() {
        return sLast != null && sLast.length() > 0;
    }

    /** 给人看的摘要：形态分布（比原始事件更有价值） */
    public static String describe() {
        String s = sLast;
        if (s == null) {
            return "（还没抓到事件）\n先发一条消息，再回来点「导出诊断」。";
        }
        try {
            org.json.JSONObject o = new org.json.JSONObject(s);
            org.json.JSONArray shapes = o.optJSONArray("shapes");
            StringBuilder sb = new StringBuilder();
            sb.append("收到事件数：").append(o.optInt("total", 0)).append('\n');
            if (shapes != null && shapes.length() > 0) {
                sb.append("\n事件形态分布：\n");
                for (int i = 0; i < shapes.length() && i < 20; i++) {
                    org.json.JSONObject it = shapes.optJSONObject(i);
                    if (it == null) continue;
                    sb.append("  ×").append(it.optInt("count", 0))
                            .append("  ").append(it.optString("sig", "")).append('\n');
                }
            }
            return sb.toString();
        } catch (Throwable t) {
            return String.valueOf(s);
        }
    }
}
