#! /usr/bin/env bash
# =============================================================================
#  toolchain/build_apk.sh  --  Gradle-free Android APK build pipeline
#
#  aapt2 compile -> aapt2 link (+R.java) -> javac(8) -> d8 -> zip -> zipalign -> apksigner
#
#  Requires: bash (Git Bash on Windows), JDK 17+, Android SDK
#            (build-tools + platforms;android-<N>) + platform-tools.
#  Runs on Windows (Git Bash / MSYS2) and Linux/macOS.
#
#  Design notes
#   * Every native tool (.exe/.bat) gets a native Windows path via cygpath -w.
#   * aapt2 `--dir` cannot enumerate a directory whose path contains non-ASCII
#     characters (verified: CJK path -> "failed to open directory"). When any
#     input/output path is non-ASCII the whole pipeline is re-rooted into an
#     ASCII-only staging tree and the resulting APK is copied back.
#   * Never stage under %TEMP% (/tmp): aapt2's output writer failed there
#     ("数据无效 (13)"). Staging always lives next to the toolchain.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."

# ------------------------------- defaults -----------------------------------
SRC_IN=()                   # -s/--src   (repeatable)
RES_IN=()                   # -r/--res   (repeatable)
ASSETS_IN=""                # -a/--assets
MANIFEST_IN=""              # -m/--manifest
OUT_IN=""                   # -o/--out
PKG_NAME=""                 # --pkg
VERSION_CODE="1"
VERSION_NAME="1.0"
MIN_SDK="22"
TARGET_SDK="34"
COMPILE_SDK="34"
BUILD_TOOLS_VER="34.0.0"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$SCRIPT_DIR/android-sdk}}"
JAVA_HOME_OPT=""
KEYSTORE=""
KS_ALIAS="androiddebugkey"
KS_STORE_PASS="android"
KS_KEY_PASS="android"
KS_DNAME="CN=Android Debug,O=Android,C=US"
KS_KEYALG="RSA"
KS_KEYSIZE="2048"
KS_VALIDITY="10000"
EXTRA_LIBS=()
D8_MIN_API=""
D8_HEAP=""
D8_EXTRA_ARGS=""
KEEP_WORK=0
CLEAN_ONLY=0
QUIET=0
SKIP_SIGN=0
SKIP_VERIFY=0
STAGE_ROOT_OPT=""

# ------------------------------- logging ------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "${TERM:-dumb}" != "dumb" ]; then
  C_R="$(tput setaf 1 2>/dev/null || true)"; C_G="$(tput setaf 2 2>/dev/null || true)"
  C_Y="$(tput setaf 3 2>/dev/null || true)"; C_B="$(tput setaf 4 2>/dev/null || true)"
  C_0="$(tput sgr0 2>/dev/null || true)"
else
  C_R=""; C_G=""; C_Y=""; C_B=""; C_0=""
fi

ts()   { date +%H:%M:%S; }
log()  { [ "$QUIET" -eq 1 ] || printf '%s[%s]%s %s\n' "$C_B" "$(ts)" "$C_0" "$*"; }
ok()   { [ "$QUIET" -eq 1 ] || printf '%s[%s] OK %s%s %s\n' "$C_G" "$(ts)" "$C_0" "$C_0" "$*"; }
warn() { printf '%s[%s] WARN%s %s\n' "$C_Y" "$(ts)" "$C_0" "$*"; }
die()  { printf '%s[%s] FAIL%s %s\n' "$C_R" "$(ts)" "$C_0" "$*" >&2; exit 1; }
step() { printf '\n%s==> [%s] %s%s\n' "$C_B" "$(ts)" "$*" "$C_0"; }

trap 'rc=$?; [ $rc -eq 0 ] || printf "%s[%s] FAIL%s build_apk.sh aborted (exit %s) at line %s\n" "$C_R" "$(ts)" "$C_0" "$rc" "$LINENO" >&2' EXIT

usage() {
  cat <<EOF
build_apk.sh -- Gradle-free Android APK builder (aapt2 + javac + d8 + zipalign + apksigner)

USAGE
  bash toolchain/build_apk.sh [options]

INPUT
  -s, --src DIR          Java source root (repeatable)        default: auto-detect
                         (app/src/main/java, app/src, src/main/java, src, selftest/src)
  -r, --res DIR          Resource root (repeatable)           default: auto-detect
                         (app/src/main/res, app/res, app/src/res, src/main/res, res, selftest/res)
  -a, --assets DIR       Assets root (aapt2 -A)               default: auto-detect, else none
  -m, --manifest FILE    AndroidManifest.xml                  default: auto-detect
  --root DIR             Project root for the auto-detection  default: parent of toolchain/
  -o, --out FILE         Output APK                           default: <root>/build/app.apk

VERSION / SDK
  --version-code N       versionCode                           default: 1
  --version-name S       versionName                           default: 1.0
  --pkg NAME             Force R.java package (--custom-package) default: from manifest
  --min-sdk N            minSdkVersion                         default: 22
  --target-sdk N         targetSdkVersion                      default: 34
  --compile-sdk N        android.jar API level                 default: 34
  --build-tools VER      build-tools directory version          default: 34.0.0
  --d8-min-api N         d8 --min-api                          default: same as --min-sdk
  --d8-heap MB           JVM heap for d8 (JAVA_TOOL_OPTIONS -Xmx)
  --d8-args "A B C"      Extra raw arguments appended to the d8 command line
  --lib FILE             Extra classpath jar for javac + d8 (repeatable)
  --sdk PATH             Android SDK root   default: \$ANDROID_SDK_ROOT / \$ANDROID_HOME / toolchain/android-sdk
  --java-home PATH       JDK home (17+ required)  default: auto-detect (zulu-17/21, jbr, ...)

SIGNING
  --keystore FILE        Keystore (auto-created if missing)   default: toolchain/keys/debug.keystore
  --ks-alias NAME                                              default: androiddebugkey
  --ks-store-pass PASS                                         default: android
  --ks-key-pass PASS                                           default: android
  --ks-dname STR                                               default: CN=Android Debug,O=Android,C=US
  --no-sign              Skip signing (aligned but unsigned APK)
  --skip-verify          Skip the verification block

MISC
  --stage-root DIR       Where the ASCII staging tree lives  default: <toolchain>/.stage
  --keep-work            Keep the intermediate work/ tree
  --clean-only           Delete outputs and exit
  -q, --quiet            Less logging
  -h, --help             This help

PIPELINE
  1  aapt2 compile --dir <res> -o <work>/res/res-N.zip
  2  aapt2 link -I android.jar --manifest ... --java <work>/gen -R <zip>... -o <work>/base.apk
  3  javac -source 8 -target 8 -classpath android.jar(:extra libs) -d <work>/classes
  4  jar -cf <work>/classes.jar ; d8 --min-api N --release --lib android.jar -> classes.dex
  5  jar -uf <work>/base.apk classes.dex                      -> <out>-unsigned.apk
  6  zipalign -p -f 4                                         -> <out>-aligned.apk
  7  apksigner sign (v1+v2+v3)                                -> <out>
  +  aapt2 dump badging + apksigner verify

EXAMPLES
  bash toolchain/build_apk.sh \\
      --root toolchain/selftest \\
      --out  toolchain/selftest/out/selftest.apk

  bash toolchain/build_apk.sh -o build/app-debug.apk --version-code 7 --version-name 1.2.3

  bash toolchain/build_apk.sh --clean-only -o build/app.apk
EOF
}

need_val() { [ $# -ge 2 ] || die "Option $1 requires a value"; }
# ------------------------------ arg parsing ---------------------------------
if [ $# -eq 0 ]; then usage; exit 0; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -s|--src)        need_val "$@"; SRC_IN+=("$2"); shift 2 ;;
    -r|--res)        need_val "$@"; RES_IN+=("$2"); shift 2 ;;
    -a|--assets)     need_val "$@"; ASSETS_IN="$2"; shift 2 ;;
    -m|--manifest)   need_val "$@"; MANIFEST_IN="$2"; shift 2 ;;
    --root)          need_val "$@"; PROJECT_ROOT="$2"; shift 2 ;;
    -o|--out)        need_val "$@"; OUT_IN="$2"; shift 2 ;;
    --version-code)  need_val "$@"; VERSION_CODE="$2"; shift 2 ;;
    --version-name)  need_val "$@"; VERSION_NAME="$2"; shift 2 ;;
    --pkg)           need_val "$@"; PKG_NAME="$2"; shift 2 ;;
    --min-sdk)       need_val "$@"; MIN_SDK="$2"; shift 2 ;;
    --target-sdk)    need_val "$@"; TARGET_SDK="$2"; shift 2 ;;
    --compile-sdk)   need_val "$@"; COMPILE_SDK="$2"; shift 2 ;;
    --build-tools)   need_val "$@"; BUILD_TOOLS_VER="$2"; shift 2 ;;
    --d8-min-api)    need_val "$@"; D8_MIN_API="$2"; shift 2 ;;
    --d8-heap)       need_val "$@"; D8_HEAP="$2"; shift 2 ;;
    --d8-args)       need_val "$@"; D8_EXTRA_ARGS="$2"; shift 2 ;;
    --lib)           need_val "$@"; EXTRA_LIBS+=("$2"); shift 2 ;;
    --sdk)           need_val "$@"; SDK_ROOT="$2"; shift 2 ;;
    --java-home)     need_val "$@"; JAVA_HOME_OPT="$2"; shift 2 ;;
    --keystore)      need_val "$@"; KEYSTORE="$2"; shift 2 ;;
    --ks-alias)      need_val "$@"; KS_ALIAS="$2"; shift 2 ;;
    --ks-store-pass) need_val "$@"; KS_STORE_PASS="$2"; shift 2 ;;
    --ks-key-pass)   need_val "$@"; KS_KEY_PASS="$2"; shift 2 ;;
    --ks-dname)      need_val "$@"; KS_DNAME="$2"; shift 2 ;;
    --stage-root)    need_val "$@"; STAGE_ROOT_OPT="$2"; shift 2 ;;
    --no-sign)       SKIP_SIGN=1; shift ;;
    --skip-verify)   SKIP_VERIFY=1; shift ;;
    --keep-work)     KEEP_WORK=1; shift ;;
    --clean-only)    CLEAN_ONLY=1; shift ;;
    -q|--quiet)      QUIET=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "Unknown option: $1 (try --help)" ;;
  esac
done

# ------------------------- platform / path helpers ---------------------------
IS_WINDOWS=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;; esac

w()  { if [ "$IS_WINDOWS" -eq 1 ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }        # native path
wp() { if [ "$IS_WINDOWS" -eq 1 ]; then cygpath -m "$1"; else printf '%s' "$1"; fi; }        # native, forward slashes
qwa() { printf '"%s"' "$(w "$1")"; }

is_dir()  { [ -d "$1" ]; }
is_file() { [ -f "$1" ]; }

# abs(): absolute POSIX path (understands C:\... and \; tolerates trailing space)
abs() {
  local p="$1"
  if [ "$IS_WINDOWS" -eq 1 ]; then
    case "$p" in
      [A-Za-z]:*) p="$(cygpath -u "$p")" ;;
      \\*)        p="$(cygpath -u "$p")" ;;
    esac
  fi
  case "$p" in
    /*) ;;
    *) p="$PWD/$p" ;;
  esac
  if is_dir "$p"; then ( cd -- "$p" && pwd ); else
    ( cd -- "$(dirname -- "$p")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename -- "$p")" ) 2>/dev/null || printf '%s' "$p"
  fi
}

# non-ASCII detector (byte-wise, locale independent)
non_ascii() { LC_ALL=C printf '%s' "$1" | LC_ALL=C grep -q '[^ -~]'; }

# ------------------------------ JDK detection --------------------------------
java_major() {  # $1 = java binary; echoes major version, or 0
  local j="$1" out
  [ -f "$j" ] || [ -f "$j.exe" ] || command -v "$j" >/dev/null 2>&1 || { echo 0; return; }
  out="$( "$j" -version 2>&1 | head -n 1 )" || { echo 0; return; }
  case "$out" in
    *'"1.'*) out="${out#*\"1.}"; echo "${out%%[!0-9]*}" ;;
    *'"'*)   out="${out#*\"}";   echo "${out%%[!0-9]*}" ;;
    *)       echo 0 ;;
  esac
}

detect_java_home() {
  local cands=() c jv best="" bestv=0
  [ -n "$JAVA_HOME_OPT" ] && cands+=("$(abs "$JAVA_HOME_OPT")")
  [ -n "${JAVA_HOME:-}" ] && cands+=("$JAVA_HOME")
  if [ "$IS_WINDOWS" -eq 1 ]; then
    cands+=("/c/Program Files/Zulu/zulu-17" "/c/Program Files/Zulu/zulu-21" \
            "/c/Program Files/Zulu/zulu-25" "/c/Program Files/Zulu/zulu-24" \
            "/c/Program Files/Java/jdk-21" "/c/Program Files/Java/jdk-17" \
            "/c/Program Files/Eclipse Adoptium/jdk-17" "/c/Program Files/Microsoft/jdk-17" \
            "/c/Program Files/Android/Android Studio/jbr" "/c/Program Files/Java/jdk-11")
  else
    cands+=("/usr/lib/jvm/java-17-openjdk-amd64" "/usr/lib/jvm/java-21-openjdk-amd64" \
            "/usr/lib/jvm/default-java" "/opt/jdk-17" "/opt/jdk-21")
  fi
  for c in "${cands[@]}"; do
    is_dir "$c" || continue
    jv="$(java_major "$c/bin/java")"; jv="${jv:-0}"
    # keep the LOWEST JDK >= 17: 17 keeps `-source/-target 8` warning-free and
    # avoids build-tools classes compiled for 21+ (JDK 25 rejects some of them)
    if [ "$jv" -ge 17 ] && { [ -z "$best" ] || [ "$jv" -lt "$bestv" ]; }; then best="$c"; bestv="$jv"; fi
  done
  if [ -z "$best" ]; then
    local wj jv2
    wj="$(command -v java 2>/dev/null || true)"
    jv2="$(java_major "$wj")"; jv2="${jv2:-0}"
    [ "$jv2" -ge 17 ] || die "No JDK 17+ found (java on PATH reports ${jv2:-unknown}); pass --java-home PATH"
    best="$(dirname "$(dirname "$wj")")"; bestv="$jv2"
  fi
  printf '%s' "$best"
}

JHOME="$(detect_java_home)"
JHOME="$(abs "$JHOME")"
[ -f "$JHOME/bin/java" ] || [ -f "$JHOME/bin/java.exe" ] || die "Invalid JDK home: $JHOME"
JAVA_BIN="$JHOME/bin/java"; JAVAC_BIN="$JHOME/bin/javac"
KEYTOOL_BIN="$JHOME/bin/keytool"; JAR_BIN="$JHOME/bin/jar"
for t in "$JAVAC_BIN" "$KEYTOOL_BIN" "$JAR_BIN"; do
  [ -f "$t" ] || [ -f "$t.exe" ] || die "Missing JDK tool: $t"
done
JHOME_MAJOR="$(java_major "$JAVA_BIN")"
[ "$JHOME_MAJOR" -ge 17 ] || die "JDK at $JHOME is $JHOME_MAJOR (<17); sdkmanager/d8/apksigner need 17+"
export JAVA_HOME="$JHOME"
export PATH="$JHOME/bin:$PATH"

# ------------------------------ SDK resolution -------------------------------
SDK_ROOT="$(abs "$SDK_ROOT")"
is_dir "$SDK_ROOT" || die "Android SDK root not found: $SDK_ROOT (pass --sdk PATH)"
BT_DIR="$SDK_ROOT/build-tools/$BUILD_TOOLS_VER"
ANDROID_JAR="$SDK_ROOT/platforms/android-$COMPILE_SDK/android.jar"
is_dir "$BT_DIR" || die "build-tools $BUILD_TOOLS_VER missing under $SDK_ROOT/build-tools"
is_file "$ANDROID_JAR" || die "platform android-$COMPILE_SDK missing ($ANDROID_JAR)"

tool_bin() {
  local n="$1"
  [ "$IS_WINDOWS" -eq 1 ] || true
  if [ -f "$BT_DIR/$n.bat" ] && [ "$IS_WINDOWS" -eq 1 ]; then printf '%s' "$BT_DIR/$n.bat"; return; fi
  if [ -f "$BT_DIR/$n.exe" ]; then printf '%s' "$BT_DIR/$n.exe"; return; fi
  [ -f "$BT_DIR/$n" ] && { printf '%s' "$BT_DIR/$n"; return; }
  [ -f "$BT_DIR/$n.bat" ] && { printf '%s' "$BT_DIR/$n.bat"; return; }
  die "Cannot find tool '$n' in $BT_DIR"
}
AAPT2="$(tool_bin aapt2)"
ZIPALIGN="$(tool_bin zipalign)"
APKSIGNER="$(tool_bin apksigner)"
D8="$(tool_bin d8)"

# ------------------------------ input resolution -----------------------------
PROJECT_ROOT="$(abs "$PROJECT_ROOT")"
is_dir "$PROJECT_ROOT" || die "Project root not found: $PROJECT_ROOT"

if [ "${#SRC_IN[@]}" -eq 0 ]; then
  for c in "$PROJECT_ROOT/app/src/main/java" "$PROJECT_ROOT/app/src" \
           "$PROJECT_ROOT/src/main/java" "$PROJECT_ROOT/src" "$PROJECT_ROOT/selftest/src"; do
    if is_dir "$c"; then SRC_IN=("$c"); break; fi
  done
  [ "${#SRC_IN[@]}" -eq 0 ] && SRC_IN=("$PROJECT_ROOT/app/src")
fi
SRC_ABS=()
for d in "${SRC_IN[@]}"; do
  a="$(abs "$d")"
  if is_dir "$a"; then SRC_ABS+=("$a"); else warn "src dir not found (skipped): $d"; fi
done
[ "${#SRC_ABS[@]}" -gt 0 ] || die "No usable source dir (tried: ${SRC_IN[*]})"

if [ "${#RES_IN[@]}" -eq 0 ]; then
  for c in "$PROJECT_ROOT/app/src/main/res" "$PROJECT_ROOT/app/res" \
           "$PROJECT_ROOT/app/src/res" "$PROJECT_ROOT/src/main/res" \
           "$PROJECT_ROOT/res" "$PROJECT_ROOT/selftest/res"; do
    if is_dir "$c"; then RES_IN=("$c"); break; fi
  done
fi
RES_ABS=()
for d in "${RES_IN[@]}"; do
  a="$(abs "$d")"
  if is_dir "$a"; then RES_ABS+=("$a"); else die "res dir not found: $d"; fi
done
[ "${#RES_ABS[@]}" -gt 0 ] || die "No resource dir; pass --res DIR"

ASSETS_ABS=""
if [ -z "$ASSETS_IN" ]; then
  for c in "$PROJECT_ROOT/app/src/main/assets" "$PROJECT_ROOT/app/assets" \
           "$PROJECT_ROOT/app/src/assets" "$PROJECT_ROOT/assets" "$PROJECT_ROOT/selftest/assets"; do
    if is_dir "$c"; then ASSETS_IN="$c"; break; fi
  done
fi
if [ -n "$ASSETS_IN" ]; then
  ASSETS_ABS="$(abs "$ASSETS_IN")"
  is_dir "$ASSETS_ABS" || die "assets dir not found: $ASSETS_IN"
fi

if [ -z "$MANIFEST_IN" ]; then
  for c in "$PROJECT_ROOT/app/src/main/AndroidManifest.xml" \
           "$PROJECT_ROOT/app/AndroidManifest.xml" \
           "$PROJECT_ROOT/app/src/AndroidManifest.xml" \
           "$PROJECT_ROOT/src/main/AndroidManifest.xml" \
           "$PROJECT_ROOT/AndroidManifest.xml" \
           "$PROJECT_ROOT/selftest/AndroidManifest.xml"; do
    if is_file "$c"; then MANIFEST_IN="$c"; break; fi
  done
fi
[ -n "$MANIFEST_IN" ] || die "AndroidManifest.xml not found; pass --manifest FILE"
MANIFEST_ABS="$(abs "$MANIFEST_IN")"
is_file "$MANIFEST_ABS" || die "AndroidManifest.xml not found: $MANIFEST_IN"

if [ -z "$OUT_IN" ]; then OUT_IN="$PROJECT_ROOT/build/app.apk"; fi
FINAL_OUT="$(abs "$OUT_IN")"
[ -z "$D8_MIN_API" ] && D8_MIN_API="$MIN_SDK"
if [ -z "$KEYSTORE" ]; then KEYSTORE="$SCRIPT_DIR/keys/debug.keystore"; fi
KEYSTORE="$(abs "$KEYSTORE")"

# ------------------------------ clean-only -----------------------------------
do_clean() {  # $1 = apk path
  local p="$1"
  log "cleaning: $p (+ .idsig / -aligned / -unsigned / work)"
  rm -f -- "$p" "$p.idsig" "${p%.apk}.idsig" "${p%.apk}-aligned.apk" "${p%.apk}-unsigned.apk"
  rm -rf -- "$(dirname -- "$p")/work"
}
if [ "$CLEAN_ONLY" -eq 1 ]; then do_clean "$FINAL_OUT"; ok "clean done"; exit 0; fi

# ------------------------------ ASCII staging --------------------------------
# aapt2 --dir cannot open a directory whose path contains non-ASCII characters,
# so when any path is non-ASCII the whole build is re-rooted into an ASCII tree.
NEED_STAGE=0
for p in "${SRC_ABS[@]}" "${RES_ABS[@]}" "$MANIFEST_ABS" "$FINAL_OUT" "$KEYSTORE" ${ASSETS_ABS:+"$ASSETS_ABS"}; do
  non_ascii "$p" && { NEED_STAGE=1; break; }
done

STAGE_DIR=""
if [ "$NEED_STAGE" -eq 1 ]; then
  for c in "$STAGE_ROOT_OPT" "$SCRIPT_DIR/.stage" "$SDK_ROOT/.stage" "/c/Tings/build-stage"; do
    [ -n "$c" ] || continue
    if [ -z "$STAGE_ROOT_OPT" ]; then non_ascii "$c" && continue; fi
    STAGE_DIR="$c/stage-$$-$RANDOM"
    break
  done
  [ -n "$STAGE_DIR" ] || die "Cannot find an ASCII-safe staging root; pass --stage-root DIR (ASCII only)"
  mkdir -p -- "$STAGE_DIR"
fi

STAGED=0
if [ -n "$STAGE_DIR" ]; then
  STAGED=1
  log "non-ASCII path detected -> ASCII staging build at $(w "$STAGE_DIR")"
  mkdir -p -- "$STAGE_DIR/src" "$STAGE_DIR/res" "$STAGE_DIR/out"
  i=0; EFF_SRC=()
  for d in "${SRC_ABS[@]}"; do i=$((i+1)); cp -a -- "$d/." "$STAGE_DIR/src/$i/"; EFF_SRC+=("$STAGE_DIR/src/$i"); done
  i=0; EFF_RES=()
  for d in "${RES_ABS[@]}"; do i=$((i+1)); cp -a -- "$d/." "$STAGE_DIR/res/$i/"; EFF_RES+=("$STAGE_DIR/res/$i"); done
  EFF_ASSETS=""
  if [ -n "$ASSETS_ABS" ]; then cp -a -- "$ASSETS_ABS/." "$STAGE_DIR/assets/"; EFF_ASSETS="$STAGE_DIR/assets"; fi
  cp -f -- "$MANIFEST_ABS" "$STAGE_DIR/AndroidManifest.xml"
  EFF_MANIFEST="$STAGE_DIR/AndroidManifest.xml"
  # ASCII-only artifact name inside the staging tree; the real name is restored on copy-back
  EFF_OUT="$STAGE_DIR/out/app.apk"
else
  EFF_SRC=("${SRC_ABS[@]}"); EFF_RES=("${RES_ABS[@]}")
  EFF_ASSETS="$ASSETS_ABS"; EFF_MANIFEST="$MANIFEST_ABS"; EFF_OUT="$FINAL_OUT"
fi

OUT_DIR="$(dirname -- "$EFF_OUT")"
WORK_DIR="$OUT_DIR/work"

cleanup_stage() {
  if [ -n "$STAGE_DIR" ] && [ "$KEEP_WORK" -eq 0 ]; then rm -rf -- "$STAGE_DIR"; fi
  return 0
}
trap 'rc=$?; cleanup_stage; if [ $rc -ne 0 ]; then printf "%s[%s] FAIL%s build_apk.sh aborted (exit %s) at line %s\n" "$C_R" "$(ts)" "$C_0" "$rc" "$LINENO" >&2; fi' EXIT

# ------------------------------ banner ---------------------------------------
step "build plan"
cat <<EOF
  project root   : $PROJECT_ROOT
  java home      : $JHOME (JDK $JHOME_MAJOR)
  android sdk    : $SDK_ROOT
  build-tools    : $BUILD_TOOLS_VER   ($BT_DIR)
  android.jar    : $ANDROID_JAR
  src dirs       : ${EFF_SRC[*]}
  res dirs       : ${EFF_RES[*]}
$( [ -n "$EFF_ASSETS" ] && printf '  assets dir     : %s\n' "$EFF_ASSETS" )
  manifest       : $EFF_MANIFEST
  version        : code=$VERSION_CODE name=$VERSION_NAME
  sdk versions   : min=$MIN_SDK target=$TARGET_SDK compile=$COMPILE_SDK d8-min-api=$D8_MIN_API
  output apk     : $EFF_OUT$( [ "$STAGED" -eq 1 ] && printf '  (copied to %s)' "$FINAL_OUT" )
$( [ "$SKIP_SIGN" -eq 0 ] && printf '  keystore       : %s (alias %s)\n' "$KEYSTORE" "$KS_ALIAS" )
EOF

log "resetting work dir: $(w "$WORK_DIR")"
rm -rf -- "$WORK_DIR"
mkdir -p -- "$WORK_DIR/res" "$WORK_DIR/gen" "$WORK_DIR/classes" "$WORK_DIR/dex" "$OUT_DIR"

# ------------------------------ 1. aapt2 compile -----------------------------
step "1/7 aapt2 compile (resources)"
COMPILED_ZIPS=(); idx=0
for d in "${EFF_RES[@]}"; do
  idx=$((idx+1))
  flat="$WORK_DIR/res/res-$idx.zip"
  log "aapt2 compile --dir $(w "$d")"
  "$AAPT2" compile --dir "$(w "$d")" -o "$(w "$flat")" || die "aapt2 compile failed for $d"
  COMPILED_ZIPS+=("$flat")
done
ok "resources compiled ($idx zip(s))"

# ------------------------------ 2. aapt2 link --------------------------------
step "2/7 aapt2 link (base apk + R.java)"
BASE_APK="$WORK_DIR/base.apk"
link_args=(link
  -o "$(w "$BASE_APK")"
  -I "$(w "$ANDROID_JAR")"
  --manifest "$(w "$EFF_MANIFEST")"
  --java "$(w "$WORK_DIR/gen")"
  --min-sdk-version "$MIN_SDK"
  --target-sdk-version "$TARGET_SDK"
  --version-code "$VERSION_CODE"
  --version-name "$VERSION_NAME"
  --auto-add-overlay)
for z in "${COMPILED_ZIPS[@]}"; do link_args+=(-R "$(w "$z")"); done
[ -n "$PKG_NAME" ] && link_args+=(--custom-package "$PKG_NAME")
if [ -n "$EFF_ASSETS" ]; then link_args+=(-A "$(w "$EFF_ASSETS")"); log "assets included from $(w "$EFF_ASSETS")"; fi
"$AAPT2" "${link_args[@]}" || die "aapt2 link failed"
is_file "$BASE_APK" || die "aapt2 link produced no APK"
GEN_FILES="$(find "$WORK_DIR/gen" -name '*.java' 2>/dev/null | wc -l | tr -d ' ')"
[ "$GEN_FILES" -gt 0 ] || die "aapt2 link generated no R.java under $(w "$WORK_DIR/gen")"
ok "base apk $(du -h "$BASE_APK" | cut -f1), R.java: $GEN_FILES file(s)"

# ------------------------------ 3. javac -------------------------------------
step "3/7 javac (-source 8 -target 8)"
LIST="$WORK_DIR/java-files.txt"; : > "$LIST"
for d in "${EFF_SRC[@]}"; do
  find "$d" -type f -name '*.java' -print0 >> "$LIST" || true
done
find "$WORK_DIR/gen" -type f -name '*.java' -print0 >> "$LIST"
ARGS="$WORK_DIR/javac-args.txt"; : > "$ARGS"
nf=0
while IFS= read -r -d '' f; do nf=$((nf+1)); printf '"%s"\n' "$(wp "$f")" >> "$ARGS"; done < "$LIST"
[ "$nf" -gt 0 ] || die "No .java files found (check --src DIR)"

CP="$(wp "$ANDROID_JAR")"
SEP=":"; [ "$IS_WINDOWS" -eq 1 ] && SEP=";"
mkdir -p -- "$WORK_DIR/libs"
LIBS_ASCII=()   # classpath entries for javac AND d8, all ASCII-safe
li=0
for j in "${EXTRA_LIBS[@]}"; do
  ja="$(abs "$j")"; is_file "$ja" || die "--lib not found: $j"
  if non_ascii "$ja"; then
    # javac reads @argfiles with the platform charset (GBK on this box); a UTF-8
    # argfile holding a non-ASCII path dies with MalformedInputException.
    li=$((li+1)); cp -f -- "$ja" "$WORK_DIR/libs/lib-$li.jar"; ja="$WORK_DIR/libs/lib-$li.jar"
    log "non-ASCII --lib staged as $(w "$ja")"
  fi
  LIBS_ASCII+=("$ja")
  # each component converted individually: cygpath must never see the joined
  # ';'-separated string (it mangles drive letters)
  CP="$CP$SEP$(wp "$ja")"
done
printf '%s\n' "$CP" > "$WORK_DIR/classpath.txt"
D8_LIB="${LIBS_ASCII[0]:-}"
FLAGS="$WORK_DIR/javac-flags.txt"
{
  printf -- '-source\n8\n-target\n8\n-Xlint:-options\n-encoding\nUTF-8\n-g\n'
  printf -- '-classpath\n%s\n' "$CP"
  printf -- '-d\n%s\n' "$(wp "$WORK_DIR/classes")"
} > "$FLAGS"
cat "$ARGS" >> "$FLAGS"
log "javac: $nf source file(s)"
"$JAVAC_BIN" "@$(wp "$FLAGS")" || die "javac failed"
NCLASS="$(find "$WORK_DIR/classes" -name '*.class' | wc -l | tr -d ' ')"
[ "$NCLASS" -gt 0 ] || die "javac produced no class files"
ok "javac done: $NCLASS class file(s)"

# ------------------------------ 4. jar + d8 ----------------------------------
step "4/7 d8 (dex, --min-api $D8_MIN_API)"
CLASSES_JAR="$WORK_DIR/classes.jar"
"$JAR_BIN" --create --file "$(w "$CLASSES_JAR")" -C "$(w "$WORK_DIR/classes")" . || die "jar packaging failed"
d8_args=(--min-api "$D8_MIN_API" --release --lib "$(w "$ANDROID_JAR")")
for j in "${LIBS_ASCII[@]}"; do d8_args+=(--lib "$(w "$j")"); done
d8_args+=(--output "$(w "$WORK_DIR/dex")")
[ -n "$D8_EXTRA_ARGS" ] && d8_args+=($D8_EXTRA_ARGS)
d8_args+=("$(w "$CLASSES_JAR")")
if [ -n "$D8_HEAP" ]; then
  log "d8 with JAVA_TOOL_OPTIONS=-Xmx${D8_HEAP}m"
  JAVA_TOOL_OPTIONS="-Xmx${D8_HEAP}m" "$D8" "${d8_args[@]}" 2> >(grep -v 'Picked up JAVA_TOOL_OPTIONS' >&2) || die "d8 failed"
else
  "$D8" "${d8_args[@]}" || die "d8 failed"
fi
is_file "$WORK_DIR/dex/classes.dex" || die "d8 produced no classes.dex"
ok "classes.dex $(du -h "$WORK_DIR/dex/classes.dex" | cut -f1)"

# ------------------------------ 5. package -----------------------------------
step "5/7 package dex into apk"
UNSIGNED_APK="${EFF_OUT%.apk}-unsigned.apk"
ALIGNED_APK="${EFF_OUT%.apk}-aligned.apk"
cp -f -- "$BASE_APK" "$UNSIGNED_APK"
( cd -- "$WORK_DIR/dex" && "$JAR_BIN" --update --file "$(w "$UNSIGNED_APK")" classes.dex ) || die "adding classes.dex failed"
ok "packed $(w "$UNSIGNED_APK") ($(du -h "$UNSIGNED_APK" | cut -f1))"

# ------------------------------ 6. zipalign ----------------------------------
step "6/7 zipalign -p -f 4"
"$ZIPALIGN" -p -f 4 "$(w "$UNSIGNED_APK")" "$(w "$ALIGNED_APK")" || die "zipalign failed"
"$ZIPALIGN" -c -v 4 "$(w "$ALIGNED_APK")" > "$WORK_DIR/zipalign-check.txt" 2>&1 \
  || { cat "$WORK_DIR/zipalign-check.txt"; die "zipalign verification failed"; }
ok "aligned $(w "$ALIGNED_APK")"

# ------------------------------ 7. sign --------------------------------------
if [ "$SKIP_SIGN" -eq 1 ]; then
  step "7/7 apksigner SKIPPED (--no-sign)"
  cp -f -- "$ALIGNED_APK" "$EFF_OUT"
else
  step "7/7 apksigner sign"
  if [ ! -f "$KEYSTORE" ]; then
    log "creating keystore: $(w "$KEYSTORE")"
    mkdir -p -- "$(dirname -- "$KEYSTORE")"
    "$KEYTOOL_BIN" -genkeypair \
      -keystore "$(w "$KEYSTORE")" -storetype PKCS12 \
      -alias "$KS_ALIAS" -storepass "$KS_STORE_PASS" -keypass "$KS_KEY_PASS" \
      -dname "$KS_DNAME" -keyalg "$KS_KEYALG" -keysize "$KS_KEYSIZE" -validity "$KS_VALIDITY" \
      > "$WORK_DIR/keytool.log" 2>&1 || { cat "$WORK_DIR/keytool.log"; die "keytool -genkeypair failed"; }
    ok "keystore created ($(du -h "$KEYSTORE" | cut -f1))"
  else
    log "reusing keystore: $(w "$KEYSTORE")"
  fi
  "$APKSIGNER" sign \
    --ks "$(w "$KEYSTORE")" \
    --ks-pass "pass:$KS_STORE_PASS" \
    --ks-key-alias "$KS_ALIAS" \
    --key-pass "pass:$KS_KEY_PASS" \
    --min-sdk-version "$MIN_SDK" \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
    --out "$(w "$EFF_OUT")" "$(w "$ALIGNED_APK")" || die "apksigner sign failed"
  ok "signed $(w "$EFF_OUT") ($(du -h "$EFF_OUT" | cut -f1))"
fi

# ------------------------------ verification --------------------------------
if [ "$SKIP_VERIFY" -eq 1 ]; then
  log "verification skipped (--skip-verify)"
else
  step "verify (aapt2 dump badging + apksigner verify)"
  "$AAPT2" dump badging "$(w "$EFF_OUT")" > "$WORK_DIR/badging.txt" 2>&1 || die "aapt2 dump badging failed"
  grep -E "^package:|^sdkVersion:|^targetSdkVersion:|^application-label:|^launchable-activity:" \
    "$WORK_DIR/badging.txt" | sed 's/^/    /' || true
  BADGE_MIN="$(sed -n "s/^sdkVersion:'\(.*\)'.*/\1/p" "$WORK_DIR/badging.txt" | head -n 1)"
  BADGE_TGT="$(sed -n "s/^targetSdkVersion:'\(.*\)'.*/\1/p" "$WORK_DIR/badging.txt" | head -n 1)"
  # aapt2 only *injects* <uses-sdk> when the manifest has none; if the manifest
  # declares minSdkVersion that value wins and badging reports it. Warn, don't die.
  if [ "$BADGE_MIN" != "$MIN_SDK" ]; then
    warn "badging minSdkVersion='$BADGE_MIN' but --min-sdk was $MIN_SDK (manifest declares it; the manifest value wins)"
    grep -q "uses-sdk" "$EFF_MANIFEST" && log "  (manifest already contains <uses-sdk>)"
  fi
  [ "${BADGE_TGT:-$TARGET_SDK}" = "$TARGET_SDK" ] || warn "badging targetSdkVersion='$BADGE_TGT' != requested $TARGET_SDK"
  grep -q "launchable-activity" "$WORK_DIR/badging.txt" || warn "no launchable-activity in badging (no launcher intent-filter?)"
  if [ "$SKIP_SIGN" -eq 1 ]; then
    warn "APK unsigned (--no-sign): apksigner verify skipped"
  else
    "$APKSIGNER" verify --verbose --min-sdk-version "$MIN_SDK" --max-sdk-version "$TARGET_SDK" \
      "$(w "$EFF_OUT")" > "$WORK_DIR/apksigner-verify.txt" 2>&1 || { cat "$WORK_DIR/apksigner-verify.txt"; die "apksigner verify failed"; }
    sed 's/^/    /' "$WORK_DIR/apksigner-verify.txt"
    ok "signature verified"
  fi
fi

# ------------------------------ copy back (staged) ---------------------------
if [ "$STAGED" -eq 1 ]; then
  step "copy staged artifacts back"
  mkdir -p -- "$(dirname -- "$FINAL_OUT")"
  cp -f -- "$EFF_OUT" "$FINAL_OUT"
  [ -f "$EFF_OUT.idsig" ] && cp -f -- "$EFF_OUT.idsig" "$FINAL_OUT.idsig"
  ok "copied to $(w "$FINAL_OUT")"
fi

# ------------------------------ summary -------------------------------------
APK_FINAL="$FINAL_OUT"
step "result"
SHA="$({ command -v sha256sum >/dev/null 2>&1 && sha256sum "$APK_FINAL"; } 2>/dev/null | awk '{print $1}')"
cat <<EOF
  APK           : $(w "$APK_FINAL")
  size          : $(du -h "$APK_FINAL" | cut -f1) ($(wc -c < "$APK_FINAL" | tr -d ' ') bytes)
  sha256        : ${SHA:-n/a}
  minSdk/target : $MIN_SDK / $TARGET_SDK
  version       : $VERSION_NAME (code $VERSION_CODE)
  signed        : $( [ "$SKIP_SIGN" -eq 1 ] && echo "no" || echo "yes (v1+v2+v3, $KS_ALIAS)" )
  staging       : $( [ "$STAGED" -eq 1 ] && echo "yes (non-ASCII paths)" || echo "no" )
EOF
if [ "$KEEP_WORK" -eq 1 ]; then
  log "work dir kept: $(w "$WORK_DIR")"
else
  rm -f -- "$UNSIGNED_APK" "$ALIGNED_APK"
  rm -rf -- "$WORK_DIR"
fi
ok "BUILD_OK"
