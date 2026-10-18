#!/usr/bin/env bash
# Start the Firebase Emulator Suite (Auth, Firestore, Storage) for local development.
# Data is persisted in ./emulator-data (git-ignored) between runs.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p emulator-data
exec firebase --project demo-manhunt emulators:start --only auth,firestore,storage \
  --import=./emulator-data --export-on-exit=./emulator-data
