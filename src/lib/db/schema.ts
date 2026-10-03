import { relations } from "drizzle-orm"
import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  balance: integer("balance").notNull().default(0),
  isDeveloperAccount: integer("is_developer_account", { mode: "boolean" }).notNull().default(false),
  welcomeBonusGrantedAt: integer("welcome_bonus_granted_at", { mode: "timestamp" }),
  emailVerified: integer("email_verified", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_users_email").on(t.email),
  index("idx_users_is_developer").on(t.isDeveloperAccount),
])

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  area: text("area").notNull().default("Online"),
  price: integer("price").notNull(),
  status: text("status").notNull().default("draft"),
  ownerId: text("owner_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_products_owner").on(t.ownerId),
  index("idx_products_status").on(t.status),
  index("idx_products_created").on(t.createdAt),
])

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  image: text("image"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_workspaces_created_by").on(t.createdBy),
  index("idx_workspaces_slug").on(t.slug),
])

export const workspaceMembers = sqliteTable("workspace_members", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  joinedAt: integer("joined_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_workspace_members_unique").on(t.workspaceId, t.userId),
  index("idx_workspace_members_workspace").on(t.workspaceId),
  index("idx_workspace_members_user").on(t.userId),
])

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  framework: text("framework").notNull().default("next"),
  prompt: text("prompt"),
  templateId: text("template_id"),
  customDomain: text("custom_domain"),
  domainVerified: integer("domain_verified", { mode: "boolean" }).notNull().default(false),
  memoryJson: text("memory_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_projects_workspace").on(t.workspaceId),
  index("idx_projects_template").on(t.templateId),
])

export const projectFiles = sqliteTable("project_files", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  path: text("path").notNull(),
  content: text("content").notNull(),
  language: text("language").notNull().default("typescript"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_project_files_unique").on(t.projectId, t.path),
  index("idx_project_files_project").on(t.projectId),
])

export const projectAssets = sqliteTable("project_assets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  kind: text("kind").notNull(),
  storageBucket: text("storage_bucket").notNull(),
  storagePath: text("storage_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_project_assets_unique").on(t.storageBucket, t.storagePath),
  index("idx_project_assets_project").on(t.projectId),
  index("idx_project_assets_user").on(t.userId),
])

export const generationHistory = sqliteTable("generation_history", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  prompt: text("prompt").notNull(),
  result: text("result").notNull(),
  tokensUsed: integer("tokens_used").notNull().default(0),
  intent: text("intent"),
  usedAutoRepair: integer("used_auto_repair", { mode: "boolean" }).notNull().default(false),
  idempotencyKey: text("idempotency_key"),
  cost: real("cost").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_generation_history_idempotency").on(t.projectId, t.idempotencyKey),
  index("idx_generation_history_project").on(t.projectId),
  index("idx_generation_history_created").on(t.createdAt),
])

export const generationJobs = sqliteTable("generation_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull().default("swift"),
  intent: text("intent"),
  usedAutoRepair: integer("used_auto_repair", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("queued"),
  orchestrationState: text("orchestration_state").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  label: text("label").notNull().default("Prompt diterima"),
  progress: integer("progress").notNull().default(0),
  version: integer("version").notNull().default(0),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(2),
  attemptCount: integer("attempt_count").notNull().default(0),
  planJson: text("plan_json"),
  contextJson: text("context_json"),
  diagnosticsJson: text("diagnostics_json"),
  metricsJson: text("metrics_json"),
  previewUrl: text("preview_url"),
  error: text("error"),
  resultHistoryId: text("result_history_id"),
  queueJobId: text("queue_job_id"),
  traceId: text("trace_id"),
  workerId: text("worker_id"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
  lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp" }),
  retryReason: text("retry_reason"),
  retryClass: text("retry_class"),
  recoveryCount: integer("recovery_count").notNull().default(0),
  deadLetteredAt: integer("dead_lettered_at", { mode: "timestamp" }),
  terminatedAt: integer("terminated_at", { mode: "timestamp" }),
  idempotencyKey: text("idempotency_key"),
  requestHash: text("request_hash"),
  cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
  cancelReason: text("cancel_reason"),
  timedOutAt: integer("timed_out_at", { mode: "timestamp" }),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  failedAt: integer("failed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_generation_jobs_idempotency").on(t.userId, t.projectId, t.idempotencyKey),
  uniqueIndex("idx_generation_jobs_request_hash").on(t.userId, t.projectId, t.requestHash),
  index("idx_generation_jobs_user_created").on(t.userId, t.createdAt),
  index("idx_generation_jobs_project_created").on(t.projectId, t.createdAt),
  index("idx_generation_jobs_status").on(t.status),
  index("idx_generation_jobs_orchestration_state").on(t.orchestrationState),
  index("idx_generation_jobs_stage").on(t.stage),
  index("idx_generation_jobs_cancel_requested").on(t.cancelRequested),
  index("idx_generation_jobs_queue_job_id").on(t.queueJobId),
  index("idx_generation_jobs_trace_id").on(t.traceId),
  index("idx_generation_jobs_worker_id").on(t.workerId),
  index("idx_generation_jobs_lease_owner").on(t.leaseOwner),
  index("idx_generation_jobs_lease_expires").on(t.leaseExpiresAt),
  index("idx_generation_jobs_heartbeat").on(t.lastHeartbeatAt),
])

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  generationJobId: text("generation_job_id").unique(),
  generationHistoryId: text("generation_history_id").unique(),
  source: text("source").notNull().default("generation"),
  status: text("status").notNull().default("candidate"),
  version: integer("version").notNull().default(1),
  prompt: text("prompt"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_artifacts_project_created").on(t.projectId, t.createdAt),
  index("idx_artifacts_status_created").on(t.status, t.createdAt),
  index("idx_artifacts_source").on(t.source),
])

export const artifactFiles = sqliteTable("artifact_files", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  path: text("path").notNull(),
  content: text("content").notNull(),
  language: text("language").notNull().default("typescript"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  contentHash: text("content_hash"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_artifact_files_unique").on(t.artifactId, t.path),
  index("idx_artifact_files_artifact").on(t.artifactId),
  index("idx_artifact_files_content_hash").on(t.contentHash),
])

export const generationQualityMetrics = sqliteTable("generation_quality_metrics", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().unique(),
  userId: text("user_id").notNull(),
  projectId: text("project_id").notNull(),
  appType: text("app_type").notNull(),
  status: text("status").notNull(),
  failureStage: text("failure_stage"),
  failureCode: text("failure_code"),
  buildPassed: integer("build_passed", { mode: "boolean" }).notNull().default(false),
  runtimePassed: integer("runtime_passed", { mode: "boolean" }).notNull().default(false),
  repairSucceeded: integer("repair_succeeded", { mode: "boolean" }).notNull().default(false),
  deployValidated: integer("deploy_validated", { mode: "boolean" }).notNull().default(false),
  repairAttempts: integer("repair_attempts").notNull().default(0),
  userRetryCount: integer("user_retry_count").notNull().default(0),
  providerLatencyMs: integer("provider_latency_ms").notNull().default(0),
  validationLatencyMs: integer("validation_latency_ms").notNull().default(0),
  totalLatencyMs: integer("total_latency_ms").notNull().default(0),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCost: integer("estimated_cost").notNull().default(0),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_gqm_user_created").on(t.userId, t.createdAt),
  index("idx_gqm_project_created").on(t.projectId, t.createdAt),
  index("idx_gqm_app_type_created").on(t.appType, t.createdAt),
  index("idx_gqm_status_created").on(t.status, t.createdAt),
  index("idx_gqm_failure_stage").on(t.failureStage),
])

export const generationEvents = sqliteTable("generation_events", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  traceId: text("trace_id"),
  spanId: text("span_id"),
  parentSpanId: text("parent_span_id"),
  workerId: text("worker_id"),
  sandboxId: text("sandbox_id"),
  previewId: text("preview_id"),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  eventType: text("event_type"),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  message: text("message").notNull(),
  dataJson: text("data_json"),
  metadataJson: text("metadata_json"),
  retryCount: integer("retry_count").notNull().default(0),
  terminationReason: text("termination_reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_generation_events_unique").on(t.jobId, t.sequence),
  index("idx_generation_events_job_created").on(t.jobId, t.createdAt),
  index("idx_generation_events_job_sequence").on(t.jobId, t.sequence),
  index("idx_generation_events_type").on(t.type),
  index("idx_generation_events_event_type").on(t.eventType),
  index("idx_generation_events_trace_id").on(t.traceId),
  index("idx_generation_events_worker_id").on(t.workerId),
  index("idx_generation_events_preview_id").on(t.previewId),
])

export const repairAttempts = sqliteTable("repair_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  traceId: text("trace_id"),
  spanId: text("span_id"),
  workerId: text("worker_id"),
  attempt: integer("attempt").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  terminationReason: text("termination_reason"),
  validatorError: text("validator_error"),
  inputHash: text("input_hash"),
  outputHash: text("output_hash"),
  idempotencyKey: text("idempotency_key"),
  metadataJson: text("metadata_json"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_repair_attempts_unique").on(t.jobId, t.attempt),
  uniqueIndex("idx_repair_attempts_idempotency").on(t.jobId, t.idempotencyKey),
  index("idx_repair_attempts_job_started").on(t.jobId, t.startedAt),
  index("idx_repair_attempts_status").on(t.status),
  index("idx_repair_attempts_termination").on(t.terminationReason),
  index("idx_repair_attempts_trace_id").on(t.traceId),
])

export const previewSessions = sqliteTable("preview_sessions", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  projectId: text("project_id").notNull(),
  traceId: text("trace_id"),
  spanId: text("span_id"),
  workerId: text("worker_id"),
  sandboxId: text("sandbox_id"),
  previewUrl: text("preview_url"),
  status: text("status").notNull().default("starting"),
  bootStartedAt: integer("boot_started_at", { mode: "timestamp" }),
  buildStartedAt: integer("build_started_at", { mode: "timestamp" }),
  buildCompletedAt: integer("build_completed_at", { mode: "timestamp" }),
  devServerStartedAt: integer("dev_server_started_at", { mode: "timestamp" }),
  reachableAt: integer("reachable_at", { mode: "timestamp" }),
  terminatedAt: integer("terminated_at", { mode: "timestamp" }),
  terminationReason: text("termination_reason"),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  idempotencyKey: text("idempotency_key"),
  diagnosticsJson: text("diagnostics_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_preview_sessions_idempotency").on(t.jobId, t.idempotencyKey),
  index("idx_preview_sessions_job_created").on(t.jobId, t.createdAt),
  index("idx_preview_sessions_project_created").on(t.projectId, t.createdAt),
  index("idx_preview_sessions_status").on(t.status),
  index("idx_preview_sessions_trace_id").on(t.traceId),
  index("idx_preview_sessions_sandbox_id").on(t.sandboxId),
  index("idx_preview_sessions_expires").on(t.expiresAt),
])

export const workerHeartbeats = sqliteTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull().unique(),
  traceId: text("trace_id"),
  currentJobId: text("current_job_id"),
  currentStage: text("current_stage"),
  lastSuccessfulTransition: text("last_successful_transition"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
  runtimeInfoJson: text("runtime_info_json"),
  metadataJson: text("metadata_json"),
  heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_worker_heartbeats_heartbeat").on(t.heartbeatAt),
  index("idx_worker_heartbeats_current_job").on(t.currentJobId),
  index("idx_worker_heartbeats_current_stage").on(t.currentStage),
  index("idx_worker_heartbeats_lease_expires").on(t.leaseExpiresAt),
])

export const orchestrationFailures = sqliteTable("orchestration_failures", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  traceId: text("trace_id"),
  workerId: text("worker_id"),
  eventType: text("event_type").notNull(),
  stage: text("stage").notNull(),
  severity: text("severity").notNull().default("error"),
  reason: text("reason").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  terminationReason: text("termination_reason"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_orchestration_failures_job_created").on(t.jobId, t.createdAt),
  index("idx_orchestration_failures_trace_id").on(t.traceId),
  index("idx_orchestration_failures_worker_id").on(t.workerId),
  index("idx_orchestration_failures_event_type").on(t.eventType),
  index("idx_orchestration_failures_severity").on(t.severity),
  index("idx_orchestration_failures_termination").on(t.terminationReason),
  index("idx_orchestration_failures_created").on(t.createdAt),
])

export const generationAttempts = sqliteTable("generation_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  sequence: integer("sequence").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  latencyMs: integer("latency_ms").notNull().default(0),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  error: text("error"),
  metadataJson: text("metadata_json"),
}, (t) => [
  uniqueIndex("idx_generation_attempts_unique").on(t.jobId, t.sequence),
  index("idx_generation_attempts_job_started").on(t.jobId, t.startedAt),
  index("idx_generation_attempts_provider_model").on(t.provider, t.model),
  index("idx_generation_attempts_status").on(t.status),
])

export const requestLogs = sqliteTable("request_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  taskType: text("task_type").notNull(),
  modelConfigId: text("model_config_id"),
  modelUsed: text("model_used").notNull(),
  provider: text("provider"),
  latencyMs: integer("latency_ms").notNull().default(0),
  tokens: integer("tokens").notNull().default(0),
  success: integer("success", { mode: "boolean" }).notNull().default(false),
  errorMessage: text("error_message"),
  contextJson: text("context_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_request_logs_project_created").on(t.projectId, t.createdAt),
  index("idx_request_logs_task_type").on(t.taskType),
  index("idx_request_logs_model_used").on(t.modelUsed),
  index("idx_request_logs_provider").on(t.provider),
  index("idx_request_logs_success").on(t.success),
])

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  lastUsed: integer("last_used", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
}, (t) => [
  index("idx_api_keys_workspace").on(t.workspaceId),
  index("idx_api_keys_key").on(t.key),
])

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  tokensLimit: integer("tokens_limit").notNull().default(10000),
  tokensUsed: integer("tokens_used").notNull().default(0),
  renewalDate: integer("renewal_date", { mode: "timestamp" }),
  canceledAt: integer("canceled_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
})

export const billingTransactions = sqliteTable("billing_transactions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  grantId: text("grant_id"),
  actorUserId: text("actor_user_id"),
  counterpartyUserId: text("counterparty_user_id"),
  kind: text("kind").notNull(),
  direction: text("direction").notNull(),
  amount: integer("amount").notNull(),
  balanceBefore: integer("balance_before").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  reference: text("reference").unique(),
  provider: text("provider"),
  providerReference: text("provider_reference"),
  description: text("description"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_billing_transactions_user").on(t.userId),
  index("idx_billing_transactions_grant").on(t.grantId),
  index("idx_billing_transactions_actor").on(t.actorUserId),
  index("idx_billing_transactions_counterparty").on(t.counterpartyUserId),
  index("idx_billing_transactions_kind").on(t.kind),
  index("idx_billing_transactions_provider_ref").on(t.provider, t.providerReference),
  index("idx_billing_transactions_created").on(t.createdAt),
])

export const creditGrants = sqliteTable("credit_grants", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  fromUserId: text("from_user_id").notNull(),
  toUserId: text("to_user_id").notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  note: text("note"),
  status: text("status").notNull().default("posted"),
  createdByUserId: text("created_by_user_id").notNull(),
  reversedByUserId: text("reversed_by_user_id"),
  idempotencyKey: text("idempotency_key").unique(),
  postedAt: integer("posted_at", { mode: "timestamp" }),
  reversedAt: integer("reversed_at", { mode: "timestamp" }),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_credit_grants_from_user").on(t.fromUserId),
  index("idx_credit_grants_to_user").on(t.toUserId),
  index("idx_credit_grants_created_by").on(t.createdByUserId),
  index("idx_credit_grants_reversed_by").on(t.reversedByUserId),
  index("idx_credit_grants_status").on(t.status),
  index("idx_credit_grants_created").on(t.createdAt),
])

export const topUpOrders = sqliteTable("top_up_orders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  reference: text("reference").notNull().unique(),
  provider: text("provider").notNull().default("pakasir"),
  providerReference: text("provider_reference").unique(),
  amount: integer("amount").notNull(),
  status: text("status").notNull().default("pending"),
  checkoutUrl: text("checkout_url"),
  paymentCode: text("payment_code"),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  payload: text("payload"),
  response: text("response"),
  paidAt: integer("paid_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  chainId: integer("chain_id"),
  walletAddress: text("wallet_address"),
  tokenAmount: text("token_amount"),
  transactionHash: text("transaction_hash"),
  requiresConfirms: integer("requires_confirms").default(2),
  confirmCount: integer("confirm_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_top_up_orders_user").on(t.userId),
  index("idx_top_up_orders_status").on(t.status),
  index("idx_top_up_orders_provider_ref").on(t.provider, t.reference),
  index("idx_top_up_orders_tx_hash").on(t.transactionHash),
  index("idx_top_up_orders_chain_wallet").on(t.chainId, t.walletAddress),
])

export const cryptoPayments = sqliteTable("crypto_payments", {
  id: text("id").primaryKey(),
  topUpOrderId: text("top_up_order_id").notNull().unique(),
  chainId: integer("chain_id").notNull(),
  chainName: text("chain_name").notNull(),
  tokenSymbol: text("token_symbol").notNull().default("Native"),
  amountInUsd: integer("amount_in_usd").notNull(),
  amountInToken: text("amount_in_token").notNull(),
  senderAddress: text("sender_address").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  transactionHash: text("transaction_hash"),
  blockNumber: integer("block_number"),
  confirmations: integer("confirmations").notNull().default(0),
  gasUsed: text("gas_used"),
  gasPriceInGwei: text("gas_price_in_gwei"),
  status: text("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  detectedAt: integer("detected_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_crypto_payments_chain_tx").on(t.chainId, t.transactionHash),
  index("idx_crypto_payments_sender").on(t.senderAddress),
  index("idx_crypto_payments_status").on(t.status),
  index("idx_crypto_payments_detected").on(t.detectedAt),
])

export const modelConfigs = sqliteTable("model_configs", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  price: integer("price").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_model_configs_provider").on(t.provider),
  index("idx_model_configs_active").on(t.isActive),
])

export const modelScores = sqliteTable("model_scores", {
  id: text("id").primaryKey(),
  modelName: text("model_name").notNull(),
  taskType: text("task_type").notNull(),
  provider: text("provider"),
  successRate: real("success_rate").notNull().default(0),
  avgLatency: integer("avg_latency").notNull().default(0),
  avgRating: real("avg_rating").notNull().default(0),
  sampleCount: integer("sample_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("idx_model_scores_unique").on(t.modelName, t.taskType),
  index("idx_model_scores_task_type").on(t.taskType),
  index("idx_model_scores_model_name").on(t.modelName),
  index("idx_model_scores_provider").on(t.provider),
])

export const usageLogs = sqliteTable("usage_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  modelConfigId: text("model_config_id").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  cost: integer("cost").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  refundedAt: integer("refunded_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("idx_usage_logs_user_created").on(t.userId, t.createdAt),
  index("idx_usage_logs_model").on(t.model),
  index("idx_usage_logs_status").on(t.status),
])

export const usersRelations = relations(users, ({ many }) => ({
  workspaces: many(workspaces),
  memberships: many(workspaceMembers),
  topUpOrders: many(topUpOrders),
  billingTransactions: many(billingTransactions),
}))

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  creator: one(users, {
    fields: [workspaces.createdBy],
    references: [users.id],
  }),
  members: many(workspaceMembers),
  subscription: one(subscriptions, {
    fields: [workspaces.id],
    references: [subscriptions.workspaceId],
  }),
}))

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMembers.userId],
    references: [users.id],
  }),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [projects.workspaceId],
    references: [workspaces.id],
  }),
  files: many(projectFiles),
  history: many(generationHistory),
}))

export const projectFilesRelations = relations(projectFiles, ({ one }) => ({
  project: one(projects, {
    fields: [projectFiles.projectId],
    references: [projects.id],
  }),
}))

export const generationHistoryRelations = relations(generationHistory, ({ one }) => ({
  project: one(projects, {
    fields: [generationHistory.projectId],
    references: [projects.id],
  }),
}))

export const topUpOrdersRelations = relations(topUpOrders, ({ one }) => ({
  user: one(users, {
    fields: [topUpOrders.userId],
    references: [users.id],
  }),
  cryptoPayment: one(cryptoPayments, {
    fields: [topUpOrders.id],
    references: [cryptoPayments.topUpOrderId],
  }),
}))

export const cryptoPaymentsRelations = relations(cryptoPayments, ({ one }) => ({
  topUpOrder: one(topUpOrders, {
    fields: [cryptoPayments.topUpOrderId],
    references: [topUpOrders.id],
  }),
}))

export const billingTransactionsRelations = relations(billingTransactions, ({ one }) => ({
  user: one(users, {
    fields: [billingTransactions.userId],
    references: [users.id],
  }),
}))

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  generationJob: one(generationJobs, {
    fields: [artifacts.generationJobId],
    references: [generationJobs.id],
  }),
}))
