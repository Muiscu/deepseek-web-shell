# toolchain/ — Android build toolchain (no Gradle)

Self-contained under `C:\Tings\mine\deepseek\work\Deep\toolchain\`.
Nothing outside `toolchain/` is touched.

## Layout

```
toolchain/
├── android-sdk/                       # ANDROID SDK ROOT
│   ├── build-tools/34.0.0/            # aapt2, d8, zipalign, apksigner, dexdump
│   ├── platforms/android-34/android.jar
│   ├── platform-tools/                # adb, fastboot
│   └── licenses/
├── cmdline-tools/latest/bin/sdkmanager.bat    # cmdline-tools 12.0
├── build_apk.sh                       # the Gradle-free build pipeline (637 lines)
├── env.sh                             # source me: JAVA_HOME + ANDROID_SDK_ROOT + PATH
├── run-selftest.sh                    # one-shot build + verify the selftest project
├── README.md                          # this file
├── keys/debug.keystore                # PKCS12, alias androiddebugkey, storepass/keypass "android"
└── selftest/
    ├── AndroidManifest.xml            # minSdkVersion=22 targetSdkVersion=34
    ├── src/com/example/selftest/MainActivity.java
    ├── res/values/strings.xml, res/layout/activity_main.xml
    └── out/selftest.apk               # signed APK produced by the pipeline
```

## Environment

| Item | Value |
| --- | --- |
| SDK root | `C:\Tings\mine\deepseek\work\Deep\toolchain\android-sdk` |
| cmdline-tools | `...\toolchain\cmdline-tools\latest` (Pkg.Revision 12.0) |
| build-tools | `34.0.0` |
| platform | `android-34` |
| platform-tools | `37.0.1` (adb / fastboot) |
| **JAVA_HOME for SDK tools** | `C:\Program Files\Zulu\zulu-17` (17.0.15) |
| other JDKs present | zulu-21 (21.0.7), zulu-24 (24.0.1), zulu-25 (25.0.1), jre1.8.0_481 (**JDK 8 — unusable**) |

`java` on PATH is JRE 1.8; `javac` on PATH is Zulu 25. **Do not trust PATH.**
sdkmanager / d8 / apksigner / keytool all need JDK 17+; `build_apk.sh` picks the
lowest JDK ≥ 17 it finds (17 preferred) and exports `JAVA_HOME` itself.

```bash
source toolchain/env.sh     # prints the resolved JAVA_HOME / SDK root / java
```

## build_apk.sh

```bash
bash toolchain/build_apk.sh --root toolchain/selftest --out toolchain/selftest/out/selftest.apk
bash toolchain/run-selftest.sh          # same thing + standalone verification block
bash toolchain/build_apk.sh --help      # full option list
```

### Parameters

| Option | Meaning | Default |
| --- | --- | --- |
| `-s, --src DIR` | Java source root, repeatable | auto-detect `app/src/main/java`, `app/src`, `src/main/java`, `src`, `selftest/src` |
| `-r, --res DIR` | resource root, repeatable | auto-detect `app/src/main/res`, `app/res`, `app/src/res`, `src/main/res`, `res`, `selftest/res` |
| `-a, --assets DIR` | assets root (`aapt2 -A`) | auto-detect, else none |
| `-m, --manifest FILE` | AndroidManifest.xml | auto-detect, 6 candidates |
| `--root DIR` | project root for auto-detection | parent of `toolchain/` |
| `-o, --out FILE` | output APK | `<root>/build/app.apk` |
| `--version-code N` | versionCode | `1` |
| `--version-name S` | versionName | `1.0` |
| `--pkg NAME` | force R.java package (`--custom-package`) | from manifest |
| `--min-sdk N` | minSdkVersion (injected when the manifest has no `<uses-sdk>`) | `22` |
| `--target-sdk N` | targetSdkVersion | `34` |
| `--compile-sdk N` | `platforms/android-N/android.jar` | `34` |
| `--build-tools VER` | build-tools directory | `34.0.0` |
| `--d8-min-api N` | `d8 --min-api` | same as `--min-sdk` |
| `--d8-heap MB` | `JAVA_TOOL_OPTIONS=-XmxNm` for d8 | unset |
| `--d8-args "A B C"` | extra raw d8 args | unset |
| `--lib FILE` | extra classpath jar for javac **and** `d8 --lib`, repeatable | none |
| `--sdk PATH` | SDK root | `$ANDROID_SDK_ROOT` / `$ANDROID_HOME` / `toolchain/android-sdk` |
| `--java-home PATH` | JDK home (17+) | auto-detect |
| `--keystore FILE` | keystore, auto-created if missing | `toolchain/keys/debug.keystore` |
| `--ks-alias NAME` | key alias | `androiddebugkey` |
| `--ks-store-pass PASS` / `--ks-key-pass PASS` | passwords | `android` / `android` |
| `--ks-dname STR` | `keytool -dname` | `CN=Android Debug,O=Android,C=US` |
| `--no-sign` | skip signing (aligned + unsigned) | off |
| `--skip-verify` | skip the verification block | off |
| `--stage-root DIR` | ASCII staging root | `toolchain/.stage` |
| `--keep-work` | keep `<out>/work/` | off |
| `--clean-only` | delete outputs and exit | off |
| `-q, --quiet` | less logging | off |
| `-h, --help` | usage | — |

Exit code is 0 only on a fully successful build (`set -euo pipefail` + `die`).

### Pipeline

1. `aapt2 compile --dir <res> -o work/res/res-N.zip`
2. `aapt2 link -I android.jar --manifest ... --java work/gen -R <zip>... -o work/base.apk`
3. `javac -source 8 -target 8 -classpath android.jar(;libs) -d work/classes` (via `@argfile`)
4. `jar -cf work/classes.jar` → `d8 --min-api N --release --lib android.jar` → `classes.dex`
5. `jar -uf base.apk classes.dex` → `<out>-unsigned.apk`
6. `zipalign -p -f 4` → `<out>-aligned.apk`
7. `apksigner sign` (v1+v2+v3) → `<out>`
8. `aapt2 dump badging` + `apksigner verify --verbose` (hard-fails on a wrong minSdk or bad signature)

## Known traps (measured on this box, not guessed)

1. **`aapt2 --dir` dies on non-ASCII paths.** A directory containing CJK characters
   fails with `error: failed to open directory: 系统找不到指定的文件。(2)` although the
   path is perfectly valid. `build_apk.sh` detects non-ASCII in any input/output path,
   re-roots the entire build into an ASCII staging tree (`toolchain/.stage/stage-*`),
   then copies the artifact back under the real (possibly Chinese) name.
2. **Never stage under `%TEMP%` / `/tmp`.** `aapt2 compile --dir ... -o /tmp/x.zip`
   fails with `error: 数据无效。(13)`. Staging therefore lives next to the toolchain.
3. **Spaces alone are fine** (`with space/` builds cleanly) as long as the path is
   ASCII and every argument goes through `cygpath -w` + quoting.
4. **Never hand raw POSIX paths to `.exe` tools.** `--dir C:/.../res` is rejected;
   always convert with `cygpath -w`.
5. **Never join a `;`-separated classpath before `cygpath`.** `cygpath -w` mangles
   the drive letter of the second component (`C:` → `CM-^@M-:`), which breaks javac
   with `MalformedInputException`. Convert each component separately, then join.
6. **javac `@argfile` is read with the platform charset (GBK here).** A UTF-8 argfile
   containing a non-ASCII path dies with `MalformedInputException`. Any non-ASCII
   `--lib` is therefore copied into `work/libs/lib-N.jar` first.
7. **PATH traps**: `java` = JRE 1.8, `javac` = Zulu 25. Zulu 25 still accepts
   `-source/-target 8` but warns; JDK 17 is silent and is what the script selects.
8. **d8 heap**: default is small — `--d8-heap 2048` for real projects.
9. **`jar -uf` on the APK works** and keeps entries aligned; `zip` is not installed
   on this box, so `jar` (from the JDK) is the packer.
10. **zipalign strictly before apksigner**, never after — signing would break alignment.
11. **`apksigner` leaves `<apk>.idsig`** (v4 signature). Harmless, always next to the APK.
12. **`<uses-sdk>` in the manifest wins over `--min-sdk`.** aapt2 only *injects*
    `<uses-sdk>` when the manifest has none; the script warns instead of failing.

## Verification commands

```bash
BT=toolchain/android-sdk/build-tools/34.0.0
APK=toolchain/selftest/out/selftest.apk
"$BT/aapt2.exe"       dump badging "$(cygpath -w $APK)"
"$BT/apksigner.bat"   verify --verbose --print-certs "$(cygpath -w $APK)"
"$BT/zipalign.exe"    -c -v 4 "$(cygpath -w $APK)"
"$BT/dexdump.exe"     "$(cygpath -w toolchain/selftest/out/work/dex/classes.dex)"
```
