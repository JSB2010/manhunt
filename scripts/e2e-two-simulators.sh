#!/usr/bin/env bash
# Two-iPhone-simulator end-to-end round against the LOCAL stack (scripts/dev.sh
# must be running and accounts seeded: `cd backend && npm run seed:emulator`).
#
# Runs the real app on two simulators at once:
#   host   (Crew A, hides)  — creates the night, invites, starts, backgrounds the app
#                             for the whole chase, confirms the photo catch
#   seeker (Crew B, seeks)  — joins by code, waits for scheduled pings, photo-catches
# Each simulator follows a simulated GPS route (walking vs. driving).
#
# Usage: scripts/e2e-two-simulators.sh [HOST_SIM_NAME] [SEEKER_SIM_NAME]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
HOST_SIM_NAME=${1:-"iPhone 17"}
SEEKER_SIM_NAME=${2:-"iPhone 18 Pro"}
BUNDLE_ID=${MH_BUNDLE_ID:-com.manhuntcrews.dev}
DD="$ROOT/ios/build"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$ROOT/test-artifacts/e2e-$STAMP"
COORD="$OUT/coordination"
mkdir -p "$COORD"

curl -sf http://127.0.0.1:8787/healthz >/dev/null || { echo "Local API not running — start scripts/dev.sh first"; exit 1; }

sim_udid() { xcrun simctl list devices available -j | python3 -c "import json,sys; n=sys.argv[1]; d=json.load(sys.stdin)['devices']; print(next(x['udid'] for v in d.values() for x in v if x['name']==n))" "$1"; }
HOST_UDID=$(sim_udid "$HOST_SIM_NAME")
SEEKER_UDID=$(sim_udid "$SEEKER_SIM_NAME")
acct() { python3 -c "import json,sys; a=json.load(open('backend/scripts/seed-accounts.json'))['accounts'][int(sys.argv[1])]; print(a[sys.argv[2]])" "$1" "$2"; }

echo "▶ Building for testing…"
xcodebuild build-for-testing -project ios/ManhuntCrews.xcodeproj -scheme ManhuntCrews \
  -destination "platform=iOS Simulator,id=$HOST_UDID" -derivedDataPath "$DD" -quiet

for U in "$HOST_UDID" "$SEEKER_UDID"; do
  xcrun simctl boot "$U" 2>/dev/null || true
  xcrun simctl uninstall "$U" "$BUNDLE_ID" 2>/dev/null || true
done
xcrun simctl bootstatus "$HOST_UDID" -b >/dev/null
xcrun simctl bootstatus "$SEEKER_UDID" -b >/dev/null

echo "▶ Starting simulated GPS routes (hider walks ~1.6 m/s, seeker drives ~12 m/s)…"
xcrun simctl location "$HOST_UDID" start --speed=1.6 --interval=1 \
  39.7392,-104.9903 39.7392,-104.9840 39.7440,-104.9840 39.7440,-104.9780 39.7500,-104.9780
xcrun simctl location "$SEEKER_UDID" start --speed=12 --interval=1 \
  39.7300,-105.0000 39.7300,-104.9700 39.7550,-104.9700 39.7550,-105.0000 39.7300,-105.0000

run_role() {
  local role=$1 udid=$2 idx=$3 test=$4
  TEST_RUNNER_MH_E2E_ROLE=$role TEST_RUNNER_MH_E2E_DIR="$COORD" \
  TEST_RUNNER_MH_E2E_EMAIL="$(acct "$idx" email)" TEST_RUNNER_MH_E2E_PASSWORD="$(acct "$idx" password)" \
  xcodebuild test-without-building -project ios/ManhuntCrews.xcodeproj -scheme ManhuntCrews \
    -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$DD" \
    -only-testing:"ManhuntCrewsUITests/TwoPhoneE2ETests/$test" \
    -resultBundlePath "$OUT/$role.xcresult" > "$OUT/$role.log" 2>&1
}

echo "▶ Running host on $HOST_SIM_NAME and seeker on $SEEKER_SIM_NAME in parallel (≈5 min)…"
run_role host "$HOST_UDID" 0 testHost & HP=$!
sleep 20 # let the host create the night first
run_role seeker "$SEEKER_UDID" 1 testSeeker & SPID=$!
HS=0; SS=0
wait $HP || HS=$?
wait $SPID || SS=$?
xcrun simctl location "$HOST_UDID" clear || true
xcrun simctl location "$SEEKER_UDID" clear || true

for role in host seeker; do
  mkdir -p "$OUT/screens-$role"
  xcrun xcresulttool export attachments --path "$OUT/$role.xcresult" --output-path "$OUT/screens-$role" >/dev/null 2>&1 || true
done
echo "host exit=$HS seeker exit=$SS"
echo "Coordination notes:"; for f in "$COORD"/*.txt; do echo "  $(basename "$f"): $(cat "$f")"; done
echo "Artifacts: $OUT"
[ $HS -eq 0 ] && [ $SS -eq 0 ]
