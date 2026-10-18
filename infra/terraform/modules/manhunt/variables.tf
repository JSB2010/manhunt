variable "project_id" {
  description = "Dedicated GCP/Firebase project for Manhunt Crews (never a shared production project)."
  type        = string
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "env" {
  description = "dev | prod"
  type        = string
}
variable "firestore_location" {
  type    = string
  default = "nam5"
}
variable "create_firestore_database" {
  description = "Set false if Firestore (default) was already created via the Firebase console."
  type        = bool
  default     = true
}
variable "worker_url" {
  description = "Cloud Run URL of manhunt-worker (known after first deploy). Empty disables scheduler jobs."
  type        = string
  default     = ""
}
variable "billing_account" {
  description = "Billing account id for a budget alert (empty = no budget resource)."
  type        = string
  default     = ""
}
variable "monthly_budget_usd" {
  type    = number
  default = 25
}
variable "alert_email" {
  description = "Email for monitoring/budget alerts (empty = no notification channel)."
  type        = string
  default     = ""
}
