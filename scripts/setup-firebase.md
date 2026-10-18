# Firebase / GCP project setup (when you are ready to leave the emulators)

All local development uses the Firebase Emulator Suite with project id `demo-manhunt` (no account, no billing). Only do this when you want a shared dev backend or TestFlight builds.

1. **Create a dedicated project** (don't reuse another app's project), e.g. `manhunt-dev-<suffix>`, in the Firebase console (this also creates the GCP project). Attach billing only when you approve the cost (Cloud Run, Firestore, Tasks and Scheduler fit comfortably in low usage; set the budget below).
2. **Authentication** → Sign-in method → enable **Email/Password** (development provider). Enable **Apple** later (needs the paid Apple program).
3. **Firestore** → create in Native mode (or let Terraform create it with `create_firestore_database = true`).
4. **Register the iOS app** with your `MH_BUNDLE_ID`; download `GoogleService-Info.plist` to `ios/ManhuntCrews/` (git-ignored).
5. **Cloud Messaging** (paid Apple program): upload your APNs Auth Key (.p8).
6. **Terraform**:
   ```bash
   cd infra/terraform/environments/dev
   cp terraform.tfvars.example terraform.tfvars   # set project_id, billing_account (optional), alert_email
   terraform init && terraform plan               # review before applying paid resources
   terraform apply
   ```
7. **Deploy backend**: `PROJECT_ID=<id> scripts/deploy-backend.sh` (asks you to type the project id), then set `worker_url` in tfvars and `terraform apply` again to create the Scheduler jobs and worker invoker IAM.
8. **Rules & indexes** are deployed by the script (`firebase deploy --only firestore:rules,firestore:indexes,storage`).
9. **iOS**: in `ios/Config/Local.xcconfig` set `MH_USE_EMULATORS = NO`, `MH_FIREBASE_PROJECT_ID = <id>`, `MH_API_BASE_URL = https:/$()/<api url>`.

Never download service-account JSON keys; Cloud Run uses attached service accounts.
