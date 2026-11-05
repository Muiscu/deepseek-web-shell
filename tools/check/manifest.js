#!/usr/bin/env node
/**
 * 静态一致性检查：源码里的每个 Activity 都必须在 AndroidManifest 里声明。
 *
 * 背景：ArchiveActivity 曾"写了类但没登记"，点进去直接
 * ActivityNotFoundException 闪退 —— 编译器不报，只有用户点到才炸。
 * 这个检查把这类问题在构建期就拦住。
 *
 * 用法：node tools/check/manifest.js    退出码 0 = 全部声明齐全
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '../..');
var SRC_DIR = path.join(ROOT, 'app/src/com/yg/dsweb');
var MANIFEST = path.join(ROOT, 'app/AndroidManifest.xml');
var RES_VALUES = path.join(ROOT, 'app/res/values/strings.xml');

var errors = [];
var warnings = [];

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

/* ---------- 1. 收集源码里的 Activity ---------- */
var files = fs.readdirSync(SRC_DIR).filter(function (f) { return f.endsWith('.java'); });
var activities = [];
files.forEach(function (f) {
  var code = readText(path.join(SRC_DIR, f));
  // 只有 extends Activity / extends 某个 Activity 子类的才算
  if (/extends\s+(android\.app\.)?Activity\b/.test(code)) {
    activities.push('.' + f.replace(/\.java$/, ''));
  }
});

/* ---------- 2. 解析 manifest 里的声明 ---------- */
var manifest = readText(MANIFEST);
var declared = {};
var re = /<activity[^>]*android:name\s*=\s*"([^"]+)"/g;
var m;
while ((m = re.exec(manifest)) !== null) {
  declared[m[1].trim()] = true;
}

/* ---------- 3. 对比 ---------- */
activities.forEach(function (act) {
  if (!declared[act]) {
    errors.push('缺少 Activity 声明: ' + act + '  → 点进去会 ActivityNotFoundException 闪退');
  }
});

Object.keys(declared).forEach(function (d) {
  var name = d.replace(/^\./, '');
  if (!fs.existsSync(path.join(SRC_DIR, name + '.java'))) {
    // 可能是全限定名，做个宽松判断
    var shortName = d.split('.').pop();
    if (!fs.existsSync(path.join(SRC_DIR, shortName + '.java'))) {
      warnings.push('manifest 声明了但源码里找不到: ' + d);
    }
  }
});

/* ---------- 4. 检查 manifest 引用的字符串资源存在 ---------- */
var strings = readText(RES_VALUES);
var sre = /@string\/([a-zA-Z_][a-zA-Z0-9_]*)/g;
var missingStr = {};
while ((m = sre.exec(manifest)) !== null) {
  var key = m[1];
  if (missingStr[key]) continue;
  if (strings.indexOf('name="' + key + '"') < 0) {
    missingStr[key] = true;
    errors.push('manifest 引用了不存在的字符串资源: @string/' + key);
  }
}

/* ---------- 5. 检查布局/资源引用（本工程都用代码构建，允许为空） ---------- */

/* ---------- 输出 ---------- */
console.log('\n=== manifest 一致性检查 ===\n');
console.log('源码 Activity (' + activities.length + '): ' + activities.join(', '));
console.log('manifest 声明 (' + Object.keys(declared).length + '): '
    + Object.keys(declared).join(', '));
console.log('');

if (warnings.length) {
  console.log('警告:');
  warnings.forEach(function (w) { console.log('  ⚠ ' + w); });
}
if (errors.length) {
  console.log('错误:');
  errors.forEach(function (e) { console.log('  ✗ ' + e); });
  console.log('\n=== 检查失败：' + errors.length + ' 项 ===');
  process.exit(1);
}
console.log('✅ 全部 Activity 已正确声明，无缺失资源引用');
process.exit(0);
