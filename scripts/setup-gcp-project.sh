#!/usr/bin/env bash
# One-time setup of a DEDICATED Manhunt Firebase project, for the few things
# `firebase deploy` doesn't do. Run it once per project before the first
# deploy (scripts/deploy-backend.sh). Safe to re-run: every step checks first.
#
#   PROJECT_ID=manhunt-dev-abc123 scripts/setup-gcp-project.sh
#
# Optional: REGION (default us-central1; must match REGION in
# backend/src/functions/index.ts), ALERT_EMAIL (creates alert policies),
# BILLING_ACCOUNT + BUDGET_USD (creates a monthly budget with 50/90/100% alerts).
#
# Creates:
#   * service account manhunt-backend (the runtime identity of every function),
#     with only the roles it needs; never a JSON key
#   * private media bucket <project>-manhunt-media (uniform access, public
#     access prevention, 400-day backstop lifecycle)
#   * log metric manhunt_watchdog_overdue and, with ALERT_EMAIL, alert policies
#
# `firebase deploy` then creates the functions, the `tick` task queue, the
# scheduler jobs, their invoker/enqueuer IAM, rules, indexes and TTL policies.
#
# Guardrails: refuses to run without an explicit PROJECT_ID, refuses project
# ids that don't contain "manhunt", and asks you to type the id to confirm.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT_ID:?Set PROJECT_ID explicitly (never relies on your gcloud default project)}"
REGION=${REGION:-us-central1}
ENV_NAME=${ENV_NAME:-dev}
if [[ "$PROJECT_ID" != *manhunt* && "${ALLOW_ANY_PROJECT:-}" != "1" ]]; then
  echo "Refusing: PROJECT_ID '$PROJECT_ID' does not look like a dedicated Manhunt project (set ALLOW_ANY_PROJECT=1 to override)."; exit 1
fi
SA_ID=manhunt-backend
SA="$SA_ID@$PROJECT_ID.iam.gserviceaccount.com"
BUCKET="${MEDIA_BUCKET:-$PROJECT_ID-manhunt-media}"
G=(gcloud --project "$PROJECT_ID" --quiet)

echo "About to set up $PROJECT_ID ($REGION): APIs, service account $SA, bucket gs://$BUCKET, log metric${ALERT_EMAIL:+, alerts to $ALERT_EMAIL}${BILLING_ACCOUNT:+, budget \$${BUDGET_USD:-25}/month}."
read -r -p "Type the project id to confirm: " CONFIRM
[[ "$CONFIRM" == "$PROJECT_ID" ]] || { echo "Aborted."; exit 1; }

echo "→ Enabling APIs"
"${G[@]}" services enable \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudtasks.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com storage.googleapis.com \
  iam.googleapis.com firebase.googleapis.com identitytoolkit.googleapis.com fcm.googleapis.com \
  logging.googleapis.com monitoring.googleapis.com ${BILLING_ACCOUNT:+billingbudgets.googleapis.com}

echo "→ Service account $SA"
"${G[@]}" iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  "${G[@]}" iam service-accounts create "$SA_ID" --display-name "Manhunt backend (Cloud Functions runtime)"
for role in roles/datastore.user roles/firebaseauth.admin roles/firebasecloudmessaging.admin roles/logging.logWriter roles/monitoring.metricWriter; do
  "${G[@]}" projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
done
# The Admin SDK enqueues deadline tasks with an OIDC token for this account.
# `firebase deploy` grants it enqueuer on the tick queue and invoker on tick.
"${G[@]}" iam service-accounts add-iam-policy-binding "$SA" --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser >/dev/null

echo "→ Media bucket gs://$BUCKET"
"${G[@]}" storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 ||
  "${G[@]}" storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
# Backstop only: the retention sweep deletes photos at 7/30 days and track
# archives follow session deletion. Nothing here should outlive 400 days.
LIFECYCLE=$(mktemp)
trap 'rm -f "$LIFECYCLE"' EXIT
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":400}}]}' >"$LIFECYCLE"
"${G[@]}" storage buckets update "gs://$BUCKET" --lifecycle-file "$LIFECYCLE" --public-access-prevention >/dev/null
"${G[@]}" storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null

echo "→ Log metric manhunt_watchdog_overdue"
FILTER='resource.type="cloud_run_revision" AND jsonPayload.message="watchdog pass" AND jsonPayload.watchdog.overdue>0'
"${G[@]}" logging metrics describe manhunt_watchdog_overdue >/dev/null 2>&1 ||
  "${G[@]}" logging metrics create manhunt_watchdog_overdue --description "Watchdog passes that found overdue deadlines (missed task-queue wake-ups)" --log-filter "$FILTER"

if [[ -n "${ALERT_EMAIL:-}" ]]; then
  echo "→ Alert policies → $ALERT_EMAIL"
  CHANNEL=$("${G[@]}" beta monitoring channels list --filter "labels.email_address=\"$ALERT_EMAIL\"" --format 'value(name)' | head -1)
  [[ -n "$CHANNEL" ]] || CHANNEL=$("${G[@]}" beta monitoring channels create --display-name "Manhunt alerts" --type email --channel-labels "email_address=$ALERT_EMAIL" --format 'value(name)')
  for f in scripts/monitoring/*.json; do
    NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["displayName"])' "$f")
    if [[ -z "$("${G[@]}" monitoring policies list --filter "displayName=\"$NAME\"" --format 'value(name)')" ]]; then
      "${G[@]}" monitoring policies create --policy-from-file "$f" --notification-channels "$CHANNEL" >/dev/null
    fi
  done
fi

if [[ -n "${BILLING_ACCOUNT:-}" ]]; then
  echo "→ Monthly budget \$${BUDGET_USD:-25}"
  DISPLAY="Manhunt $ENV_NAME monthly budget"
  if [[ -z "$(gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --filter "displayName=\"$DISPLAY\"" --format 'value(name)')" ]]; then
    gcloud billing budgets create --billing-account "$BILLING_ACCOUNT" --display-name "$DISPLAY" \
      --budget-amount "${BUDGET_USD:-25}USD" --filter-projects "projects/$PROJECT_ID" \
      --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0 >/dev/null
  fi
fi

echo "Done. Next: PROJECT_ID=$PROJECT_ID scripts/deploy-backend.sh"
