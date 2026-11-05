# toolchain/env.sh -- source this to get a working Android build environment
#
#   source toolchain/env.sh
#
# Exports JAVA_HOME (JDK 17, required by sdkmanager/aapt2/d8/apksigner),
# ANDROID_SDK_ROOT, ANDROID_HOME and puts the SDK tools on PATH.

TC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"

# --- JDK 17 (build-tools refuse to start on JDK 8/11) -----------------------
for c in "${JAVA_HOME_OVERRIDE:-}" \
         "/c/Program Files/Zulu/zulu-17" \
         "/c/Program Files/Zulu/zulu-21" \
         "/c/Program Files/Zulu/zulu-25" \
         "/c/Program Files/Zulu/zulu-24" \
         "/c/Program Files/Java/jdk-17" \
         "/usr/lib/jvm/java-17-openjdk-amd64"; do
  [ -n "$c" ] || continue
  [ -x "$c/bin/java" ] || [ -f "$c/bin/java.exe" ] || continue
  export JAVA_HOME="$(cygpath -w "$c" 2>/dev/null || printf '%s' "$c")"
  export PATH="$c/bin:$PATH"
  break
done

# --- Android SDK ------------------------------------------------------------
export ANDROID_SDK_ROOT="$(cygpath -w "$TC_DIR/android-sdk" 2>/dev/null || printf '%s' "$TC_DIR/android-sdk")"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$TC_DIR/android-sdk/platform-tools:$TC_DIR/android-sdk/build-tools/34.0.0:$TC_DIR/cmdline-tools/latest/bin:$PATH"

echo "JAVA_HOME       = $JAVA_HOME"
echo "ANDROID_SDK_ROOT= $ANDROID_SDK_ROOT"
echo "java            = $(command -v java)  ($(java -version 2>&1 | head -n 1))"
echo "sdkmanager      = $(command -v sdkmanager.bat || command -v sdkmanager)"
