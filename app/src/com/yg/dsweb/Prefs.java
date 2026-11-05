package com.yg.dsweb;

import android.content.Context;
import android.content.SharedPreferences;

/** 设置持久化。全部集中在单一 SharedPreferences，开关即写即生效。 */
public final class Prefs {

    private static final String FILE = "dsweb_prefs";

    public static final String KEY_ANTI_RECALL = "anti_recall_enabled";
    public static final String KEY_ARCHIVE_MIRROR = "archive_mirror";
    public static final String KEY_INJECT_ON_START = "inject_on_page_start";
    public static final String KEY_SHOW_BANNER = "show_compat_banner";
    public static final String KEY_KEEP_SCREEN_ON = "keep_screen_on";
    public static final String KEY_LAST_IMPORT = "last_import_ts";
    public static final String KEY_RECALL_COUNT = "recall_count";
    public static final String KEY_DEBUG_LOG = "debug_log";
    public static final String KEY_UA_OVERRIDE = "ua_override";

    private static SharedPreferences sp;

    private Prefs() {
    }

    static void init(Context c) {
        if (sp == null) {
            sp = c.getApplicationContext()
                    .getSharedPreferences(FILE, Context.MODE_PRIVATE);
        }
    }

    private static SharedPreferences p() {
        return sp;
    }

    public static boolean antiRecall() {
        return p().getBoolean(KEY_ANTI_RECALL, true);
    }

    public static void setAntiRecall(boolean v) {
        p().edit().putBoolean(KEY_ANTI_RECALL, v).apply();
    }

    public static boolean injectOnPageStart() {
        return p().getBoolean(KEY_INJECT_ON_START, true);
    }

    public static void setInjectOnPageStart(boolean v) {
        p().edit().putBoolean(KEY_INJECT_ON_START, v).apply();
    }

    public static boolean showBanner() {
        return p().getBoolean(KEY_SHOW_BANNER, true);
    }

    public static void setShowBanner(boolean v) {
        p().edit().putBoolean(KEY_SHOW_BANNER, v).apply();
    }

    public static boolean keepScreenOn() {
        return p().getBoolean(KEY_KEEP_SCREEN_ON, false);
    }

    public static void setKeepScreenOn(boolean v) {
        p().edit().putBoolean(KEY_KEEP_SCREEN_ON, v).apply();
    }

    public static boolean debugLog() {
        return p().getBoolean(KEY_DEBUG_LOG, false);
    }

    public static void setDebugLog(boolean v) {
        p().edit().putBoolean(KEY_DEBUG_LOG, v).apply();
    }

    public static int recallCount() {
        return p().getInt(KEY_RECALL_COUNT, 0);
    }

    public static void incRecallCount() {
        p().edit().putInt(KEY_RECALL_COUNT, recallCount() + 1).apply();
    }

    public static void resetRecallCount() {
        p().edit().putInt(KEY_RECALL_COUNT, 0).apply();
    }

    public static String uaOverride() {
        return p().getString(KEY_UA_OVERRIDE, null);
    }

    public static void setUaOverride(String v) {
        p().edit().putString(KEY_UA_OVERRIDE, v).apply();
    }

    public static long lastImport() {
        return p().getLong(KEY_LAST_IMPORT, 0L);
    }

    public static void setLastImport(long v) {
        p().edit().putLong(KEY_LAST_IMPORT, v).apply();
    }
}
