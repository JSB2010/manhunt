terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0"
    }
  }
}

locals {
  services = [
    "run.googleapis.com", "firestore.googleapis.com", "cloudtasks.googleapis.com", "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com", "iam.googleapis.com", "storage.googleapis.com", "firebase.googleapis.com",
    "identitytoolkit.googleapis.com", "fcm.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com",
    "monitoring.googleapis.com", "logging.googleapis.com", "billingbudgets.googleapis.com",
  ]
  labels = { app = "manhunt-crews", env = var.env }
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------- Firestore
resource "google_firestore_database" "default" {
  count                   = var.create_firestore_database ? 1 : 0
  project                 = var.project_id
  name                    = "(default)"
  location_id             = var.firestore_location
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = var.env == "prod" ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  depends_on              = [google_project_service.apis]
}

# Raw GPS points expire automatically (30-day retention; set at write time).
resource "google_firestore_field" "points_ttl" {
  project    = var.project_id
  collection = "points"
  field      = "expireAt"
  ttl_config {}
  index_config {}
  depends_on = [google_firestore_database.default]
}

resource "google_firestore_field" "idempotency_ttl" {
  project    = var.project_id
  collection = "idempotency"
  field      = "expireAt"
  ttl_config {}
  depends_on = [google_firestore_database.default]
}

# ---------------------------------------------------------------- Storage (private)
resource "google_storage_bucket" "media" {
  project                     = var.project_id
  name                        = "${var.project_id}-manhunt-media"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.env != "prod"
  labels                      = local.labels
  # Backstop only: the retention sweep deletes photos at 7/30 days and track archives
  # follow session deletion. Nothing in this bucket should outlive 400 days.
  lifecycle_rule {
    condition { age = 400 }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository" "backend" {
  project       = var.project_id
  location      = var.region
  repository_id = "manhunt"
  format        = "DOCKER"
  labels        = local.labels
  depends_on    = [google_project_service.apis]
}

# ---------------------------------------------------------------- Service accounts (least privilege)
resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "manhunt-api"
  display_name = "Manhunt public API (Cloud Run)"
}
resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "manhunt-worker"
  display_name = "Manhunt private worker (Cloud Run)"
}
resource "google_service_account" "tasks_invoker" {
  project      = var.project_id
  account_id   = "manhunt-tasks-invoker"
  display_name = "Cloud Tasks OIDC identity for worker invocations"
}
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "manhunt-scheduler"
  display_name = "Cloud Scheduler OIDC identity (watchdog, retention)"
}

locals {
  runtime_sas = { api = google_service_account.api.email, worker = google_service_account.worker.email }
  runtime_roles = [
    "roles/datastore.user",
    "roles/cloudtasks.enqueuer",
    "roles/firebasecloudmessaging.admin",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]
}

resource "google_project_iam_member" "runtime" {
  for_each = { for pair in setproduct(keys(local.runtime_sas), local.runtime_roles) : "${pair[0]}-${pair[1]}" => { sa = local.runtime_sas[pair[0]], role = pair[1] } }
  project  = var.project_id
  role     = each.value.role
  member   = "serviceAccount:${each.value.sa}"
}

# Account deletion removes the Firebase Auth user (API only).
resource "google_project_iam_member" "api_auth_admin" {
  project = var.project_id
  role    = "roles/firebaseauth.admin"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "media_rw" {
  for_each = local.runtime_sas
  bucket   = google_storage_bucket.media.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${each.value}"
}

# API and worker may mint OIDC tokens as the tasks invoker when enqueuing tasks.
resource "google_service_account_iam_member" "act_as_invoker" {
  for_each           = local.runtime_sas
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${each.value}"
}

# ---------------------------------------------------------------- Cloud Tasks
resource "google_cloud_tasks_queue" "deadlines" {
  project  = var.project_id
  location = var.region
  name     = "round-deadlines"
  rate_limits {
    max_dispatches_per_second = 20
    max_concurrent_dispatches = 20
  }
  retry_config {
    max_attempts  = 20
    min_backoff   = "1s"
    max_backoff   = "30s"
    max_doublings = 4
  }
  stackdriver_logging_config { sampling_ratio = 1.0 }
  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------- Worker invoker IAM + Scheduler
resource "google_cloud_run_v2_service_iam_member" "worker_invokers" {
  for_each = var.worker_url == "" ? {} : { tasks = google_service_account.tasks_invoker.email, scheduler = google_service_account.scheduler.email }
  project  = var.project_id
  location = var.region
  name     = "manhunt-worker"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

resource "google_cloud_scheduler_job" "watchdog" {
  count     = var.worker_url == "" ? 0 : 1
  project   = var.project_id
  region    = var.region
  name      = "manhunt-watchdog"
  schedule  = "* * * * *"
  time_zone = "Etc/UTC"
  http_target {
    http_method = "POST"
    uri         = "${var.worker_url}/internal/watchdog/repair"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.worker_url
    }
  }
  retry_config { retry_count = 1 }
}

resource "google_cloud_scheduler_job" "retention" {
  count     = var.worker_url == "" ? 0 : 1
  project   = var.project_id
  region    = var.region
  name      = "manhunt-retention-sweep"
  schedule  = "17 4 * * *"
  time_zone = "Etc/UTC"
  http_target {
    http_method = "POST"
    uri         = "${var.worker_url}/internal/retention/sweep"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.worker_url
    }
  }
}

# ---------------------------------------------------------------- Monitoring (redacted logs only)
resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == "" ? 0 : 1
  project      = var.project_id
  display_name = "Manhunt alerts"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

resource "google_logging_metric" "delayed_pings" {
  project = var.project_id
  name    = "manhunt_watchdog_overdue"
  filter  = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=\"watchdog pass\" AND jsonPayload.watchdog.overdue>0"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "api_errors" {
  project      = var.project_id
  display_name = "Manhunt API 5xx rate"
  combiner     = "OR"
  conditions {
    display_name = "5xx responses"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"manhunt-api\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = google_monitoring_notification_channel.email[*].id
}

resource "google_monitoring_alert_policy" "overdue_deadlines" {
  project      = var.project_id
  display_name = "Manhunt overdue ping/deadline processing"
  combiner     = "OR"
  conditions {
    display_name = "watchdog found overdue deadlines"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.delayed_pings.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = google_monitoring_notification_channel.email[*].id
}

resource "google_billing_budget" "budget" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "Manhunt ${var.env} monthly budget"
  budget_filter { projects = ["projects/${var.project_id}"] }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
}
