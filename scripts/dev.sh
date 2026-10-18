#!/usr/bin/env bash
# Local stack: Firebase emulators + public API (:8787) + private worker (:8788).
# Uses the demo-manhunt project id: nothing here can touch production.
#   scripts/dev.sh            # emulators + API/worker
#   API_HOST=0.0.0.0 scripts/dev.sh   # reachable from a physical iPhone on your LAN
set -euo pipefail
cd "$(dirname "$0")/.."
(cd backend && [ -d node_modules ] || npm ci)
scripts/emulator-start.sh &
EMU_PID=$!
trap 'kill $EMU_PID 2>/dev/null || true' EXIT
echo "Waiting for emulators..."
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:4400/emulators >/dev/null 2>&1 && break
  sleep 1
done
cd backend
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
GOOGLE_CLOUD_PROJECT=demo-manhunt APP_ENV=local \
npx tsx src/dev.ts
