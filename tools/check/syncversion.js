#!/usr/bin/env node
/**
 * 构建前把 app/assets/ds_shell.js 里的 VERSION 同步成 manifest 的 versionName。
 *
 * 为什么：脚本内部 VERSION 曾长期停在 1.1.0，导致诊断页显示"脚本版本 1.1.0"
 * 而实际包已是 1.3.x，排查时被误导。版本号必须只有一个真相来源（manifest）。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var MANIFEST = path.join(ROOT, 'app/AndroidManifest.xml');
var SHELL = path.join(ROOT, 'app/assets/ds_shell.js');

var m = fs.readFileSync(MANIFEST, 'utf8');
var mm = /android:versionName\s*=\s*"([^"]+)"/.exec(m);
if (!mm) { console.log('manifest 里找不到 versionName'); process.exit(1); }
var ver = mm[1];

var s = fs.readFileSync(SHELL, 'utf8');
var re = /var VERSION = '[^']*';/;
if (!re.test(s)) { console.log('脚本里找不到 VERSION'); process.exit(1); }
var old = re.exec(s)[0];
var neu = "var VERSION = '" + ver + "';";
if (old === neu) { console.log('版本已同步: ' + ver); process.exit(0); }
s = s.replace(re, neu);
fs.writeFileSync(SHELL, s, 'utf8');
console.log('版本已同步: ' + old + ' → ' + neu);
