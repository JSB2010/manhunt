#!/usr/bin/env bash
# Deploy the whole backend to a DEDICATED Manhunt Firebase project with one
# `firebase deploy`: the four Cloud Functions (api, tick, watchdog, retention),
# the tick task queue and scheduler jobs, Firestore rules + indexes + TTL
# policies, the Email/Password sign-in provider, and the privacy/support site on
# Firebase Hosting. Photos live in a private non-Firebase bucket, so there are no
# Storage rules to deploy (storage.rules is for the emulator).
#
#   PROJECT_ID=manhunt-dev-abc123 scripts/deploy-backend.sh
#
# Prerequisites (docs/deployment.md): Blaze plan approved by you, `firebase
# login`, and scripts/setup-gcp-project.sh run once for this project. The first
# deploy asks for APP_ENV (dev/prod) and saves it in backend/.env.<project>.
# firebase.json's predeploy runs typecheck, unit tests and the build first.
#
# Guardrails: refuses to run without an explicit PROJECT_ID, refuses project ids
# that don't contain "manhunt", and asks for confirmation before deploying.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT_ID:?Set PROJECT_ID explicitly (never relies on your Firebase/gcloud default project)}"
if [[ "$PROJECT_ID" != *manhunt* && "${ALLOW_ANY_PROJECT:-}" != "1" ]]; then
  echo "Refusing: PROJECT_ID '$PROJECT_ID' does not look like a dedicated Manhunt project (set ALLOW_ANY_PROJECT=1 to override)."; exit 1
fi

# The privacy policy's contact address is filled in at deploy time (scripts/build-hosting.mjs).
if [[ -z "${CONTACT_EMAIL:-}" && ! -s hosting/contact-email.local ]]; then
  echo "Refusing: set CONTACT_EMAIL or write your public contact email to hosting/contact-email.local (git-ignored) before publishing the privacy policy."; exit 1
fi

echo "About to deploy functions, Firestore rules/indexes/TTL, auth providers and the Hosting site to $PROJECT_ID."
read -r -p "Type the project id to confirm: " CONFIRM
[[ "$CONFIRM" == "$PROJECT_ID" ]] || { echo "Aborted."; exit 1; }

(cd backend && npm ci)
firebase deploy --project "$PROJECT_ID" --only functions,firestore,auth,hosting
echo "Deployed. Put the api function's URL (printed above, https://api-…run.app) in ios/Config/Local.xcconfig as MH_API_BASE_URL."
