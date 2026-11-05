# DeepSeek Web Shell

把 DeepSeek 网页端包装成 Android 应用，并带一个本地存档钩子：回复在生成过程中被保存下来，即使之后被服务端屏蔽，也能在本机找回。

- 纯 WebView 外壳，不代理、不改包，不收集任何数据
- `minSdk 22`（Android 5.1+），无 AndroidX / Gradle 依赖
- 存档只写在本机 `localStorage`

## 构建

需要 JDK 17+ 与 Android SDK（build-tools 34 / platforms;android-34）。

```bash
bash toolchain/build_apk.sh \
  --src app/src --res app/res --assets app/assets \
  --manifest app/AndroidManifest.xml \
  --min-sdk 22 --target-sdk 34 --compile-sdk 34 \
  --out out/app.apk
```

脚本会依次执行 aapt2 → javac → d8 → zipalign → apksigner，产物为可直接安装的 APK。

## 结构

```
app/
├── AndroidManifest.xml
├── assets/ds_shell.js        注入脚本（ES5）
├── res/                      资源与图标
└── src/com/yg/dsweb/         Java 源码
tools/
├── js-test/                  注入脚本测试
├── inject-test/              端到端注入验证
└── check/                    manifest / 版本一致性检查
docs/                         实现说明
```

## 测试

```bash
bash toolchain/preflight.sh
```

覆盖注入脚本的功能、对抗性审计与端到端注入。

## 说明

`ds_shell.js` 通过改写 `XMLHttpRequest` 的 `responseText` getter 接管响应流，把生成过程中的内容实时写入本地存档。实现细节见 `docs/anti-recall.md`。

参考了 GreasyFork 上 Franky T 的 DeepSeek Anti-recall 脚本思路，针对当前版本重写。

## License

MIT
