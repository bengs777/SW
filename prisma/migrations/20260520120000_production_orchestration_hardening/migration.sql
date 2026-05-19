-- Production orchestration hardening: durable leases, replay metadata, repair/preview history, worker heartbeats, and terminal failures.

ALTER TABLE "GenerationJob"
  ADD COLUMN IF NOT EXISTS "orchestrationState" TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS "traceId" TEXT,
  ADD COLUMN IF NOT EXISTS "workerId" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseOwner" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retryReason" TEXT,
  ADD COLUMN IF NOT EXISTS "retryClass" TEXT,
  ADD COLUMN IF NOT EXISTS "recoveryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deadLetteredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "terminatedAt" TIMESTAMP(3);

ALTER TABLE "GenerationEvent"
  ADD COLUMN IF NOT EXISTS "traceId" TEXT,
  ADD COLUMN IF NOT EXISTS "spanId" TEXT,
  ADD COLUMN IF NOT EXISTS "parentSpanId" TEXT,
  ADD COLUMN IF NOT EXISTS "workerId" TEXT,
  ADD COLUMN IF NOT EXISTS "sandboxId" TEXT,
  ADD COLUMN IF NOT EXISTS "previewId" TEXT,
  ADD COLUMN IF NOT EXISTS "eventType" TEXT,
  ADD COLUMN IF NOT EXISTS "metadataJson" TEXT,
  ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "terminationReason" TEXT;

UPDATE "GenerationEvent" SET "eventType" = "type" WHERE "eventType" IS NULL;

CREATE TABLE IF NOT EXISTS "RepairAttempt" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "traceId" TEXT,
  "spanId" TEXT,
  "workerId" TEXT,
  "attempt" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "terminationReason" TEXT,
  "validatorError" TEXT,
  "inputHash" TEXT,
  "outputHash" TEXT,
  "idempotencyKey" TEXT,
  "metadataJson" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RepairAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PreviewSession" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "traceId" TEXT,
  "spanId" TEXT,
  "workerId" TEXT,
  "sandboxId" TEXT,
  "previewUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'starting',
  "bootStartedAt" TIMESTAMP(3),
  "buildStartedAt" TIMESTAMP(3),
  "buildCompletedAt" TIMESTAMP(3),
  "devServerStartedAt" TIMESTAMP(3),
  "reachableAt" TIMESTAMP(3),
  "terminatedAt" TIMESTAMP(3),
  "terminationReason" TEXT,
  "expiresAt" TIMESTAMP(3),
  "idempotencyKey" TEXT,
  "diagnosticsJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreviewSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PreviewSession_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WorkerHeartbeat" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "traceId" TEXT,
  "currentJobId" TEXT,
  "currentStage" TEXT,
  "lastSuccessfulTransition" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "runtimeInfoJson" TEXT,
  "metadataJson" TEXT,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OrchestrationFailure" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "traceId" TEXT,
  "workerId" TEXT,
  "eventType" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'error',
  "reason" TEXT NOT NULL,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "terminationReason" TEXT,
  "metadataJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrchestrationFailure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrchestrationFailure_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "GenerationJob_orchestrationState_idx" ON "GenerationJob"("orchestrationState");
CREATE INDEX IF NOT EXISTS "GenerationJob_traceId_idx" ON "GenerationJob"("traceId");
CREATE INDEX IF NOT EXISTS "GenerationJob_workerId_idx" ON "GenerationJob"("workerId");
CREATE INDEX IF NOT EXISTS "GenerationJob_leaseOwner_idx" ON "GenerationJob"("leaseOwner");
CREATE INDEX IF NOT EXISTS "GenerationJob_leaseExpiresAt_idx" ON "GenerationJob"("leaseExpiresAt");
CREATE INDEX IF NOT EXISTS "GenerationJob_lastHeartbeatAt_idx" ON "GenerationJob"("lastHeartbeatAt");

CREATE INDEX IF NOT EXISTS "GenerationEvent_eventType_idx" ON "GenerationEvent"("eventType");
CREATE INDEX IF NOT EXISTS "GenerationEvent_traceId_idx" ON "GenerationEvent"("traceId");
CREATE INDEX IF NOT EXISTS "GenerationEvent_workerId_idx" ON "GenerationEvent"("workerId");
CREATE INDEX IF NOT EXISTS "GenerationEvent_previewId_idx" ON "GenerationEvent"("previewId");

CREATE UNIQUE INDEX IF NOT EXISTS "RepairAttempt_jobId_attempt_key" ON "RepairAttempt"("jobId", "attempt");
CREATE UNIQUE INDEX IF NOT EXISTS "RepairAttempt_jobId_idempotencyKey_key" ON "RepairAttempt"("jobId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "RepairAttempt_jobId_startedAt_idx" ON "RepairAttempt"("jobId", "startedAt");
CREATE INDEX IF NOT EXISTS "RepairAttempt_status_idx" ON "RepairAttempt"("status");
CREATE INDEX IF NOT EXISTS "RepairAttempt_terminationReason_idx" ON "RepairAttempt"("terminationReason");
CREATE INDEX IF NOT EXISTS "RepairAttempt_traceId_idx" ON "RepairAttempt"("traceId");

CREATE UNIQUE INDEX IF NOT EXISTS "PreviewSession_jobId_idempotencyKey_key" ON "PreviewSession"("jobId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "PreviewSession_jobId_createdAt_idx" ON "PreviewSession"("jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "PreviewSession_projectId_createdAt_idx" ON "PreviewSession"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "PreviewSession_status_idx" ON "PreviewSession"("status");
CREATE INDEX IF NOT EXISTS "PreviewSession_traceId_idx" ON "PreviewSession"("traceId");
CREATE INDEX IF NOT EXISTS "PreviewSession_sandboxId_idx" ON "PreviewSession"("sandboxId");
CREATE INDEX IF NOT EXISTS "PreviewSession_expiresAt_idx" ON "PreviewSession"("expiresAt");

CREATE UNIQUE INDEX IF NOT EXISTS "WorkerHeartbeat_workerId_key" ON "WorkerHeartbeat"("workerId");
CREATE INDEX IF NOT EXISTS "WorkerHeartbeat_heartbeatAt_idx" ON "WorkerHeartbeat"("heartbeatAt");
CREATE INDEX IF NOT EXISTS "WorkerHeartbeat_currentJobId_idx" ON "WorkerHeartbeat"("currentJobId");
CREATE INDEX IF NOT EXISTS "WorkerHeartbeat_currentStage_idx" ON "WorkerHeartbeat"("currentStage");
CREATE INDEX IF NOT EXISTS "WorkerHeartbeat_leaseExpiresAt_idx" ON "WorkerHeartbeat"("leaseExpiresAt");

CREATE INDEX IF NOT EXISTS "OrchestrationFailure_jobId_createdAt_idx" ON "OrchestrationFailure"("jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "OrchestrationFailure_traceId_idx" ON "OrchestrationFailure"("traceId");
CREATE INDEX IF NOT EXISTS "OrchestrationFailure_workerId_idx" ON "OrchestrationFailure"("workerId");
CREATE INDEX IF NOT EXISTS "OrchestrationFailure_eventType_idx" ON "OrchestrationFailure"("eventType");
CREATE INDEX IF NOT EXISTS "OrchestrationFailure_severity_idx" ON "OrchestrationFailure"("severity");
CREATE INDEX IF NOT EXISTS "OrchestrationFailure_terminationReason_idx" ON "OrchestrationFailure"("terminationReason");
CREATE INDEX IF NOT EXISTS "OrchestrationFailure_createdAt_idx" ON "OrchestrationFailure"("createdAt");
