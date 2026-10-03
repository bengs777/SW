CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`last_used` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_unique` ON `api_keys` (`key`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_workspace` ON `api_keys` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_key` ON `api_keys` (`key`);--> statement-breakpoint
CREATE TABLE `artifact_files` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`language` text DEFAULT 'typescript' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artifact_files_unique` ON `artifact_files` (`artifact_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_artifact_files_artifact` ON `artifact_files` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `idx_artifact_files_content_hash` ON `artifact_files` (`content_hash`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`generation_job_id` text,
	`generation_history_id` text,
	`source` text DEFAULT 'generation' NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`prompt` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_generation_job_id_unique` ON `artifacts` (`generation_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_generation_history_id_unique` ON `artifacts` (`generation_history_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_project_created` ON `artifacts` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_status_created` ON `artifacts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_source` ON `artifacts` (`source`);--> statement-breakpoint
CREATE TABLE `billing_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`grant_id` text,
	`actor_user_id` text,
	`counterparty_user_id` text,
	`kind` text NOT NULL,
	`direction` text NOT NULL,
	`amount` integer NOT NULL,
	`balance_before` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reference` text,
	`provider` text,
	`provider_reference` text,
	`description` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_transactions_reference_unique` ON `billing_transactions` (`reference`);--> statement-breakpoint
CREATE INDEX `idx_billing_transactions_user` ON `billing_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_transactions_grant` ON `billing_transactions` (`grant_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_transactions_actor` ON `billing_transactions` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_transactions_counterparty` ON `billing_transactions` (`counterparty_user_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_transactions_kind` ON `billing_transactions` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_billing_transactions_provider_ref` ON `billing_transactions` (`provider`,`provider_reference`);--> statement-breakpoint
CREATE INDEX `idx_billing_transactions_created` ON `billing_transactions` (`created_at`);--> statement-breakpoint
CREATE TABLE `credit_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`reversed_by_user_id` text,
	`idempotency_key` text,
	`posted_at` integer,
	`reversed_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_grants_reference_unique` ON `credit_grants` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `credit_grants_idempotency_key_unique` ON `credit_grants` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_credit_grants_from_user` ON `credit_grants` (`from_user_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_grants_to_user` ON `credit_grants` (`to_user_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_grants_created_by` ON `credit_grants` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_grants_reversed_by` ON `credit_grants` (`reversed_by_user_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_grants_status` ON `credit_grants` (`status`);--> statement-breakpoint
CREATE INDEX `idx_credit_grants_created` ON `credit_grants` (`created_at`);--> statement-breakpoint
CREATE TABLE `crypto_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`top_up_order_id` text NOT NULL,
	`chain_id` integer NOT NULL,
	`chain_name` text NOT NULL,
	`token_symbol` text DEFAULT 'Native' NOT NULL,
	`amount_in_usd` integer NOT NULL,
	`amount_in_token` text NOT NULL,
	`sender_address` text NOT NULL,
	`recipient_address` text NOT NULL,
	`transaction_hash` text,
	`block_number` integer,
	`confirmations` integer DEFAULT 0 NOT NULL,
	`gas_used` text,
	`gas_price_in_gwei` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`detected_at` integer NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crypto_payments_top_up_order_id_unique` ON `crypto_payments` (`top_up_order_id`);--> statement-breakpoint
CREATE INDEX `idx_crypto_payments_chain_tx` ON `crypto_payments` (`chain_id`,`transaction_hash`);--> statement-breakpoint
CREATE INDEX `idx_crypto_payments_sender` ON `crypto_payments` (`sender_address`);--> statement-breakpoint
CREATE INDEX `idx_crypto_payments_status` ON `crypto_payments` (`status`);--> statement-breakpoint
CREATE INDEX `idx_crypto_payments_detected` ON `crypto_payments` (`detected_at`);--> statement-breakpoint
CREATE TABLE `generation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`error` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_generation_attempts_unique` ON `generation_attempts` (`job_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_generation_attempts_job_started` ON `generation_attempts` (`job_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_generation_attempts_provider_model` ON `generation_attempts` (`provider`,`model`);--> statement-breakpoint
CREATE INDEX `idx_generation_attempts_status` ON `generation_attempts` (`status`);--> statement-breakpoint
CREATE TABLE `generation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`trace_id` text,
	`span_id` text,
	`parent_span_id` text,
	`worker_id` text,
	`sandbox_id` text,
	`preview_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`event_type` text,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	`metadata_json` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`termination_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_generation_events_unique` ON `generation_events` (`job_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_generation_events_job_created` ON `generation_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_generation_events_job_sequence` ON `generation_events` (`job_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_generation_events_type` ON `generation_events` (`type`);--> statement-breakpoint
CREATE INDEX `idx_generation_events_event_type` ON `generation_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_generation_events_trace_id` ON `generation_events` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_events_worker_id` ON `generation_events` (`worker_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_events_preview_id` ON `generation_events` (`preview_id`);--> statement-breakpoint
CREATE TABLE `generation_history` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prompt` text NOT NULL,
	`result` text NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`intent` text,
	`used_auto_repair` integer DEFAULT false NOT NULL,
	`idempotency_key` text,
	`cost` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_generation_history_idempotency` ON `generation_history` (`project_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_generation_history_project` ON `generation_history` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_history_created` ON `generation_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `generation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`prompt` text NOT NULL,
	`model` text NOT NULL,
	`provider` text DEFAULT 'swift' NOT NULL,
	`intent` text,
	`used_auto_repair` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`orchestration_state` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`label` text DEFAULT 'Prompt diterima' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 2 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`plan_json` text,
	`context_json` text,
	`diagnostics_json` text,
	`metrics_json` text,
	`preview_url` text,
	`error` text,
	`result_history_id` text,
	`queue_job_id` text,
	`trace_id` text,
	`worker_id` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`last_heartbeat_at` integer,
	`retry_reason` text,
	`retry_class` text,
	`recovery_count` integer DEFAULT 0 NOT NULL,
	`dead_lettered_at` integer,
	`terminated_at` integer,
	`idempotency_key` text,
	`request_hash` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`timed_out_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`failed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_generation_jobs_idempotency` ON `generation_jobs` (`user_id`,`project_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_generation_jobs_request_hash` ON `generation_jobs` (`user_id`,`project_id`,`request_hash`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_user_created` ON `generation_jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_project_created` ON `generation_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_status` ON `generation_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_orchestration_state` ON `generation_jobs` (`orchestration_state`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_stage` ON `generation_jobs` (`stage`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_cancel_requested` ON `generation_jobs` (`cancel_requested`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_queue_job_id` ON `generation_jobs` (`queue_job_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_trace_id` ON `generation_jobs` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_worker_id` ON `generation_jobs` (`worker_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_lease_owner` ON `generation_jobs` (`lease_owner`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_lease_expires` ON `generation_jobs` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_heartbeat` ON `generation_jobs` (`last_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `generation_quality_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`app_type` text NOT NULL,
	`status` text NOT NULL,
	`failure_stage` text,
	`failure_code` text,
	`build_passed` integer DEFAULT false NOT NULL,
	`runtime_passed` integer DEFAULT false NOT NULL,
	`repair_succeeded` integer DEFAULT false NOT NULL,
	`deploy_validated` integer DEFAULT false NOT NULL,
	`repair_attempts` integer DEFAULT 0 NOT NULL,
	`user_retry_count` integer DEFAULT 0 NOT NULL,
	`provider_latency_ms` integer DEFAULT 0 NOT NULL,
	`validation_latency_ms` integer DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost` integer DEFAULT 0 NOT NULL,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_quality_metrics_job_id_unique` ON `generation_quality_metrics` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_gqm_user_created` ON `generation_quality_metrics` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_gqm_project_created` ON `generation_quality_metrics` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_gqm_app_type_created` ON `generation_quality_metrics` (`app_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_gqm_status_created` ON `generation_quality_metrics` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_gqm_failure_stage` ON `generation_quality_metrics` (`failure_stage`);--> statement-breakpoint
CREATE TABLE `model_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`provider` text NOT NULL,
	`model_name` text NOT NULL,
	`price` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_configs_key_unique` ON `model_configs` (`key`);--> statement-breakpoint
CREATE INDEX `idx_model_configs_provider` ON `model_configs` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_model_configs_active` ON `model_configs` (`is_active`);--> statement-breakpoint
CREATE TABLE `model_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`model_name` text NOT NULL,
	`task_type` text NOT NULL,
	`provider` text,
	`success_rate` real DEFAULT 0 NOT NULL,
	`avg_latency` integer DEFAULT 0 NOT NULL,
	`avg_rating` real DEFAULT 0 NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_scores_unique` ON `model_scores` (`model_name`,`task_type`);--> statement-breakpoint
CREATE INDEX `idx_model_scores_task_type` ON `model_scores` (`task_type`);--> statement-breakpoint
CREATE INDEX `idx_model_scores_model_name` ON `model_scores` (`model_name`);--> statement-breakpoint
CREATE INDEX `idx_model_scores_provider` ON `model_scores` (`provider`);--> statement-breakpoint
CREATE TABLE `orchestration_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`trace_id` text,
	`worker_id` text,
	`event_type` text NOT NULL,
	`stage` text NOT NULL,
	`severity` text DEFAULT 'error' NOT NULL,
	`reason` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`termination_reason` text,
	`metadata_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_orchestration_failures_job_created` ON `orchestration_failures` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_failures_trace_id` ON `orchestration_failures` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_failures_worker_id` ON `orchestration_failures` (`worker_id`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_failures_event_type` ON `orchestration_failures` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_failures_severity` ON `orchestration_failures` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_failures_termination` ON `orchestration_failures` (`termination_reason`);--> statement-breakpoint
CREATE INDEX `idx_orchestration_failures_created` ON `orchestration_failures` (`created_at`);--> statement-breakpoint
CREATE TABLE `preview_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`trace_id` text,
	`span_id` text,
	`worker_id` text,
	`sandbox_id` text,
	`preview_url` text,
	`status` text DEFAULT 'starting' NOT NULL,
	`boot_started_at` integer,
	`build_started_at` integer,
	`build_completed_at` integer,
	`dev_server_started_at` integer,
	`reachable_at` integer,
	`terminated_at` integer,
	`termination_reason` text,
	`expires_at` integer,
	`idempotency_key` text,
	`diagnostics_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_preview_sessions_idempotency` ON `preview_sessions` (`job_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_preview_sessions_job_created` ON `preview_sessions` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_preview_sessions_project_created` ON `preview_sessions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_preview_sessions_status` ON `preview_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_preview_sessions_trace_id` ON `preview_sessions` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_preview_sessions_sandbox_id` ON `preview_sessions` (`sandbox_id`);--> statement-breakpoint
CREATE INDEX `idx_preview_sessions_expires` ON `preview_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`area` text DEFAULT 'Online' NOT NULL,
	`price` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`owner_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_products_owner` ON `products` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_products_status` ON `products` (`status`);--> statement-breakpoint
CREATE INDEX `idx_products_created` ON `products` (`created_at`);--> statement-breakpoint
CREATE TABLE `project_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`storage_bucket` text NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_assets_unique` ON `project_assets` (`storage_bucket`,`storage_path`);--> statement-breakpoint
CREATE INDEX `idx_project_assets_project` ON `project_assets` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_assets_user` ON `project_assets` (`user_id`);--> statement-breakpoint
CREATE TABLE `project_files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`language` text DEFAULT 'typescript' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_files_unique` ON `project_files` (`project_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_project_files_project` ON `project_files` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`framework` text DEFAULT 'next' NOT NULL,
	`prompt` text,
	`template_id` text,
	`custom_domain` text,
	`domain_verified` integer DEFAULT false NOT NULL,
	`memory_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_workspace` ON `projects` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_projects_template` ON `projects` (`template_id`);--> statement-breakpoint
CREATE TABLE `repair_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`trace_id` text,
	`span_id` text,
	`worker_id` text,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`termination_reason` text,
	`validator_error` text,
	`input_hash` text,
	`output_hash` text,
	`idempotency_key` text,
	`metadata_json` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repair_attempts_unique` ON `repair_attempts` (`job_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repair_attempts_idempotency` ON `repair_attempts` (`job_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_repair_attempts_job_started` ON `repair_attempts` (`job_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_repair_attempts_status` ON `repair_attempts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_repair_attempts_termination` ON `repair_attempts` (`termination_reason`);--> statement-breakpoint
CREATE INDEX `idx_repair_attempts_trace_id` ON `repair_attempts` (`trace_id`);--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_type` text NOT NULL,
	`model_config_id` text,
	`model_used` text NOT NULL,
	`provider` text,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`success` integer DEFAULT false NOT NULL,
	`error_message` text,
	`context_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_request_logs_project_created` ON `request_logs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_task_type` ON `request_logs` (`task_type`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_model_used` ON `request_logs` (`model_used`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_provider` ON `request_logs` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_success` ON `request_logs` (`success`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`tokens_limit` integer DEFAULT 10000 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`renewal_date` integer,
	`canceled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_workspace_id_unique` ON `subscriptions` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `top_up_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reference` text NOT NULL,
	`provider` text DEFAULT 'pakasir' NOT NULL,
	`provider_reference` text,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`checkout_url` text,
	`payment_code` text,
	`customer_name` text,
	`customer_email` text,
	`payload` text,
	`response` text,
	`paid_at` integer,
	`expires_at` integer,
	`chain_id` integer,
	`wallet_address` text,
	`token_amount` text,
	`transaction_hash` text,
	`requires_confirms` integer DEFAULT 2,
	`confirm_count` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `top_up_orders_reference_unique` ON `top_up_orders` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `top_up_orders_provider_reference_unique` ON `top_up_orders` (`provider_reference`);--> statement-breakpoint
CREATE INDEX `idx_top_up_orders_user` ON `top_up_orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_top_up_orders_status` ON `top_up_orders` (`status`);--> statement-breakpoint
CREATE INDEX `idx_top_up_orders_provider_ref` ON `top_up_orders` (`provider`,`reference`);--> statement-breakpoint
CREATE INDEX `idx_top_up_orders_tx_hash` ON `top_up_orders` (`transaction_hash`);--> statement-breakpoint
CREATE INDEX `idx_top_up_orders_chain_wallet` ON `top_up_orders` (`chain_id`,`wallet_address`);--> statement-breakpoint
CREATE TABLE `usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`model_config_id` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`cost` integer NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`refunded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_logs_user_created` ON `usage_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_logs_model` ON `usage_logs` (`model`);--> statement-breakpoint
CREATE INDEX `idx_usage_logs_status` ON `usage_logs` (`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`image` text,
	`balance` integer DEFAULT 0 NOT NULL,
	`is_developer_account` integer DEFAULT false NOT NULL,
	`welcome_bonus_granted_at` integer,
	`email_verified` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_is_developer` ON `users` (`is_developer_account`);--> statement-breakpoint
CREATE TABLE `worker_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`trace_id` text,
	`current_job_id` text,
	`current_stage` text,
	`last_successful_transition` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`runtime_info_json` text,
	`metadata_json` text,
	`heartbeat_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_heartbeats_worker_id_unique` ON `worker_heartbeats` (`worker_id`);--> statement-breakpoint
CREATE INDEX `idx_worker_heartbeats_heartbeat` ON `worker_heartbeats` (`heartbeat_at`);--> statement-breakpoint
CREATE INDEX `idx_worker_heartbeats_current_job` ON `worker_heartbeats` (`current_job_id`);--> statement-breakpoint
CREATE INDEX `idx_worker_heartbeats_current_stage` ON `worker_heartbeats` (`current_stage`);--> statement-breakpoint
CREATE INDEX `idx_worker_heartbeats_lease_expires` ON `worker_heartbeats` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_members_unique` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_members_workspace` ON `workspace_members` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_members_user` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`image` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_created_by` ON `workspaces` (`created_by`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_slug` ON `workspaces` (`slug`);