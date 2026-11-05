package com.yg.dsweb;

import android.util.Log;

import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * 兜底崩溃捕获：把最近一次崩溃写进 App 私有目录，供"关于/诊断"页读取。
 * 不弹系统对话框、不上传、不重启，避免在低端机上制造二次故障。
 */
public final class CrashGuard {

    private static final String TAG = "DSWebCrash";
    private static String sLast = null;

    private CrashGuard() {
    }

    static void install() {
        final Thread.UncaughtExceptionHandler prev =
                Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    PrintWriter pw = new PrintWriter(sw);
                    e.printStackTrace(pw);
                    sLast = "thread=" + t.getName() + "\n" + sw.toString();
                    Log.e(TAG, sLast);
                    writeToDisk(sLast);
                } catch (Throwable ignored) {
                }
                if (prev != null) {
                    prev.uncaughtException(t, e);
                }
            }
        });
    }

    private static void writeToDisk(String text) {
        try {
            java.io.File f = new java.io.File(App.ctx().getFilesDir(), "last_crash.txt");
            java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
            fos.write(text.getBytes("UTF-8"));
            fos.close();
        } catch (Throwable ignored) {
        }
    }

    public static String lastCrash() {
        if (sLast != null) return sLast;
        try {
            java.io.File f = new java.io.File(App.ctx().getFilesDir(), "last_crash.txt");
            if (!f.exists()) return null;
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            byte[] buf = new byte[(int) f.length()];
            int off = 0;
            while (off < buf.length) {
                int r = in.read(buf, off, buf.length - off);
                if (r <= 0) break;
                off += r;
            }
            in.close();
            return new String(buf, 0, off, "UTF-8");
        } catch (Throwable t) {
            return null;
        }
    }

    public static void clear() {
        sLast = null;
        try {
            java.io.File f = new java.io.File(App.ctx().getFilesDir(), "last_crash.txt");
            if (f.exists()) f.delete();
        } catch (Throwable ignored) {
        }
    }
}
