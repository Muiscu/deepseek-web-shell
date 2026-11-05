#!/usr/bin/env bash
# 构建前检查：静态一致性 + JS 语法 + 三套测试
# 任何一项失败即中止，避免把"点了就闪退"的包发出去。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [0/5] 版本同步（manifest → 注入脚本）"
node tools/check/syncversion.js

echo "==> [1/5] manifest 一致性"
node tools/check/manifest.js

echo "==> [2/5] 注入脚本 ES5 语法"
node -e "require('./tools/js-test/node_modules/acorn').parse(require('fs').readFileSync('app/assets/ds_shell.js','utf8'),{ecmaVersion:5,sourceType:'script'});console.log('ES5 OK')"

echo "==> [3/5] 功能测试"
node tools/js-test/run.js      | tail -1
node tools/js-test/watchdog.js | tail -1
node tools/js-test/lateinject.js | tail -1
node tools/js-test/postrecall.js | tail -1
node tools/js-test/leadslash.js  | tail -1
node tools/js-test/diagnostics.js | tail -1
node tools/js-test/fetchstream.js | tail -1
node tools/js-test/relpath.js | tail -1
node tools/js-test/diagtruth.js | tail -1
node tools/js-test/growfix.js | tail -1
node tools/js-test/rawdelta.js | tail -1
node tools/js-test/fragassign.js | tail -1

echo "==> [4/5] 对抗性审计"
node tools/js-test/audit/adversarial.js  | tail -1
node tools/js-test/audit/adversarial2.js | tail -1
node tools/js-test/audit/fallback.js     | tail -1

echo "==> [5/5] 端到端注入"
export JAVA_HOME="${JAVA_HOME:-/c/Program Files/Zulu/zulu-17}"
"$JAVA_HOME/bin/javac" -encoding UTF-8 -d tools/inject-test/out tools/inject-test/E2E.java 2>/dev/null || true
"$JAVA_HOME/bin/java" -Dfile.encoding=UTF-8 -cp tools/inject-test/out E2E | tail -1

echo "==> PREFLIGHT OK"
