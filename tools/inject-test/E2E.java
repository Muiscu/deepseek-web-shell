// 端到端：读真实 HTML + 真实 ds_shell.js，模拟 Injector.buildInlineScript + injectIntoHtml
import java.io.*;
import java.nio.charset.StandardCharsets;

public class E2E {
    static int pass=0, fail=0;
    public static void main(String[] a) throws Exception {
        String html = read("tools/inject-test/fixtures/page.html");
        String js   = read("app/assets/ds_shell.js");
        System.out.println("html=" + html.length() + "B, js=" + js.length() + "B");

        // ---- 1. buildInlineScript 等价：包 <script> + CFG ----
        StringBuilder sb = new StringBuilder();
        sb.append("<script>\n(function(){try{\n");
        sb.append("window.__DS_APP_CFG__={antiRecall:true,debug:false};\n");
        sb.append(js);
        sb.append("\n}catch(e){}})();\n");
        sb.append("</").append("script>");
        String payload = sb.toString();

        // ---- 2. injectIntoHtml 等价 ----
        String out = insert(html, payload);

        // 断言 A：payload 完整存在
        check("payload 完整注入", out.contains(payload));
        // 断言 B：无损（去掉 payload 等于原文）
        check("HTML 无损（其余字节未变）", out.replace(payload, "").equals(html));
        // 断言 C：位置在 <head> 之后、第一个 <script> 之前（先于 bundle）
        int headEnd = out.indexOf('>', out.indexOf("<head"));
        int payloadAt = out.indexOf(payload);
        int firstBundleScript = out.indexOf("<script", headEnd + 1);
        check("payload 紧跟 <head>", payloadAt > headEnd && payloadAt < headEnd + 2);
        // 断言 D：payload 必须早于"页面原有的第一个 script"。
        // 注意要在原始 html 上找，不能在 out 上找 —— out 里第一个 <script 就是 payload 自己的开头。
        int origFirstScript = idx(html, "<script");
        check("payload 先于前端 bundle 执行",
                origFirstScript < 0 || payloadAt < origFirstScript);
        // 断言 E：脚本体内不含裸 </script>（否则会提前闭合）
        int idx = js.length()==0? -1 : js.indexOf("</script>");
        check("脚本体内无裸 </script>", idx < 0);
        // 断言 F：SRI 的 script 标签未被破坏
        check("SRI 标签未被改动", countOf(out,"integrity=")==countOf(html,"integrity="));
        // 断言 G：script 标签数量只增加 1
        check("script 标签恰好多 1", countOf(out,"<script")==countOf(html,"<script")+1);

        System.out.println("\n== " + pass + " pass, " + fail + " fail ==");
        if (fail>0) System.exit(1);
    }
    static void check(String n, boolean ok){
        System.out.println((ok?"PASS  ":"FAIL  ")+n); if(ok)pass++; else fail++;
    }
    static int countOf(String s, String n){
        int c=0,i=0; while((i=s.indexOf(n,i))>=0){c++;i+=n.length();} return c;
    }
    static String read(String p) throws IOException {
        byte[] b = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(p));
        return new String(b, StandardCharsets.UTF_8);
    }
    static String insert(String html, String payload){
        int headIdx = idx(html, "<head");
        if (headIdx>=0){ int t=html.indexOf('>',headIdx); if(t>0){int at=t+1; return html.substring(0,at)+payload+html.substring(at);} }
        int h=idx(html,"<html");
        if (h>=0){ int t=html.indexOf('>',h); if(t>0){int at=t+1; return html.substring(0,at)+payload+html.substring(at);} }
        int ds=0; String low=html.length()>64?html.substring(0,64).toLowerCase():html.toLowerCase();
        if(low.startsWith("<!doctype")){int e=html.indexOf('>'); if(e>0)ds=e+1;}
        return html.substring(0,ds)+payload+html.substring(ds);
    }
    static int idx(String s, String n){
        int L=n.length(), m=s.length()-L;
        for(int i=0;i<=m;i++) if(s.regionMatches(true,i,n,0,L)) return i;
        return -1;
    }
}
