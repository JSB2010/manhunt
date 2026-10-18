output "media_bucket" { value = google_storage_bucket.media.name }
output "api_service_account" { value = google_service_account.api.email }
output "worker_service_account" { value = google_service_account.worker.email }
output "tasks_invoker_service_account" { value = google_service_account.tasks_invoker.email }
output "scheduler_service_account" { value = google_service_account.scheduler.email }
output "tasks_queue" { value = google_cloud_tasks_queue.deadlines.name }
output "artifact_repository" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.backend.repository_id}" }
