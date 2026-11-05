// 独立验证 HTML 注入位置算法（与 Injector.injectIntoHtml 逐行等价，用于在非 Android 环境跑）
public class InjectTest {
    static int pass = 0, fail = 0;

    public static void main(String[] a) throws Exception {
        String payload = "<script>INJECTED</script>";

        String[] cases = {
            // head 存在：插在 <head ...> 之后
            "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>",
            "<html><head></head></html>",
            "<head><title>x</title></head>",
            // 无 head 有 html：插在 <html ...> 之后
            "<!doctype html><html><body>no head</body></html>",
            // 大写标签：大小写不敏感
            "<!DOCTYPE HTML><HTML><HEAD><TITLE>X</TITLE></HEAD></HTML>",
            // 完全无标签：插最前
            "just text no tags",
            // 真实形态：head 带属性
            "<!doctype html><html lang=\"en\" class=\"notranslate\"><head><meta charset=\"UTF-8\">",
            // head 之前有空白与换行
            "\n\n<!DOCTYPE html>\n<html>\n  <head>\n    <meta charset=utf-8>",
            // 只有 head 无 html
            "<head data-x><title>t</title></head><body>b</body>"
        };

        for (String src : cases) {
            String out = insert(src, payload);
            boolean present = out.indexOf(payload) >= 0;
            boolean lossless = out.replace(payload, "").equals(src);
            // 位置校验：payload 不能落在某个标签内部。
            // 判据：payload 起点之后，src 中该位置之前不应有未被闭合的 '<'。
            boolean wellPlaced = present && !insideTag(out, out.indexOf(payload));

            boolean ok = present && lossless && wellPlaced;
            System.out.printf("%s  present=%s lossless=%s placed=%s  %s%n",
                    ok ? "PASS" : "FAIL", present, lossless, wellPlaced,
                    src.length() > 52 ? src.substring(0, 52) + "..." : src);
            if (ok) pass++; else fail++;
        }

        // payload 内含 </script> 字面量时不应破坏结构
        String evil = "<script>var x='</scr' + 'ipt>';</script>";
        String out2 = insert("<html><head></head></html>", evil);
        boolean ok2 = out2.indexOf(evil) >= 0;
        System.out.printf("%s  payload 内 </script> 字面量安全%n", ok2 ? "PASS" : "FAIL");
        if (ok2) pass++; else fail++;

        System.out.println("\n== " + pass + " pass, " + fail + " fail ==");
        if (fail > 0) System.exit(1);
    }

    static String insert(String html, String payload) {
        int headIdx = idx(html, "<head");
        if (headIdx >= 0) {
            int tagEnd = html.indexOf('>', headIdx);
            if (tagEnd > 0) {
                int at = tagEnd + 1;
                return html.substring(0, at) + payload + html.substring(at);
            }
        }
        int htmlIdx = idx(html, "<html");
        if (htmlIdx >= 0) {
            int tagEnd = html.indexOf('>', htmlIdx);
            if (tagEnd > 0) {
                int at = tagEnd + 1;
                return html.substring(0, at) + payload + html.substring(at);
            }
        }
        int docStart = 0;
        String lower = html.length() > 64
                ? html.substring(0, 64).toLowerCase() : html.toLowerCase();
        if (lower.startsWith("<!doctype")) {
            int e = html.indexOf('>');
            if (e > 0) docStart = e + 1;
        }
        return html.substring(0, docStart) + payload + html.substring(docStart);
    }

    /** 判断 pos 是否位于一个未闭合的 '<' 之后（即被塞进了标签内部） */
    static boolean insideTag(String s, int pos) {
        if (pos < 0) return true;
        // 只看 pos 之前的部分（payload 自身以 '<' 开头，不能算进去）
        int lt = s.lastIndexOf('<', pos - 1);
        if (lt < 0) return false;              // 之前没有 '<'，安全
        int gt = s.lastIndexOf('>', pos - 1);
        return gt < lt;                         // '<' 之后没有 '>' → 还在标签里
    }

    static int idx(String s, String needle) {
        int n = needle.length(), max = s.length() - n;
        for (int i = 0; i <= max; i++) {
            if (s.regionMatches(true, i, needle, 0, n)) return i;
        }
        return -1;
    }
}
