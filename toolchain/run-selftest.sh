# toolchain/run-selftest.sh -- rebuild + verify the bundled selftest project
#
#   bash toolchain/run-selftest.sh              # build + verify, work dir removed
#   bash toolchain/run-selftest.sh --keep-work  # keep intermediate artifacts
#
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
APK="$HERE/selftest/out/selftest.apk"
BT="$HERE/android-sdk/build-tools/34.0.0"

bash "$HERE/build_apk.sh" \
  --root "$HERE/selftest" \
  --src "$HERE/selftest/src" \
  --res "$HERE/selftest/res" \
  --manifest "$HERE/selftest/AndroidManifest.xml" \
  --out "$APK" \
  "$@"

echo
echo "================ standalone verification ================"
echo "--- aapt2 dump badging (key lines) ---"
"$BT/aapt2.exe" dump badging "$(cygpath -w "$APK")" \
  | grep -E "^package:|^sdkVersion:|^targetSdkVersion:|^application-label:|^launchable-activity:"
echo "--- apksigner verify --verbose --print-certs ---"
"$BT/apksigner.bat" verify --verbose --print-certs "$(cygpath -w "$APK")"
echo "--- zipalign -c -v 4 ---"
"$BT/zipalign.exe" -c -v 4 "$(cygpath -w "$APK")" | tail -3
echo "--- APK contents ---"
unzip -l "$APK"
echo "SELFTEST_OK"
