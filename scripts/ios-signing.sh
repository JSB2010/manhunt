#!/usr/bin/env bash
# Manual iOS distribution signing for the Prod configuration, without signing
# Xcode into the paid Apple Developer account. You do the portal steps in a
# browser (docs/release-prod.md); this script does the local parts.
#
#   scripts/ios-signing.sh csr
#       Creates a private key + certificate signing request in ~/.manhunt-signing
#       (0700). Upload the .csr at developer.apple.com → Certificates → + →
#       "Apple Distribution", then download the .cer.
#
#   scripts/ios-signing.sh install <distribution.cer> <app.mobileprovision> <widgets.mobileprovision>
#       Imports the certificate and its private key into your login keychain,
#       installs the App Store provisioning profiles — one for the app
#       (MH_BUNDLE_ID) and one for its Live Activity extension
#       (MH_BUNDLE_ID.widgets) — checks that they match each other and the bundle
#       IDs, and writes ios/Config/Prod.local.xcconfig (git-ignored) with your
#       team ID and the profile names, keeping the other values there.
#
#   scripts/ios-signing.sh status
#       Shows the installed distribution identities and the Prod signing config.
#
# The private key never leaves this Mac and is never written into the repo.
# Back up ~/.manhunt-signing (e.g. in your password manager) — without the key
# the certificate is useless and you'd have to issue a new one.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${MANHUNT_SIGNING_DIR:-$HOME/.manhunt-signing}"
KEY="$DIR/distribution.key"
CSR="$DIR/distribution.csr"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
LOCAL_CFG=ios/Config/Prod.local.xcconfig
# Prod.local.xcconfig (git-ignored) overrides the placeholders in Prod.xcconfig.
prod_cfg() { local v; v=$(sed -n "s/^$1 = //p" "$LOCAL_CFG" 2>/dev/null | tail -1); [[ -n "$v" ]] || v=$(sed -n "s/^$1 = //p" ios/Config/Prod.xcconfig | tail -1); printf '%s' "$v"; }
BUNDLE_ID=$(prod_cfg MH_BUNDLE_ID)

die() { echo "✗ $*" >&2; exit 1; }

case "${1:-}" in
  csr)
    mkdir -p "$DIR" && chmod 700 "$DIR"
    [[ -f "$KEY" ]] && die "$KEY already exists. Reuse $CSR, or move the old key away first."
    openssl req -new -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CSR" -subj "/CN=Manhunt Crews Apple Distribution" 2>/dev/null
    chmod 600 "$KEY" "$CSR"
    echo "✓ Certificate signing request: $CSR"
    echo "  Upload it at https://developer.apple.com/account/resources/certificates/add (Apple Distribution),"
    echo "  download the .cer, then run: scripts/ios-signing.sh install <file.cer> <profile.mobileprovision>"
    ;;

  install)
    USAGE="usage: install <distribution.cer> <app.mobileprovision> <widgets.mobileprovision>"
    CER="${2:?$USAGE}"
    PROFILE="${3:?$USAGE}"
    WIDGETS_PROFILE="${4:?$USAGE (App Store profile for $BUNDLE_ID.widgets, the Live Activity extension)}"
    [[ -f "$KEY" ]] || die "No private key at $KEY. Run 'scripts/ios-signing.sh csr' first (the .cer must come from that CSR)."
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT

    # The certificate must belong to our private key.
    openssl x509 -inform DER -in "$CER" -out "$TMP/cert.pem" 2>/dev/null || openssl x509 -in "$CER" -out "$TMP/cert.pem" || die "$CER is not a certificate"
    [[ "$(openssl x509 -in "$TMP/cert.pem" -noout -pubkey | openssl sha256)" == "$(openssl pkey -in "$KEY" -pubout | openssl sha256)" ]] ||
      die "$CER was not issued for the key in $KEY (upload $CSR, not another CSR)"
    SUBJECT=$(openssl x509 -in "$TMP/cert.pem" -noout -subject)
    [[ "$SUBJECT" == *"Apple Distribution"* || "$SUBJECT" == *"iPhone Distribution"* ]] || die "Not a distribution certificate: $SUBJECT"
    openssl x509 -in "$TMP/cert.pem" -outform DER -out "$TMP/cert.der"

    # Each profile must be an App Store profile for its bundle ID that includes this certificate.
    # check_profile <file> <bundle id> <needs push: 1|0> sets NAME, UUID, TEAM, EXPIRES.
    check_profile() {
      local file="$1" bundle="$2" push="$3" plist="$TMP/profile-$(basename "$1").plist"
      security cms -D -i "$file" > "$plist" 2>/dev/null ||
        openssl smime -verify -noverify -inform DER -in "$file" -out "$plist" 2>/dev/null ||
        die "$file is not a provisioning profile"
      pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null; }
      NAME=$(pb Name); UUID=$(pb UUID); TEAM=$(pb TeamIdentifier:0); EXPIRES=$(pb ExpirationDate)
      local app_id; app_id=$(pb Entitlements:application-identifier)
      [[ "$app_id" == "$TEAM.$bundle" ]] || die "Profile '$NAME' is for $app_id, expected $TEAM.$bundle"
      [[ -z "$(pb ProvisionedDevices 2>/dev/null)" ]] || die "Profile '$NAME' lists devices: create an App Store (not Ad Hoc/Development) profile"
      if [[ "$push" == 1 ]]; then
        [[ "$(pb Entitlements:aps-environment)" == "production" ]] || die "Profile '$NAME' lacks Push Notifications: enable it on the App ID and regenerate the profile"
      fi
      local found=0
      for i in $(seq 0 20); do
        plutil -extract "DeveloperCertificates.$i" raw -o "$TMP/dev.b64" "$plist" 2>/dev/null || break
        [[ "$(base64 -d -i "$TMP/dev.b64" | openssl sha1)" == "$(openssl sha1 < "$TMP/cert.der")" ]] && found=1
      done
      [[ $found == 1 ]] || die "Profile '$NAME' doesn't include this certificate: edit the profile, tick the new certificate, download again"
    }
    check_profile "$WIDGETS_PROFILE" "$BUNDLE_ID.widgets" 0
    WIDGETS_NAME=$NAME; WIDGETS_UUID=$UUID; WIDGETS_TEAM=$TEAM; WIDGETS_EXPIRES=$EXPIRES
    check_profile "$PROFILE" "$BUNDLE_ID" 1
    [[ "$WIDGETS_TEAM" == "$TEAM" ]] || die "The two profiles belong to different teams ($TEAM, $WIDGETS_TEAM)"

    # Keychain: private key + certificate (pairs automatically); codesign may ask once — choose "Always Allow".
    security import "$KEY" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1 || echo "  (private key already in keychain)"
    security import "$TMP/cert.der" -k "$KEYCHAIN" >/dev/null 2>&1 || echo "  (certificate already in keychain)"

    for d in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
      mkdir -p "$d" && cp "$PROFILE" "$d/$UUID.mobileprovision" && cp "$WIDGETS_PROFILE" "$d/$WIDGETS_UUID.mobileprovision"
    done

    # Replace only the signing keys; keep your project values in the same file.
    KEEP=$(grep -vE '^(MH_DEVELOPMENT_TEAM|MH_PROVISIONING_PROFILE|MH_WIDGETS_PROVISIONING_PROFILE) = ' "$LOCAL_CFG" 2>/dev/null || true)
    printf '%s\nMH_DEVELOPMENT_TEAM = %s\nMH_PROVISIONING_PROFILE = %s\nMH_WIDGETS_PROVISIONING_PROFILE = %s\n' "${KEEP:-// Prod.local.xcconfig (git-ignored): your project values and signing team.}" "$TEAM" "$NAME" "$WIDGETS_NAME" > "$LOCAL_CFG"
    IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN" | grep -E "(Apple|iPhone) Distribution.*\($TEAM\)" | head -1 | sed 's/^ *[0-9]*) [0-9A-F]* //' || true)
    if [[ -n "$IDENTITY" ]]; then
      echo "✓ Signing identity: $IDENTITY"
    else
      echo "! The certificate is installed but macOS doesn't trust it for code signing yet. Install Apple's"
      echo "  intermediate certificate, then run 'scripts/ios-signing.sh status':"
      echo "  curl -fsSLO https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer && security import AppleWWDRCAG3.cer -k \"$KEYCHAIN\""
    fi
    echo "✓ Profile '$NAME' ($UUID), expires $EXPIRES"
    echo "✓ Profile '$WIDGETS_NAME' ($WIDGETS_UUID), expires $WIDGETS_EXPIRES"
    echo "✓ Wrote $LOCAL_CFG (team $TEAM). Next: scripts/ios-release.sh"
    ;;

  status)
    security find-identity -v -p codesigning "$KEYCHAIN" | grep -E "Distribution" || echo "No distribution identity in $KEYCHAIN"
    [[ -f "$LOCAL_CFG" ]] && cat "$LOCAL_CFG" || echo "$LOCAL_CFG not written yet"
    ;;

  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
