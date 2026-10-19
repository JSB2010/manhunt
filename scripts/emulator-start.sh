#!/usr/bin/env bash
# Start the Firebase Emulator Suite (Auth, Firestore, Storage) for local development.
# Data is persisted in ./emulator-data (git-ignored) between runs.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p emulator-data
# The Storage rules runtime prints JDK 24+ "sun.misc.Unsafe" warnings to stderr, which
# the Firebase CLI treats as fatal on the first upload. Prefer an installed JDK 21.
if [ -x /usr/libexec/java_home ] && JDK21=$(/usr/libexec/java_home -v 21 2>/dev/null); then
  export JAVA_HOME="$JDK21" PATH="$JDK21/bin:$PATH"
fi
exec firebase --project demo-manhunt emulators:start --only auth,firestore,storage \
  --import=./emulator-data --export-on-exit=./emulator-data
