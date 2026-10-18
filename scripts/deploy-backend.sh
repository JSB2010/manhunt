#!/usr/bin/env bash
# Build and deploy the API + worker to Cloud Run in a DEDICATED Manhunt project.
# Prerequisites (see docs/deployment.md): Terraform applied for this project,
# Artifact Registry repo created, `gcloud auth login`, billing approved by you.
#
#   PROJECT_ID=manhunt-dev REGION=us-central1 scripts/deploy-backend.sh
#
# Guardrails: refuses to run without an explicit PROJECT_ID, refuses project ids
# that don't contain "manhunt", and asks for confirmation before deploying.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT_ID:?Set PROJECT_ID explicitly (never relies on your gcloud default project)}"
REGION=${REGION:-us-central1}
ENV_NAME=${ENV_NAME:-dev}
if [[ "$PROJECT_ID" != *manhunt* && "${ALLOW_ANY_PROJECT:-}" != "1" ]]; then
  echo "Refusing: PROJECT_ID '$PROJECT_ID' does not look like a dedicated Manhunt project (set ALLOW_ANY_PROJECT=1 to override)."; exit 1
fi
REPO="$REGION-docker.pkg.dev/$PROJECT_ID/manhunt/backend"
TAG=$(git rev-parse --short HEAD)
API_SA="manhunt-api@$PROJECT_ID.iam.gserviceaccount.com"
WORKER_SA="manhunt-worker@$PROJECT_ID.iam.gserviceaccount.com"
INVOKER_SA="manhunt-tasks-invoker@$PROJECT_ID.iam.gserviceaccount.com"
SCHED_SA="manhunt-scheduler@$PROJECT_ID.iam.gserviceaccount.com"
BUCKET="${MEDIA_BUCKET:-$PROJECT_ID-manhunt-media}"

echo "About to build $REPO:$TAG and deploy manhunt-api + manhunt-worker to $PROJECT_ID ($REGION)."
read -r -p "Type the project id to confirm: " CONFIRM
[[ "$CONFIRM" == "$PROJECT_ID" ]] || { echo "Aborted."; exit 1; }

(cd backend && npm ci && npm run typecheck && npm run test:unit)
gcloud builds submit backend --project "$PROJECT_ID" --tag "$REPO:$TAG"

gcloud run deploy manhunt-worker --project "$PROJECT_ID" --region "$REGION" --image "$REPO:$TAG" \
  --service-account "$WORKER_SA" --no-allow-unauthenticated --ingress internal \
  --command node --args dist/workerServer.js \
  --set-env-vars "APP_ENV=$ENV_NAME,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,MEDIA_BUCKET=$BUCKET,TASKS_LOCATION=$REGION,TASKS_QUEUE=round-deadlines,TASKS_INVOKER_SA=$INVOKER_SA,WORKER_ALLOWED_INVOKERS=$INVOKER_SA,$SCHED_SA" \
  --min-instances 0 --max-instances 3 --concurrency 20
WORKER_URL=$(gcloud run services describe manhunt-worker --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')

gcloud run deploy manhunt-api --project "$PROJECT_ID" --region "$REGION" --image "$REPO:$TAG" \
  --service-account "$API_SA" --allow-unauthenticated --ingress all \
  --set-env-vars "APP_ENV=$ENV_NAME,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,MEDIA_BUCKET=$BUCKET,TASKS_LOCATION=$REGION,TASKS_QUEUE=round-deadlines,TASKS_INVOKER_SA=$INVOKER_SA,WORKER_URL=$WORKER_URL,WORKER_AUDIENCE=$WORKER_URL" \
  --min-instances 0 --max-instances 5 --concurrency 40

firebase deploy --project "$PROJECT_ID" --only firestore:rules,firestore:indexes,storage
echo "Deployed. API: $(gcloud run services describe manhunt-api --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
echo "Re-run terraform apply with worker_url=$WORKER_URL so Cloud Scheduler targets the worker."
