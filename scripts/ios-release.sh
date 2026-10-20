#!/usr/bin/env bash
# Archive the Prod configuration (manual signing) and export it for App Store
# Connect / TestFlight. Nothing needs to be signed into Xcode.
#
#   scripts/ios-release.sh
#       Archives and exports ios/build-release/export/ManhuntCrews.ipa. Upload
#       that with Apple's Transporter app, or:
#
#   ASC_KEY_ID=ABC123XYZ ASC_ISSUER_ID=<uuid> scripts/ios-release.sh
#       Archives and uploads straight to App Store Connect with an App Store
#       Connect API key (Users and Access → Integrations → App Store Connect API).
#       The key file is read from ASC_KEY_PATH, default
#       ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 (keep it out of the repo).
#
# BUILD_NUMBER defaults to the UTC time (yyyymmddHHMM), so every upload is newer.
# Prerequisites: scripts/ios-signing.sh install, and
# ios/ManhuntCrews/GoogleService-Info-Prod.plist (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=ios/build-release
LOCAL_CFG=ios/Config/Prod.local.xcconfig
die() { echo "✗ $*" >&2; exit 1; }

[[ -f ios/ManhuntCrews/GoogleService-Info-Prod.plist ]] ||
  die "Missing ios/ManhuntCrews/GoogleService-Info-Prod.plist: firebase apps:sdkconfig IOS --project your-prod-project -o ios/ManhuntCrews/GoogleService-Info-Prod.plist"
[[ -f "$LOCAL_CFG" ]] || die "Missing $LOCAL_CFG: run scripts/ios-signing.sh install <cer> <mobileprovision> first"
TEAM=$(sed -n 's/^MH_DEVELOPMENT_TEAM = //p' "$LOCAL_CFG")
PROFILE=$(sed -n 's/^MH_PROVISIONING_PROFILE = //p' "$LOCAL_CFG")
BUNDLE_ID=$(sed -n 's/^MH_BUNDLE_ID = //p' ios/Config/Prod.xcconfig)
[[ -n "$TEAM" && -n "$PROFILE" ]] || die "$LOCAL_CFG must set MH_DEVELOPMENT_TEAM and MH_PROVISIONING_PROFILE"
security find-identity -v -p codesigning | grep -qE "(Apple|iPhone) Distribution.*\($TEAM\)" ||
  die "No trusted Apple Distribution identity for team $TEAM in your keychain (scripts/ios-signing.sh status)"
BUILD="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"

DEST=export
AUTH=()
if [[ -n "${ASC_KEY_ID:-}" ]]; then
  : "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID with ASC_KEY_ID}"
  KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
  [[ -f "$KEY_PATH" ]] || die "App Store Connect key not found at $KEY_PATH"
  DEST=upload
  AUTH=(-authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

echo "Archiving $BUNDLE_ID build $BUILD (team $TEAM, profile '$PROFILE'); then $DEST."
rm -rf "$OUT/ManhuntCrews.xcarchive" "$OUT/export"
mkdir -p "$OUT"
xcodebuild archive -project ios/ManhuntCrews.xcodeproj -scheme "ManhuntCrews Prod" -configuration Prod \
  -destination generic/platform=iOS -archivePath "$OUT/ManhuntCrews.xcarchive" \
  CURRENT_PROJECT_VERSION="$BUILD" | tail -n 5

cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>$DEST</string>
	<key>signingStyle</key><string>manual</string>
	<key>teamID</key><string>$TEAM</string>
	<key>signingCertificate</key><string>Apple Distribution</string>
	<key>provisioningProfiles</key>
	<dict><key>$BUNDLE_ID</key><string>$PROFILE</string></dict>
	<key>uploadSymbols</key><true/>
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

xcodebuild -exportArchive -archivePath "$OUT/ManhuntCrews.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" ${AUTH[@]+"${AUTH[@]}"} | tail -n 5

if [[ "$DEST" == upload ]]; then
  echo "✓ Uploaded build $BUILD. It appears in App Store Connect → TestFlight after processing (usually 5–30 min)."
else
  echo "✓ $OUT/export/ManhuntCrews.ipa (build $BUILD). Upload it with Transporter, or rerun with ASC_KEY_ID/ASC_ISSUER_ID."
fi
