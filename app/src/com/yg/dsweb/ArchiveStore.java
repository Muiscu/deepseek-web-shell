package com.yg.dsweb;

/**
 * 存档的跨页面数据通道。
 *
 * 为什么不再"直接问 MainActivity 要"：
 *   ArchiveActivity 之前依赖 MainActivity.instance() 去 evaluateJavascript 取数据。
 *   但 instance() 是弱引用 —— 主界面一旦被系统回收（低内存、切后台久了、
 *   或用户从通知/最近任务直接点进存档页），host 就是 null，存档页永远拿不到数据。
 *
 * 现在的做法：
 *   1) 主界面每次收到 onArchiveChanged / onHealth 时，主动把存档快照写进这里；
 *   2) 存档页优先读这里的快照，立刻有内容可显示；
 *   3) 只有在需要"最新数据"时才异步请求一遍刷新。
 *
 * 这样即使主界面已销毁，用户仍能看到上次抓到的存档。
 */
public final class ArchiveStore {

    private static volatile String sSnapshot = null;
    private static volatile long sUpdatedAt = 0;

    private ArchiveStore() {
    }

    /** 由主界面在收到脚本上报时调用 */
    public static void put(String json) {
        if (json == null || json.length() == 0) return;
        sSnapshot = json;
        sUpdatedAt = System.currentTimeMillis();
    }

    public static String get() {
        return sSnapshot;
    }

    public static long updatedAt() {
        return sUpdatedAt;
    }

    public static boolean has() {
        return sSnapshot != null && sSnapshot.length() > 0;
    }

    public static void clear() {
        sSnapshot = null;
        sUpdatedAt = 0;
    }
}
