terraform {
  required_version = ">= 1.6"
  # Recommended: remote state in a bucket you create manually first.
  # backend "gcs" { bucket = "<your-tf-state-bucket>" prefix = "manhunt/prod" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "worker_url" {
  type    = string
  default = ""
}
variable "billing_account" {
  type    = string
  default = ""
}
variable "alert_email" {
  type    = string
  default = ""
}
variable "create_firestore_database" {
  type    = bool
  default = true
}

module "manhunt" {
  source                    = "../../modules/manhunt"
  project_id                = var.project_id
  region                    = var.region
  env                       = "prod"
  worker_url                = var.worker_url
  billing_account           = var.billing_account
  alert_email               = var.alert_email
  create_firestore_database = var.create_firestore_database
  monthly_budget_usd        = 50
}

output "manhunt" { value = module.manhunt }
