package com.yg.dsweb;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 存档导出目录。
 * API 29+ 由于分区存储，写公共目录受限，所以统一下发到 App 私有目录，
 * 再通过 FileProvider / 系统分享让用户取走。
 */
public final class ArchiveDir {

    private ArchiveDir() {
    }

    public static File get() {
        File base = App.ctx().getExternalFilesDir("archive");
        if (base == null) {
            base = new File(App.ctx().getFilesDir(), "archive");
        }
        if (!base.exists()) {
            //noinspection ResultOfMethodCallIgnored
            base.mkdirs();
        }
        return base;
    }

    public static String stamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
    }
}
