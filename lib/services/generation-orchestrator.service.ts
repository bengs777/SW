import { performance } from "node:perf_hooks"
import type { GeneratedFile } from "@/lib/types"
import { buildContextForTask } from "@/lib/ai/context-builder"
import {
  buildDependencyMap,
  buildStaticValidationPrompt,
  classifyPrompt,
  normalizeGeneratedDependencies,
  routeModelForRequest,
  trimContextForGeneration,
  type DependencyMap,
} from "@/lib/ai/generation-pipeline"
import { validateFullStackFiles } from "@/lib/ai/fullstack-validator"
import { parseGeneratedArtifact } from "@/lib/ai/generated-artifact"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getSwiftTierConfig } from "@/lib/ai/swift-tiers"
import { normalizePreviewContext } from "@/lib/ai/preview-context"
import { compileProject } from "@/lib/preview/module-resolution"
import { startRuntimeSandbox, type SandboxValidationStep } from "@/lib/sandbox/runtime"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { GenerationJobCancelledError, GenerationJobService, type GenerationJobStage } from "@/lib/services/generation-job.service"
import { GenerationQualityService, type GenerationQualityStage } from "@/lib/services/generation-quality.service"
import {
  buildBlueprintInstructionBlock,
  buildDynamicSeedDirective,
  classifyControlledAppType,
  getControlledAppBlueprint,
  validateBlueprintConstraints,
  type ControlledAppBlueprint,
  type ControlledAppType,
} from "@/lib/ai/app-blueprints"
import {
  buildPartialEditInstructionBlock,
  buildPartialEditPlan,
  filterFilesForPartialEdit,
  type PartialEditPlan,
} from "@/lib/ai/edit-planner"
import { analyzePromptIntent, buildIntentInstructionBlock, type IntentAnalysis } from "@/lib/ai/intent-analyzer"
import { executeGeneratedTaskGraph } from "@/lib/ai/task-graph-executor"
import { log } from "@/lib/logging"
import { timeoutConfig } from "@/lib/timeouts"

type GenerationPlannerFile = {
  path: string
  reason: string
  action: "create_or_update"
}

type GenerationPlan = {
  objective: string
  appType: ControlledAppType
  intent: IntentAnalysis
  editPlan: PartialEditPlan
  productionMode: "preview" | "production_fullstack"
  maxFilesThisPass: number
  blueprint: {
    label: string
    requiredFiles: string[]
    stack: string[]
  }
  filePlan: GenerationPlannerFile[]
  architecturePlan: string[]
  dependencyPlan: string[]
  fileGraphPlan: string[]
  contextBudget: {
    maxFiles: number
    maxCharsPerFile: number
    maxTotalChars: number
    usedFiles: number
    usedChars: number
  }
}

type ExecuteGenerationJobInput = {
  jobId: string
  projectId: string
  prompt: string
  selectedModel: string
  promptLanguage?: "id" | "en"
  collaborationMode?: string
  previewContext?: unknown
  persistenceKey?: string | null
  signal?: AbortSignal
}

type ExecuteGenerationJobDeps = {
  loadProjectFiles: (projectId: string) => Promise<GeneratedFile[]>
}

const MAX_REPAIR_ATTEMPTS = 1
const PREVIEW_FOUNDATION_FILE_LIMIT = 3
const PRODUCTION_FULLSTACK_FILE_LIMIT = 16
const PRODUCTION_FULLSTACK_BATCH_SIZE = 8

type ValidationLifecycleStep =
  | "normalize"
  | "static"
  | "preview-compile"
  | "dependency-install"
  | "typecheck"
  | "lint"
  | "build"
  | "runtime-smoke"

type ValidationLifecycleStepResult = {
  name: ValidationLifecycleStep
  status: "passed" | "failed" | "skipped"
  policy: "required" | "advisory"
  durationMs: number
  message?: string
  data?: Record<string, unknown>
}

type ValidationLifecycleFailure = {
  step: ValidationLifecycleStep
  message: string
  data?: Record<string, unknown>
}

type ValidationLifecycleResult = {
  ok: boolean
  files: GeneratedFile[]
  previewUrl: string | null
  previewStatus: string | null
  steps: ValidationLifecycleStepResult[]
  sandboxValidation: SandboxValidationStep[]
  failure?: ValidationLifecycleFailure
}

type RemoteSandboxResponse = {
  status?: string | null
  previewUrl?: string | null
  logs?: string[] | null
  error?: string | null
}

const sandboxServiceUrl = () => (process.env.SANDBOX_SERVICE_URL || "").replace(/\/+$/, "")
const sandboxServiceToken = () => process.env.SANDBOX_SERVICE_TOKEN || ""
const isProductionVercel = () => process.env.NODE_ENV === "production" && Boolean(process.env.VERCEL)

function canUseRemoteSandboxService() {
  const url = sandboxServiceUrl()
  const token = sandboxServiceToken()
  if (!url || !token) return false
  if (!process.env.VERCEL && process.env.SWIFT_USE_REMOTE_SANDBOX !== "true") return false
  return true
}

async function startConfiguredSandboxService(input: {
  projectId: string
  files: GeneratedFile[]
  signal?: AbortSignal
}): Promise<RemoteSandboxResponse> {
  const headers: HeadersInit = {
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  const token = sandboxServiceToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const timeoutMs = timeoutConfig.sandboxServiceMs
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortRequest = () => controller.abort()
  input.signal?.addEventListener("abort", abortRequest, { once: true })

  let response: Response
  try {
    response = await fetch(
      `${sandboxServiceUrl()}/sandbox/${encodeURIComponent(input.projectId)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ files: input.files }),
        signal: controller.signal,
        cache: "no-store",
      }
    )
  } catch (error) {
    return {
      status: "error",
      previewUrl: null,
      logs: [],
      error:
        error instanceof Error && error.name === "AbortError"
          ? `Sandbox service request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Sandbox service request failed",
    }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", abortRequest)
  }

  const data = (await response.json().catch(() => ({
    status: "error",
    previewUrl: null,
    logs: [],
    error: `Sandbox service returned non-JSON response (${response.status})`,
  }))) as RemoteSandboxResponse

  if (!response.ok) {
    return {
      status: data.status || "error",
      previewUrl: data.previewUrl || null,
      logs: Array.isArray(data.logs) ? data.logs : [],
      error: data.error || `Sandbox service failed with HTTP ${response.status}`,
    }
  }

  return {
    status: data.status || null,
    previewUrl: data.previewUrl || null,
    logs: Array.isArray(data.logs) ? data.logs : [],
    error: data.error || null,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    }
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
  }
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Generation aborted before completion")
  }
}

function shouldUseProductionFullStackMode(prompt: string, input?: { collaborationMode?: string | null }) {
  const text = `${prompt}\n${input?.collaborationMode || ""}`.toLowerCase()
  const explicitFullStack =
    /\b(full\s*stack|fullstack|backend|database|db|prisma|postgres|api route|route handler|crud|auth|login|register|role|rbac|admin|pengelola|user|payment|checkout|webhook|integrasi|integration|bpjs|klinik|clinic|rumah sakit|hospital|pasien|patient|dokter|doctor|appointment|janji temu|jadwal)\b/i.test(text)
  const explicitBuild =
    /\b(buat|bikin|generate|build|jadikan|create|website|web|app|aplikasi|desain|rancang|struktur)\b/i.test(text)

  return explicitFullStack && explicitBuild
}

function productionRequiredFiles(blueprint: ControlledAppBlueprint, prompt: string) {
  const text = prompt.toLowerCase()
  const coreFiles = [
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "prisma/schema.prisma",
    ".env.example",
    "package.json",
  ]

  if (blueprint.appType === "clinic_management") {
    const clinicCore = [
      ...coreFiles,
      "app/api/patients/route.ts",
      "app/api/doctors/route.ts",
      "app/api/appointments/route.ts",
      "app/api/auth/route.ts",
      "app/api/bpjs/route.ts",
      "lib/services/clinic.service.ts",
      "lib/services/bpjs.service.ts",
      "components/clinic-dashboard.tsx",
    ]
    return Array.from(new Set(clinicCore)).slice(0, PRODUCTION_FULLSTACK_FILE_LIMIT)
  }

  const genericSupportFiles = new Set([
    "app/api/health/route.ts",
    "components/build-status-panel.tsx",
    "lib/services/project.service.ts",
  ])
  const required = new Set<string>(coreFiles)
  const domainFiles = blueprint.requiredFiles
    .map(normalizePath)
    .filter((filePath) => !required.has(filePath) && !genericSupportFiles.has(filePath))

  for (const filePath of domainFiles) {
    required.add(filePath)
  }

  if (/\b(admin|pengelola|staff|role|rbac|user|login|auth)\b/i.test(text)) {
    required.add("app/admin/page.tsx")
    required.add("app/api/admin/users/route.ts")
    required.add("app/api/auth/route.ts")
  }

  if (/\b(klinik|clinic|rumah sakit|hospital|pasien|patient|dokter|doctor|bpjs|appointment|janji temu|jadwal)\b/i.test(text)) {
    required.add("app/dashboard/page.tsx")
    required.add("app/patients/page.tsx")
    required.add("app/doctors/page.tsx")
    required.add("app/appointments/page.tsx")
    required.add("app/api/patients/route.ts")
    required.add("app/api/doctors/route.ts")
    required.add("app/api/appointments/route.ts")
    required.add("app/api/auth/route.ts")
    required.add("app/api/bpjs/route.ts")
    required.add("lib/services/clinic.service.ts")
    required.add("components/clinic-dashboard.tsx")
    required.add("hooks/use-clinic-data.ts")
  }

  if (/\b(bpjs)\b/i.test(text)) {
    required.add("app/api/bpjs/route.ts")
    required.add("app/api/integrations/bpjs/route.ts")
    required.add("lib/services/bpjs.service.ts")
    required.add("services/bpjs.ts")
  }

  if (/\b(payment|checkout|bayar|pembayaran|pakasir|stripe|midtrans|xendit|webhook)\b/i.test(text)) {
    required.add("app/api/payments/checkout/route.ts")
    required.add("app/api/payments/webhook/route.ts")
    required.add("lib/services/payment.service.ts")
  }

  if (/\b(api|integrasi|integration|connect|hubungkan|external api|third party)\b/i.test(text)) {
    required.add("app/api/integrations/route.ts")
    required.add("lib/services/integration.service.ts")
  }

  for (const filePath of genericSupportFiles) {
    required.add(filePath)
  }

  return Array.from(required).slice(0, PRODUCTION_FULLSTACK_FILE_LIMIT)
}

function buildFastClinicFullStackScaffold(input: {
  plan: GenerationPlan
  prompt: string
}): GeneratedFile[] | null {
  if (process.env.SWIFT_DISABLE_FAST_FULLSTACK_SCAFFOLD === "true") return null
  if (input.plan.productionMode !== "production_fullstack") return null
  if (input.plan.appType !== "clinic_management") return null
  if (input.plan.editPlan.mode !== "full") return null

  const files = new Map(buildClinicCoreFiles().map((file) => [normalizePath(file.path), file]))
  const plannedPaths = input.plan.filePlan.map((file) => normalizePath(file.path))
  if (plannedPaths.some((path) => !files.has(path))) return null

  return plannedPaths
    .map((path) => files.get(path))
    .filter((file): file is GeneratedFile => Boolean(file))
}

function buildClinicCoreFiles(): GeneratedFile[] {
  return [
    {
      path: "app/layout.tsx",
      language: "tsx",
      content: `import type { ReactNode } from "react"
import "./globals.css"

export const metadata = {
  title: "Swift Clinic BPJS",
  description: "Full-stack clinic management core generated by Swift.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  )
}
`,
    },
    {
      path: "app/page.tsx",
      language: "tsx",
      content: `import { ClinicDashboard } from "@/components/clinic-dashboard"

export default function HomePage() {
  return (
    <main className="app-shell">
      <ClinicDashboard />
    </main>
  )
}
`,
    },
    {
      path: "app/globals.css",
      language: "css",
      content: `:root {
  --background: #f6f8fb;
  --foreground: #172033;
  --panel: #ffffff;
  --line: #d8e1ef;
  --muted: #5d6b82;
  --primary: #1268b3;
  --primary-dark: #0d4f88;
  --success: #0f8f6d;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: Arial, Helvetica, sans-serif;
}

button,
input,
select {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  padding: 24px;
}

.clinic-shell {
  display: grid;
  gap: 20px;
  max-width: 1180px;
  margin: 0 auto;
}

.clinic-header,
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 12px 30px rgba(23, 32, 51, 0.08);
}

.clinic-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 20px;
}

.clinic-title {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
}

.clinic-subtitle,
.muted {
  color: var(--muted);
}

.status-grid,
.content-grid {
  display: grid;
  gap: 16px;
}

.status-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.content-grid {
  grid-template-columns: 1.1fr 0.9fr;
}

.panel {
  padding: 18px;
}

.metric {
  display: grid;
  gap: 8px;
}

.metric strong {
  font-size: 28px;
}

.toolbar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.input {
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  background: #fff;
}

.button {
  min-height: 40px;
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  color: #fff;
  background: var(--primary);
  cursor: pointer;
}

.button:hover {
  background: var(--primary-dark);
}

.list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  border-radius: 999px;
  padding: 4px 10px;
  color: #07503f;
  background: #dff8ee;
  font-size: 12px;
}

.error {
  color: #9d1c1c;
}

@media (max-width: 800px) {
  .app-shell {
    padding: 12px;
  }

  .clinic-header,
  .row {
    flex-direction: column;
  }

  .status-grid,
  .content-grid {
    grid-template-columns: 1fr;
  }
}
`,
    },
    {
      path: "package.json",
      language: "json",
      content: `${JSON.stringify(
        {
          name: "swift-clinic-bpjs",
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
            typecheck: "tsc --noEmit",
            lint: "eslint .",
            "db:generate": "prisma generate",
          },
          dependencies: {
            "@prisma/client": "^5.22.0",
            next: "^16.2.6",
            "next-auth": "^5.0.0-beta.20",
            react: "^19.2.5",
            "react-dom": "^19.2.5",
            zod: "^3.24.1",
          },
          devDependencies: {
            "@types/node": "^22",
            "@types/react": "19.2.14",
            "@types/react-dom": "19.2.3",
            eslint: "^9.39.4",
            "eslint-config-next": "^16.2.6",
            prisma: "^5.22.0",
            typescript: "5.7.3",
          },
        },
        null,
        2
      )}\n`,
    },
    {
      path: ".env.example",
      language: "env",
      content: `DATABASE_URL="postgresql://user:password@host:5432/swift_clinic"
DIRECT_DATABASE_URL=""
NEXTAUTH_SECRET="change-me"
NEXTAUTH_URL="http://localhost:3000"
BPJS_API_BASE_URL=""
BPJS_CONS_ID=""
BPJS_SECRET_KEY=""
BPJS_USER_KEY=""
`,
    },
    {
      path: "prisma/schema.prisma",
      language: "prisma",
      content: `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  PENGELOLA
  DOKTER
  USER
}

enum AppointmentStatus {
  SCHEDULED
  CHECKED_IN
  COMPLETED
  CANCELLED
}

model User {
  id        String   @id @default(cuid())
  name      String
  email     String   @unique
  role      Role     @default(USER)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Patient {
  id                String              @id @default(cuid())
  medicalRecordNo   String              @unique
  nationalId        String?             @unique
  bpjsNumber        String?
  name              String
  phone             String?
  birthDate         DateTime?
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt
  appointments      Appointment[]
  bpjsVerifications BpjsVerification[]
}

model Doctor {
  id           String        @id @default(cuid())
  name         String
  specialty    String
  licenseNo    String?       @unique
  scheduleNote String?
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  appointments Appointment[]
}

model Appointment {
  id        String            @id @default(cuid())
  patientId String
  doctorId  String
  startsAt  DateTime
  status    AppointmentStatus @default(SCHEDULED)
  notes     String?
  createdAt DateTime          @default(now())
  updatedAt DateTime          @updatedAt
  patient   Patient           @relation(fields: [patientId], references: [id], onDelete: Cascade)
  doctor    Doctor            @relation(fields: [doctorId], references: [id], onDelete: Cascade)
}

model BpjsVerification {
  id        String   @id @default(cuid())
  patientId String?
  nik       String?
  bpjsNo    String?
  status    String
  response  Json?
  checkedAt DateTime @default(now())
  patient   Patient? @relation(fields: [patientId], references: [id], onDelete: SetNull)
}
`,
    },
    {
      path: "lib/services/clinic.service.ts",
      language: "ts",
      content: `import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as { swiftClinicPrisma?: PrismaClient }

export const prisma =
  globalForPrisma.swiftClinicPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.swiftClinicPrisma = prisma
}

type PatientInput = {
  name: string
  medicalRecordNo?: string
  nationalId?: string
  bpjsNumber?: string
  phone?: string
}

type DoctorInput = {
  name: string
  specialty: string
  licenseNo?: string
  scheduleNote?: string
}

type AppointmentInput = {
  patientId: string
  doctorId: string
  startsAt: string
  notes?: string
}

function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL)
}

export async function listPatients() {
  if (!databaseConfigured()) return []
  try {
    return await prisma.patient.findMany({ orderBy: { createdAt: "desc" }, take: 50 })
  } catch {
    return []
  }
}

export async function createPatient(input: PatientInput) {
  if (!databaseConfigured()) {
    return { status: "database_required", input }
  }
  return prisma.patient.create({
    data: {
      name: input.name,
      medicalRecordNo: input.medicalRecordNo || \`MR-\${Date.now()}\`,
      nationalId: input.nationalId || null,
      bpjsNumber: input.bpjsNumber || null,
      phone: input.phone || null,
    },
  })
}

export async function listDoctors() {
  if (!databaseConfigured()) return []
  try {
    return await prisma.doctor.findMany({ orderBy: { name: "asc" }, take: 50 })
  } catch {
    return []
  }
}

export async function createDoctor(input: DoctorInput) {
  if (!databaseConfigured()) {
    return { status: "database_required", input }
  }
  return prisma.doctor.create({
    data: {
      name: input.name,
      specialty: input.specialty,
      licenseNo: input.licenseNo || null,
      scheduleNote: input.scheduleNote || null,
    },
  })
}

export async function listAppointments() {
  if (!databaseConfigured()) return []
  try {
    return await prisma.appointment.findMany({
      include: { patient: true, doctor: true },
      orderBy: { startsAt: "asc" },
      take: 50,
    })
  } catch {
    return []
  }
}

export async function createAppointment(input: AppointmentInput) {
  if (!databaseConfigured()) {
    return { status: "database_required", input }
  }
  return prisma.appointment.create({
    data: {
      patientId: input.patientId,
      doctorId: input.doctorId,
      startsAt: new Date(input.startsAt),
      notes: input.notes || null,
    },
  })
}
`,
    },
    {
      path: "lib/services/bpjs.service.ts",
      language: "ts",
      content: `type BpjsLookupInput = {
  nik?: string | null
  bpjsNumber?: string | null
}

function bpjsConfigured() {
  return Boolean(process.env.BPJS_API_BASE_URL && process.env.BPJS_CONS_ID && process.env.BPJS_SECRET_KEY)
}

export async function verifyBpjsParticipant(input: BpjsLookupInput) {
  const identifier = input.bpjsNumber || input.nik || ""
  if (!identifier) {
    return { ok: false, status: "missing_identifier" }
  }

  if (!bpjsConfigured()) {
    return {
      ok: false,
      status: "configuration_required",
      identifier,
      requiredEnv: ["BPJS_API_BASE_URL", "BPJS_CONS_ID", "BPJS_SECRET_KEY", "BPJS_USER_KEY"],
    }
  }

  const baseUrl = String(process.env.BPJS_API_BASE_URL).replace(/\\/+$/, "")
  const response = await fetch(\`\${baseUrl}/peserta/\${encodeURIComponent(identifier)}\`, {
    headers: {
      "x-cons-id": process.env.BPJS_CONS_ID || "",
      "user_key": process.env.BPJS_USER_KEY || "",
    },
    cache: "no-store",
  })

  const payload = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.ok ? "verified" : "bpjs_error",
    identifier,
    payload,
  }
}
`,
    },
    {
      path: "app/api/patients/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createPatient, listPatients } from "@/lib/services/clinic.service"

const patientSchema = z.object({
  name: z.string().min(2),
  medicalRecordNo: z.string().optional(),
  nationalId: z.string().optional(),
  bpjsNumber: z.string().optional(),
  phone: z.string().optional(),
})

export async function GET() {
  const patients = await listPatients()
  return NextResponse.json({ patients })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = patientSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patient payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const patient = await createPatient(parsed.data)
  return NextResponse.json({ patient }, { status: 201 })
}
`,
    },
    {
      path: "app/api/doctors/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createDoctor, listDoctors } from "@/lib/services/clinic.service"

const doctorSchema = z.object({
  name: z.string().min(2),
  specialty: z.string().min(2),
  licenseNo: z.string().optional(),
  scheduleNote: z.string().optional(),
})

export async function GET() {
  const doctors = await listDoctors()
  return NextResponse.json({ doctors })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = doctorSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid doctor payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const doctor = await createDoctor(parsed.data)
  return NextResponse.json({ doctor }, { status: 201 })
}
`,
    },
    {
      path: "app/api/appointments/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createAppointment, listAppointments } from "@/lib/services/clinic.service"

const appointmentSchema = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  startsAt: z.string().min(1),
  notes: z.string().optional(),
})

export async function GET() {
  const appointments = await listAppointments()
  return NextResponse.json({ appointments })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = appointmentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid appointment payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const appointment = await createAppointment(parsed.data)
  return NextResponse.json({ appointment }, { status: 201 })
}
`,
    },
    {
      path: "app/api/auth/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

const loginSchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "PENGELOLA", "DOKTER", "USER"]).default("USER"),
})

export async function GET() {
  return NextResponse.json({
    roles: ["ADMIN", "PENGELOLA", "DOKTER", "USER"],
    strategy: "NextAuth-ready route boundary",
  })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid auth payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  return NextResponse.json({
    user: {
      email: parsed.data.email,
      role: parsed.data.role,
    },
  })
}
`,
    },
    {
      path: "app/api/bpjs/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { verifyBpjsParticipant } from "@/lib/services/bpjs.service"

const bpjsSchema = z.object({
  nik: z.string().optional(),
  bpjsNumber: z.string().optional(),
})

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams
  const result = await verifyBpjsParticipant({
    nik: search.get("nik"),
    bpjsNumber: search.get("bpjsNumber"),
  })
  return NextResponse.json(result)
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = bpjsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid BPJS payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const result = await verifyBpjsParticipant(parsed.data)
  return NextResponse.json(result)
}
`,
    },
    {
      path: "components/clinic-dashboard.tsx",
      language: "tsx",
      content: `"use client"

import { useEffect, useMemo, useState } from "react"

type ApiState<T> = {
  data: T
  loading: boolean
  error: string | null
}

type Patient = {
  id: string
  name: string
  medicalRecordNo?: string
  bpjsNumber?: string | null
}

type Doctor = {
  id: string
  name: string
  specialty: string
}

type Appointment = {
  id: string
  startsAt: string
  status: string
  patient?: Patient
  doctor?: Doctor
}

async function loadJson<T>(url: string, key: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) {
    throw new Error(\`\${url} returned \${response.status}\`)
  }
  const payload = await response.json()
  return (payload[key] || []) as T
}

export function ClinicDashboard() {
  const [patients, setPatients] = useState<ApiState<Patient[]>>({ data: [], loading: true, error: null })
  const [doctors, setDoctors] = useState<ApiState<Doctor[]>>({ data: [], loading: true, error: null })
  const [appointments, setAppointments] = useState<ApiState<Appointment[]>>({ data: [], loading: true, error: null })
  const [nik, setNik] = useState("")
  const [bpjsStatus, setBpjsStatus] = useState<string>("Belum dicek")

  useEffect(() => {
    let active = true
    Promise.all([
      loadJson<Patient[]>("/api/patients", "patients"),
      loadJson<Doctor[]>("/api/doctors", "doctors"),
      loadJson<Appointment[]>("/api/appointments", "appointments"),
    ])
      .then(([patientRows, doctorRows, appointmentRows]) => {
        if (!active) return
        setPatients({ data: patientRows, loading: false, error: null })
        setDoctors({ data: doctorRows, loading: false, error: null })
        setAppointments({ data: appointmentRows, loading: false, error: null })
      })
      .catch((error: Error) => {
        if (!active) return
        const message = error.message || "Gagal memuat data klinik"
        setPatients({ data: [], loading: false, error: message })
        setDoctors({ data: [], loading: false, error: message })
        setAppointments({ data: [], loading: false, error: message })
      })
    return () => {
      active = false
    }
  }, [])

  const metrics = useMemo(
    () => [
      { label: "Pasien", value: patients.data.length },
      { label: "Dokter", value: doctors.data.length },
      { label: "Jadwal", value: appointments.data.length },
      { label: "Role", value: 4 },
    ],
    [appointments.data.length, doctors.data.length, patients.data.length]
  )

  async function checkBpjs() {
    setBpjsStatus("Memeriksa BPJS")
    const response = await fetch(\`/api/bpjs?nik=\${encodeURIComponent(nik)}\`, { cache: "no-store" })
    const payload = await response.json().catch(() => null)
    setBpjsStatus(payload?.status || "Tidak ada respons")
  }

  return (
    <section className="clinic-shell">
      <header className="clinic-header">
        <div>
          <p className="muted">Swift full-stack core</p>
          <h1 className="clinic-title">Manajemen Klinik dan BPJS</h1>
          <p className="clinic-subtitle">
            Dashboard terpadu untuk pasien, dokter, janji temu, role pengguna, dan batas integrasi BPJS.
          </p>
        </div>
        <span className="badge">Runnable preview</span>
      </header>

      <div className="status-grid">
        {metrics.map((metric) => (
          <article className="panel metric" key={metric.label}>
            <span className="muted">{metric.label}</span>
            <strong>{metric.value}</strong>
          </article>
        ))}
      </div>

      <div className="content-grid">
        <article className="panel">
          <h2>Operasional Hari Ini</h2>
          {patients.error ? <p className="error">{patients.error}</p> : null}
          <div className="list">
            {appointments.loading ? <p className="muted">Memuat jadwal...</p> : null}
            {!appointments.loading && appointments.data.length === 0 ? (
              <p className="muted">Belum ada jadwal. API dan Prisma model sudah siap menerima data.</p>
            ) : null}
            {appointments.data.map((item) => (
              <div className="row" key={item.id}>
                <div>
                  <strong>{item.patient?.name || "Pasien"}</strong>
                  <p className="muted">{item.doctor?.name || "Dokter belum dipilih"}</p>
                </div>
                <span className="badge">{item.status}</span>
              </div>
            ))}
          </div>
        </article>

        <aside className="panel">
          <h2>Cek BPJS</h2>
          <p className="muted">Gunakan NIK atau nomor BPJS untuk memanggil route integrasi server-side.</p>
          <div className="toolbar">
            <input
              className="input"
              value={nik}
              onChange={(event) => setNik(event.target.value)}
              placeholder="NIK atau nomor BPJS"
            />
            <button className="button" type="button" onClick={checkBpjs}>
              Cek
            </button>
          </div>
          <p className="muted">Status: {bpjsStatus}</p>
        </aside>
      </div>
    </section>
  )
}
`,
    },
  ]
}

function buildGenerationPlan(input: {
  prompt: string
  existingFiles: GeneratedFile[]
  collaborationMode?: string | null
  previewContext?: unknown
}) {
  const previewContext = normalizePreviewContext(input.previewContext)
  const classification = classifyPrompt(input.prompt, {
    existingFiles: input.existingFiles,
    collaborationMode: input.collaborationMode || undefined,
    previewError: previewContext?.previewError?.message || null,
  })
  const intent = analyzePromptIntent(input.prompt)
  const editPlan = buildPartialEditPlan({
    prompt: input.prompt,
    existingFiles: input.existingFiles,
    collaborationMode: input.collaborationMode,
    previewContext,
  })
  const appType = intent.appType || classifyControlledAppType(input.prompt)
  const blueprint = getControlledAppBlueprint(appType)
  const productionMode = shouldUseProductionFullStackMode(input.prompt, {
    collaborationMode: input.collaborationMode,
  })
    ? "production_fullstack"
    : "preview"
  const maxFilesThisPass =
    productionMode === "production_fullstack" ? PRODUCTION_FULLSTACK_FILE_LIMIT : editPlan.maxSlices
  const trimmed = trimContextForGeneration({
    prompt: input.prompt,
    files: input.existingFiles,
    activeFilePath: previewContext?.activeFilePath || undefined,
    previewErrorFile: previewContext?.previewError?.filename || undefined,
    layer: classification === "simple_ui" ? "fast" : "builder",
  })

  const plannedByPath = new Map<string, GenerationPlannerFile>()

  if (editPlan.mode === "partial") {
    for (const filePath of [...editPlan.targetPaths, ...editPlan.allowedNewPaths]) {
      const path = normalizePath(filePath)
      plannedByPath.set(path, {
        path,
        reason: editPlan.targetPaths.includes(path)
          ? `Partial ${editPlan.intent} target selected by edit planner`
          : `Partial ${editPlan.intent} may create this file if needed`,
        action: "create_or_update",
      })
    }
  } else {
    for (const filePath of extractRequestedFilePaths(input.prompt).slice(0, maxFilesThisPass)) {
      plannedByPath.set(normalizePath(filePath), {
        path: normalizePath(filePath),
        reason:
          productionMode === "production_fullstack"
            ? "Explicitly requested by the prompt for the production full-stack plan"
            : "Explicitly requested by the prompt for the preview-first foundation",
        action: "create_or_update",
      })
    }

    const requiredFiles =
      productionMode === "production_fullstack"
        ? productionRequiredFiles(blueprint, input.prompt)
        : blueprint.requiredFiles.slice(0, PREVIEW_FOUNDATION_FILE_LIMIT)

    for (const filePath of requiredFiles) {
      if (plannedByPath.size >= maxFilesThisPass) break
      plannedByPath.set(normalizePath(filePath), {
        path: normalizePath(filePath),
        reason:
          productionMode === "production_fullstack"
            ? `${blueprint.label} production full-stack plan requires this file`
            : `${blueprint.label} blueprint requires this file for deployable generation`,
        action: "create_or_update",
      })
    }

    for (const file of trimmed.files.slice(0, 8)) {
      if (plannedByPath.size >= maxFilesThisPass) break
      const path = normalizePath(file.path)
      if (!plannedByPath.has(path)) {
        plannedByPath.set(path, {
          path,
          reason: "Relevant existing file selected by context ranking",
          action: "create_or_update",
        })
      }
    }
  }

  const filePlan = Array.from(plannedByPath.values()).slice(0, maxFilesThisPass)

  if (!filePlan.some((item) => /^app\/page\.(tsx|ts|jsx|js)$/i.test(item.path))) {
    const shouldAddHomePage = editPlan.mode === "full" || input.existingFiles.length === 0
    if (shouldAddHomePage) {
      filePlan.unshift({
        path: "app/page.tsx",
        reason: "Primary visible entrypoint should be generated or refined first",
        action: "create_or_update",
      })
      if (filePlan.length > maxFilesThisPass) {
        filePlan.pop()
      }
    }
  }

  return {
    objective: classification,
    appType,
    intent,
    editPlan,
    productionMode,
    maxFilesThisPass,
    blueprint: {
      label: blueprint.label,
      requiredFiles: blueprint.requiredFiles,
      stack: blueprint.dependencyPolicy.stack,
    },
    filePlan,
    architecturePlan: blueprint.architectureRules,
    dependencyPlan: [
      "Use only the locked Swift stack.",
      `Allowed packages: ${blueprint.dependencyPolicy.allowedExternalPackages.join(", ")}`,
      "Do not introduce alternate frameworks, databases, routers, or package managers.",
    ],
    fileGraphPlan: filePlan.map((file) => `${file.path}: ${file.reason}`),
    contextBudget: {
      ...trimmed.budget,
      usedFiles: trimmed.files.length,
      usedChars: trimmed.totalChars,
    },
  } satisfies GenerationPlan
}

async function transition(jobId: string, stage: GenerationJobStage, label: string, progress: number, data?: Record<string, unknown>) {
  await GenerationJobService.transition(jobId, {
    type: `job.stage.${stage}`,
    status: stage === "completed" ? "completed" : stage === "failed" ? "failed" : stage === "cancelled" ? "cancelled" : "running",
    stage,
    label,
    progress,
    message: label,
    data,
  })
}

const totalFileBytes = (files: GeneratedFile[]) =>
  files.reduce((sum, file) => sum + Buffer.byteLength(String(file.content ?? ""), "utf8"), 0)

async function emitGeneratedFilesUpdate(input: {
  jobId: string
  stage: GenerationJobStage
  message: string
  allFiles: GeneratedFile[]
  previousFiles?: GeneratedFile[]
  changedFiles?: GeneratedFile[]
  deletedPaths?: string[]
  source: "seed" | "slice" | "repair" | "fast_fullstack_scaffold"
  data?: Record<string, unknown>
}) {
  const allFilesBytes = totalFileBytes(input.allFiles)
  const changedPaths = (input.changedFiles || []).map((file) => normalizePath(file.path)).slice(0, 120)

  await GenerationJobService.appendEvent({
    jobId: input.jobId,
    type: "job.files.updated",
    stage: input.stage,
    status: "running",
    message: input.message,
    data: {
      source: input.source,
      fileCount: input.allFiles.length,
      deletedPaths: input.deletedPaths || [],
      totalBytes: allFilesBytes,
      changedPaths,
      paths: input.allFiles.map((file) => normalizePath(file.path)).slice(0, 120),
      ...(input.data || {}),
    },
  })
}

async function runProviderAttempt(input: {
  jobId: string
  prompt: string
  purpose: "generate" | "repair"
  selectedModel: string
  promptLanguage: "id" | "en"
  signal?: AbortSignal
}) {
  const routed = routeModelForRequest({
    prompt: input.prompt,
    purpose: input.purpose,
  })
  const selectedTier = input.purpose === "generate" ? getSwiftTierConfig(input.selectedModel) : null
  const route = selectedTier
    ? {
        ...routed,
        modelName: selectedTier.key,
        layer: selectedTier.generationLayer,
        reason: `selected_generation_tier:${selectedTier.key}`,
      }
    : routed
  const startedAt = performance.now()
  log("info", "generation_provider_attempt_started", {
    jobId: input.jobId,
    purpose: input.purpose,
    selectedModel: input.selectedModel,
    routedModel: route.modelName,
    layer: route.layer,
    classification: route.classification,
    reason: route.reason,
  })
  const attempt = await GenerationJobService.startAttempt({
    jobId: input.jobId,
    provider: route.provider,
    model: route.modelName,
    purpose: input.purpose,
    metadata: {
      layer: route.layer,
      classification: route.classification,
      complexity: route.complexity,
      reason: route.reason,
      selectedModel: input.selectedModel,
    },
  })

  try {
    const response = await ProviderRouter.generate({
      provider: route.provider,
      modelName: route.modelName,
      prompt: input.prompt,
      mode: "files",
      promptLanguage: input.promptLanguage,
      signal: input.signal,
    })
    log("info", "ai_response_received", {
      jobId: input.jobId,
      purpose: input.purpose,
      provider: route.provider,
      model: route.modelName,
      latencyMs: Math.round(performance.now() - startedAt),
      attempts: response.attempts.length,
      tokenUsage: response.tokenUsage || null,
    })

    await GenerationJobService.finishAttempt({
      jobId: input.jobId,
      sequence: attempt.sequence,
      status: "completed",
      latencyMs: performance.now() - startedAt,
      promptTokens: response.tokenUsage?.promptTokens,
      completionTokens: response.tokenUsage?.completionTokens,
      totalTokens: response.tokenUsage?.totalTokens,
      metadata: {
        providerAttempts: response.attempts,
      },
    })

    return response
  } catch (error) {
    await GenerationJobService.finishAttempt({
      jobId: input.jobId,
      sequence: attempt.sequence,
      status: error instanceof GenerationJobCancelledError ? "cancelled" : "failed",
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function buildSlicePrompt(input: {
  prompt: string
  plan: GenerationPlan
  blueprint: ControlledAppBlueprint
  existingFiles: GeneratedFile[]
  target: GenerationPlannerFile
  targets?: GenerationPlannerFile[]
}) {
  const context = buildContextForTask({
    prompt: input.prompt,
    files: input.existingFiles,
    maxFiles: 10,
    layer: "builder",
  })
  const targets = input.targets && input.targets.length > 0 ? input.targets : [input.target]
  const targetPaths = targets.map((target) => target.path)
  const batchedFoundation = targets.length > 1
  const productionFullStack = input.plan.productionMode === "production_fullstack"

  return [
    context,
    "",
    buildIntentInstructionBlock(input.plan.intent),
    "",
    buildDynamicSeedDirective(input.prompt),
    "",
    buildBlueprintInstructionBlock(input.blueprint),
    "",
    buildPartialEditInstructionBlock(input.plan.editPlan),
    "",
    "EXECUTION_RULES:",
    productionFullStack
      ? "- PRODUCTION_FULLSTACK_MODE: generate a deployable full-stack slice with visible UI, route handlers, Prisma/data layer, env example, and package config as requested. Do not downgrade to dummy-only preview."
      : "- PREVIEW_MODE: generate a small preview-first foundation that can render quickly.",
    batchedFoundation
      ? `- BATCHED_SLICE: create or modify ONLY these ${targets.length} files in this provider call: ${targetPaths.join(", ")}.`
      : "- Work only on the requested file slice and directly related imports.",
    productionFullStack
      ? `- Production pass budget: this job may create up to ${input.plan.maxFilesThisPass} files across batched slices.`
      : `- Preview-first budget: the full generation plan is capped at ${PREVIEW_FOUNDATION_FILE_LIMIT} files for the first pass.`,
    productionFullStack && batchedFoundation
      ? `- For this provider call, return exactly ${targets.length} create/modify operations, one per listed target file. Do not skip API, Prisma, service, hook, or page targets.`
      : batchedFoundation
        ? `- For this provider call, return at most ${targets.length} create/modify operations, one per listed target file.`
        : productionFullStack
          ? "- For this provider call, return the requested file and any direct imports required to keep this production slice buildable."
          : "- For this provider call, return exactly one create/modify operation for Current file objective unless a direct import fix is required.",
    productionFullStack
      ? "- Use the existing locked stack. You MAY use Prisma schema, server-only service files, Route Handlers, NextAuth-compatible placeholders, and payment/API integration placeholders when the prompt asks for them."
      : "- Never install or introduce new libraries in the first preview pass; use the existing Tailwind and shadcn/ui-compatible stack.",
    productionFullStack
      ? "- Do not use UI-only dummy output. If real external credentials are not available, create server-side integration boundaries, env placeholders, zod validation, and clear TODO-safe service functions instead of fake-only UI."
      : "- Use in-file dummy arrays for first-pass data. Do not connect Prisma, Turso, Neon, or any database unless this prompt explicitly targets that phase.",
    productionFullStack
      ? "- MOCK_DATA_FORBIDDEN_IN_UI: do not create const dummy*, mock*, fake*, or sample* arrays in app pages/components. Pages must call local service/API boundaries or render empty/loading/error states backed by typed service contracts."
      : "- Preview mock data is allowed only inside the generated preview file.",
    productionFullStack && input.plan.appType === "clinic_management"
      ? "- CLINIC_FULLSTACK_REQUIRED: include dashboard, patients, doctors, appointments, auth/roles, Prisma schema, clinic service, BPJS integration service/route, and a hook or component boundary as planned."
      : "- Follow the controlled app blueprint exactly.",
    "- Keep each returned file under 4000 output tokens when possible.",
    "- Stop after the requested slice; do not create extra support files speculatively.",
    "- Return ONLY a JSON object with taskGraph; include changed files as taskGraph.operations.",
    '- taskGraph schema: {"taskGraph":{"intent":"...","summary":"...","dependencies":["lucide-react"],"operations":[{"action":"create|modify|delete","path":"app/page.tsx","language":"tsx","content":"full file content","reason":"..."}]}}',
    "- For delete operations, omit content. For create/modify operations, content must be the full file content.",
    "- TSX_PARSE_LOCK: every returned .tsx/.ts/.jsx/.js file must parse with @babel/parser using jsx + typescript plugins.",
    "- Do not use raw emoji or decorative non-ASCII symbols in TSX code. Use plain text labels or imported icons only.",
    "- Never split quoted strings across physical lines. Put long copy in JSX text nodes, arrays of short strings, or properly closed template literals.",
    "- Keep generated code ASCII-safe unless the user explicitly asks for local script characters.",
    "- Prefer task graph operations over raw files.",
    "- Prefer patch-safe, deterministic updates.",
    "- Preserve stable files unless this slice requires a focused update.",
    "- Keep the app deployable after this slice: no unresolved imports, no forbidden stack drift.",
    `- Current file objective: ${input.target.path}`,
    `- Why this file matters: ${input.target.reason}`,
    `- Allowed target files for this provider call: ${targetPaths.join(", ")}`,
    `- Planned objective: ${input.plan.objective}`,
    `- Controlled app type: ${input.plan.appType}`,
  ].join("\n")
}

function pickFailingFiles(files: GeneratedFile[], dependencyMap: DependencyMap, compileError: string) {
  const failing = new Set<string>()

  for (const item of dependencyMap.missingLocalImports.slice(0, 6)) {
    failing.add(item.file)
    if (item.candidates[0]) {
      failing.add(item.candidates[0])
    }
  }

  for (const filePath of extractFilePathsFromError(compileError)) {
    failing.add(filePath)
  }

  const matchedFiles = files.filter((file) => failing.has(normalizePath(file.path))).slice(0, 8)
  if (matchedFiles.length > 0) {
    return matchedFiles
  }

  return files
    .filter((file) =>
      /^app\/(?:.+\/)?page\.(tsx|ts|jsx|js)$/i.test(normalizePath(file.path)) ||
      /^components\//i.test(normalizePath(file.path)) ||
      normalizePath(file.path) === "package.json"
    )
    .slice(0, 8)
}

function extractRequestedFilePaths(prompt: string) {
  const paths = new Set<string>()
  const pattern = /(?:^|[\s:`"'(])([A-Za-z0-9_./[\]()-]+\.(?:tsx?|jsx?|json|css|prisma|md|env))(?:\b|$)/gim

  for (const match of String(prompt || "").matchAll(pattern)) {
    if (match[1]) {
      paths.add(normalizePath(match[1]))
    }
  }

  return Array.from(paths)
}

function extractFilePathsFromError(message: string) {
  const paths = new Set<string>()
  const patterns = [
    /in\s+([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|prisma))/gi,
    /(?:^|\s|\.\/)([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|prisma))(?::\d+:\d+)?/gim,
  ]

  for (const pattern of patterns) {
    for (const match of String(message || "").matchAll(pattern)) {
      if (match[1]) {
        paths.add(normalizePath(match[1]))
      }
    }
  }

  return Array.from(paths)
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function buildAppPlan(input: { prompt: string; plan: GenerationPlan }) {
  const text = input.prompt.toLowerCase()
  const rolePatterns: Array<[string, RegExp]> = [
    ["admin", /\b(admin)\b/i],
    ["dokter", /\b(dokter|doctor)\b/i],
    ["pengelola", /\b(pengelola|staff)\b/i],
    ["user", /\b(user|pasien|patient)\b/i],
  ]
  const roles = rolePatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([role]) => role)
  const integrationPatterns: Array<[string, RegExp]> = [
    ["bpjs", /\bbpjs\b/i],
  ]
  const integrations = integrationPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([integration]) => integration)

  return {
    appType: input.plan.appType,
    objective: input.plan.objective,
    productionMode: input.plan.productionMode,
    database: input.plan.productionMode === "production_fullstack",
    authentication: /\b(auth|login|register|role|rbac|admin|user|pengelola|dokter|pasien|patient)\b/i.test(text),
    api: input.plan.productionMode === "production_fullstack",
    roles: Array.from(new Set(roles)),
    integrations: Array.from(new Set(integrations)),
    fileCount: input.plan.filePlan.length,
    generatedFiles: input.plan.filePlan.map((file) => file.path),
  }
}

function summarizeGeneratedManifest(files: GeneratedFile[]) {
  return files.map((file) => normalizePath(file.path)).sort()
}

function mergeFilesByPath(currentFiles: GeneratedFile[], nextFiles: GeneratedFile[]) {
  const byPath = new Map<string, GeneratedFile>()
  for (const file of currentFiles) {
    byPath.set(normalizePath(file.path), { ...file, path: normalizePath(file.path) })
  }
  for (const file of nextFiles) {
    byPath.set(normalizePath(file.path), { ...file, path: normalizePath(file.path) })
  }
  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path))
}

function filterGeneratedFilesToTargets(files: GeneratedFile[], targetPaths: string[]) {
  const allowed = new Set(targetPaths.map(normalizePath))
  const acceptedFiles: GeneratedFile[] = []
  const rejectedFiles: GeneratedFile[] = []
  for (const file of files) {
    const normalized = normalizePath(file.path)
    if (allowed.has(normalized)) {
      acceptedFiles.push({ ...file, path: normalized })
    } else {
      rejectedFiles.push({ ...file, path: normalized })
    }
  }
  return { acceptedFiles, rejectedFiles }
}

function scopeGeneratedArtifactToTargets(
  artifact: ReturnType<typeof parseGeneratedArtifact>,
  targetPaths: string[]
): ReturnType<typeof parseGeneratedArtifact> {
  const allowed = new Set(targetPaths.map(normalizePath))
  const files = artifact.files
    .filter((file) => allowed.has(normalizePath(file.path)))
    .map((file) => ({ ...file, path: normalizePath(file.path) }))

  if (!artifact.taskGraph) {
    return {
      ...artifact,
      files,
    }
  }

  const operations = artifact.taskGraph.operations
    .filter((operation) => allowed.has(normalizePath(operation.path)))
    .map((operation) => ({ ...operation, path: normalizePath(operation.path) }))

  if (operations.length === 0) {
    throw new Error("MALFORMED_GENERATED_ARTIFACT:taskGraph:no operations matched requested slice")
  }

  return {
    ...artifact,
    files,
    taskGraph: {
      ...artifact.taskGraph,
      operations,
    },
  }
}

function findProductionMockArtifacts(files: GeneratedFile[]) {
  const bannedMockPattern = /\b(?:const|let|var)\s+[A-Za-z0-9_]*(?:dummy|mock|sample|placeholder|fake)[A-Za-z0-9_]*\s*=/i
  const suspiciousRecordPattern =
    /(?:id\s*:\s*["']?1["']?[\s\S]{0,240}(?:name|nama)\s*:)|(?:(?:name|nama)\s*:[\s\S]{0,240}id\s*:\s*["']?1["']?)/i

  return files
    .map((file) => ({
      path: normalizePath(file.path),
      content: String(file.content || ""),
    }))
    .filter((file) => /^(app\/(?:.+\/)?page\.(tsx|jsx|ts|js)|components\/.+\.(tsx|jsx|ts|js))$/i.test(file.path))
    .filter((file) => bannedMockPattern.test(file.content) || suspiciousRecordPattern.test(file.content))
    .map((file) => file.path)
    .slice(0, 12)
}

function parsePackageJsonFile(files: GeneratedFile[]) {
  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  if (!packageFile) {
    return {
      exists: false,
      dependencies: {} as Record<string, string>,
      devDependencies: {} as Record<string, string>,
      parseError: null as string | null,
    }
  }

  try {
    const parsed = JSON.parse(String(packageFile.content || "{}")) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return {
      exists: true,
      dependencies: normalizePackageRecord(parsed.dependencies),
      devDependencies: normalizePackageRecord(parsed.devDependencies),
      parseError: null,
    }
  } catch (error) {
    return {
      exists: true,
      dependencies: {} as Record<string, string>,
      devDependencies: {} as Record<string, string>,
      parseError: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizePackageRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, version]) => name.trim() && typeof version === "string" && version.trim())
      .map(([name, version]) => [name.trim(), String(version).trim()])
  )
}

function assertDependenciesForBlueprint(files: GeneratedFile[], blueprint: ControlledAppBlueprint) {
  const packageJson = parsePackageJsonFile(files)
  const paths = new Set(files.map((file) => normalizePath(file.path)))
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  const required = new Set<string>(["next", "react", "react-dom", "typescript"])

  if (paths.has("prisma/schema.prisma") || blueprint.requiredFiles.some((file) => normalizePath(file) === "prisma/schema.prisma")) {
    required.add("@prisma/client")
    required.add("prisma")
  }

  if (
    paths.has("app/api/auth/route.ts") ||
    blueprint.requiredFiles.some((file) => normalizePath(file) === "app/api/auth/route.ts")
  ) {
    required.add("next-auth")
  }

  if (Array.from(paths).some((path) => path.startsWith("app/api/")) || blueprint.requiredFiles.some((file) => normalizePath(file).startsWith("app/api/"))) {
    required.add("zod")
  }

  const missing = Array.from(required).filter((name) => !allDeps[name]).sort()
  return {
    ok: packageJson.exists && !packageJson.parseError && missing.length === 0,
    missing,
    parseError: packageJson.parseError,
    required: Array.from(required).sort(),
  }
}

function shouldRequireFullStackCoverage(plan: GenerationPlan) {
  return ["fullstack_app", "architecture", "refactor", "runtime_debug"].includes(plan.objective)
}

function summarizeSandboxStep(step: SandboxValidationStep): ValidationLifecycleStepResult | null {
  if (step.name === "install" || step.name === "prisma-generate") {
    return {
      name: "dependency-install",
      status: step.status,
      policy: step.policy,
      durationMs: step.durationMs || 0,
      message: step.reason,
      data: {
        command: step.command || null,
        output: step.output || null,
      },
    }
  }

  if (step.name !== "typecheck" && step.name !== "lint" && step.name !== "build") {
    return null
  }

  return {
    name: step.name,
    status: step.status,
    policy: step.policy,
    durationMs: step.durationMs || 0,
    message: step.reason,
    data: {
      command: step.command || null,
      output: step.output || null,
    },
  }
}

function failureStepFromSandbox(validation: SandboxValidationStep[]): ValidationLifecycleStep {
  const failed = validation.find((step) => step.status === "failed" && step.policy === "required")
  if (failed?.name === "install" || failed?.name === "prisma-generate") {
    return "dependency-install"
  }
  if (failed?.name === "typecheck" || failed?.name === "lint" || failed?.name === "build") {
    return failed.name
  }

  return "runtime-smoke"
}

async function runValidationLifecycle(input: {
  jobId: string
  projectId: string
  prompt: string
  files: GeneratedFile[]
  plan: GenerationPlan
  blueprint: ControlledAppBlueprint
  signal?: AbortSignal
  emit: (stage: GenerationJobStage, label: string, progress: number, data?: Record<string, unknown>) => Promise<void>
}): Promise<ValidationLifecycleResult> {
  let files = [...input.files]
  const steps: ValidationLifecycleStepResult[] = []
  const recordStep = (
    name: ValidationLifecycleStep,
    status: ValidationLifecycleStepResult["status"],
    policy: ValidationLifecycleStepResult["policy"],
    stepStartedAt: number,
    message?: string,
    data?: Record<string, unknown>
  ) => {
    steps.push({
      name,
      status,
      policy,
      durationMs: Math.max(0, Math.round(performance.now() - stepStartedAt)),
      message,
      data,
    })
  }

  await GenerationJobService.assertNotCancelled(input.jobId)
  let stepStartedAt = performance.now()
  await input.emit("validating", "Normalizing generated artifacts", 60)
  const normalized = normalizeGeneratedDependencies(files)
  files = normalized.files
  recordStep("normalize", "passed", "required", stepStartedAt, undefined, {
    fileCount: files.length,
    addedPackages: normalized.addedPackages,
    normalizedPackages: normalized.normalizedPackages,
    conflictsPrevented: normalized.conflictsPrevented,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("validating", "Checking static project invariants", 66)
  const fullstack = validateFullStackFiles(files)
  const dependencyMap = buildDependencyMap(files)
  const plannedRequiredFiles = input.plan.filePlan.map((file) => normalizePath(file.path))
  const productionRequiredFilesForValidation =
    input.plan.productionMode === "production_fullstack"
      ? plannedRequiredFiles
      : input.blueprint.requiredFiles
  const isPreviewFoundationPass =
    input.plan.productionMode !== "production_fullstack" &&
    input.plan.editPlan.mode === "full" &&
    plannedRequiredFiles.length <= PREVIEW_FOUNDATION_FILE_LIMIT
  const partialRequiredFiles =
    isPreviewFoundationPass
      ? plannedRequiredFiles
      : input.plan.editPlan.mode === "partial"
      ? input.blueprint.requiredFiles.filter((filePath) => {
          const normalized = normalizePath(filePath)
          return (
            normalized === "app/layout.tsx" ||
            normalized === "app/page.tsx" ||
            normalized === "package.json" ||
            normalized === "prisma/schema.prisma" ||
            input.plan.editPlan.targetPaths.includes(normalized) ||
            input.plan.editPlan.allowedNewPaths.includes(normalized)
          )
        })
      : productionRequiredFilesForValidation
  const blueprintValidation = validateBlueprintConstraints(files, input.blueprint, {
    requiredFiles: partialRequiredFiles,
  })
  const dependencyContract = input.plan.productionMode === "production_fullstack"
    ? assertDependenciesForBlueprint(files, input.blueprint)
    : { ok: true, missing: [] as string[], parseError: null as string | null, required: [] as string[] }
  const staticFailures: string[] = []
  const requiresFullStackCoverage = !isPreviewFoundationPass && shouldRequireFullStackCoverage(input.plan)

  if (dependencyMap.missingLocalImports.length > 0) {
    staticFailures.push(`Missing local imports: ${dependencyMap.missingLocalImports.length}`)
  }

  if (input.plan.productionMode !== "production_fullstack" && dependencyMap.unsupportedPreviewImports.length > 0) {
    staticFailures.push(`Unsupported preview imports: ${dependencyMap.unsupportedPreviewImports.length}`)
  }

  if (requiresFullStackCoverage && fullstack.missingCategories.length > 0) {
    staticFailures.push(`Missing required full-stack categories: ${fullstack.missingCategories.join(", ")}`)
  }

  const mockArtifacts = input.plan.productionMode === "production_fullstack"
    ? findProductionMockArtifacts(files)
    : []
  if (mockArtifacts.length > 0) {
    staticFailures.push(`Production full-stack files contain UI-level mock data: ${mockArtifacts.join(", ")}`)
  }

  if (!blueprintValidation.ok) {
    if (blueprintValidation.missingRequiredFiles.length > 0) {
      staticFailures.push(`Missing blueprint files: ${blueprintValidation.missingRequiredFiles.join(", ")}`)
    }
    if (blueprintValidation.forbiddenFiles.length > 0) {
      staticFailures.push(`Forbidden stack drift files: ${blueprintValidation.forbiddenFiles.join(", ")}`)
    }
  }

  if (!dependencyContract.ok) {
    if (dependencyContract.parseError) {
      staticFailures.push(`package.json parse error: ${dependencyContract.parseError}`)
    }
    if (dependencyContract.missing.length > 0) {
      staticFailures.push(`Missing blueprint dependencies: ${dependencyContract.missing.join(", ")}`)
    }
  }

  if (staticFailures.length > 0) {
    const message = staticFailures.join("; ")
    const data = {
      appType: input.plan.appType,
      coverage: fullstack.coverage,
      missingCategories: fullstack.missingCategories,
      fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
      blueprint: {
        missingRequiredFiles: blueprintValidation.missingRequiredFiles,
        forbiddenFiles: blueprintValidation.forbiddenFiles,
      },
      dependencies: dependencyContract,
      mockArtifacts,
      missingLocalImports: dependencyMap.missingLocalImports.slice(0, 12),
      unsupportedPreviewImports: dependencyMap.unsupportedPreviewImports.slice(0, 12),
    }
    recordStep("static", "failed", "required", stepStartedAt, message, data)
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: null,
      steps,
      sandboxValidation: [],
      failure: {
        step: "static",
        message,
        data,
      },
    }
  }

  recordStep("static", "passed", "required", stepStartedAt, undefined, {
    appType: input.plan.appType,
    coverage: fullstack.coverage,
    missingCategories: fullstack.missingCategories,
    fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
    blueprintRequiredFiles: input.blueprint.requiredFiles.length,
    requiredFilesMissing: blueprintValidation.missingRequiredFiles,
    dependencies: dependencyContract,
    mockArtifacts,
    localImportCount: dependencyMap.localImports.length,
    externalPackages: dependencyMap.externalPackages,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  if (input.plan.productionMode === "production_fullstack") {
    await input.emit("validating", "Skipping browser-only preview compile for full-stack runtime build", 74)
    recordStep(
      "preview-compile",
      "skipped",
      "advisory",
      stepStartedAt,
      "Production full-stack apps are validated by sandbox install, build, and runtime smoke gates.",
      {
        unsupportedPreviewImports: dependencyMap.unsupportedPreviewImports.slice(0, 12),
      }
    )
  } else {
    await input.emit("validating", "Compiling preview module graph", 74)
    try {
      compileProject(files)
      recordStep("preview-compile", "passed", "required", stepStartedAt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      recordStep("preview-compile", "failed", "required", stepStartedAt, message)
      return {
        ok: false,
        files,
        previewUrl: null,
        previewStatus: null,
        steps,
        sandboxValidation: [],
        failure: {
          step: "preview-compile",
          message,
        },
      }
    }
  }

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  if (canUseRemoteSandboxService()) {
    await input.emit("building", "Validating project in configured sandbox service", 84)
    const preview = await startConfiguredSandboxService({
      projectId: input.projectId,
      files,
      signal: input.signal,
    })
    const logs = Array.isArray(preview.logs) ? preview.logs : []
    if (preview.error || preview.status !== "running") {
      const message = preview.error || `Sandbox service did not reach running state (${preview.status || "unknown"})`
      if (isProductionVercel() && input.plan.productionMode !== "production_fullstack") {
        recordStep("build", "skipped", "advisory", stepStartedAt, message, {
          sandboxStatus: preview.status || null,
          logs: logs.slice(-80),
        })
        recordStep(
          "runtime-smoke",
          "skipped",
          "advisory",
          stepStartedAt,
          "Sandbox service unavailable; browser iframe preview will validate client-side after persistence.",
          {
            sandboxStatus: preview.status || null,
            logs: logs.slice(-80),
          }
        )
        return {
          ok: true,
          files,
          previewUrl: null,
          previewStatus: "browser-preview-only",
          steps,
          sandboxValidation: [],
        }
      }

      recordStep("runtime-smoke", "failed", "required", stepStartedAt, message, {
        sandboxStatus: preview.status || null,
        logs: logs.slice(-80),
      })
      return {
        ok: false,
        files,
        previewUrl: preview.previewUrl || null,
        previewStatus: preview.status || null,
        steps,
        sandboxValidation: [],
        failure: {
          step: "runtime-smoke",
          message,
          data: {
            sandboxStatus: preview.status || null,
            logs: logs.slice(-80),
          },
        },
      }
    }

    recordStep("build", "passed", "required", stepStartedAt, "Sandbox service accepted and built the project.", {
      sandboxStatus: preview.status,
      logs: logs.slice(-20),
    })
    recordStep("runtime-smoke", "passed", "required", stepStartedAt, undefined, {
      sandboxStatus: preview.status,
      previewUrl: preview.previewUrl || null,
    })

    return {
      ok: true,
      files,
      previewUrl: preview.previewUrl || null,
      previewStatus: preview.status || null,
      steps,
      sandboxValidation: [],
    }
  }

  if (isProductionVercel() && input.plan.productionMode === "production_fullstack") {
    const message = "Production full-stack generation requires SANDBOX_SERVICE_URL so generated artifacts can pass install, build, and runtime smoke before persistence."
    await input.emit("building", "Runtime sandbox required for production full-stack artifacts", 84)
    recordStep("build", "failed", "required", stepStartedAt, message)
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: null,
      steps,
      sandboxValidation: [],
      failure: {
        step: "build",
        message,
      },
    }
  }

  if (isProductionVercel()) {
    await input.emit("building", "Runtime sandbox unavailable; saving browser-previewable files", 84)
    recordStep(
      "build",
      "skipped",
      "advisory",
      stepStartedAt,
      "Skipped in Vercel production because SANDBOX_SERVICE_URL is not configured."
    )
    recordStep(
      "runtime-smoke",
      "skipped",
      "advisory",
      stepStartedAt,
      "Browser iframe preview will validate client-side after persistence."
    )

    return {
      ok: true,
      files,
      previewUrl: null,
      previewStatus: "browser-preview-only",
      steps,
      sandboxValidation: [],
    }
  }

  await input.emit("building", "Running typecheck, lint, and production build", 84)
  const preview = await startRuntimeSandbox(input.projectId, files, { signal: input.signal })
  for (const sandboxStep of preview.validation) {
    const lifecycleStep = summarizeSandboxStep(sandboxStep)
    if (lifecycleStep) {
      steps.push(lifecycleStep)
    }
  }

  if (preview.error) {
    const step = failureStepFromSandbox(preview.validation)
    const runtimeFailed =
      preview.runtimeVerification && !preview.runtimeVerification.ok
          ? {
            category: preview.runtimeVerification.failureCategory || "unknown",
            error: preview.runtimeVerification.error || null,
          }
        : null
    if (step === "runtime-smoke") {
      recordStep("runtime-smoke", "failed", "required", stepStartedAt, preview.error, {
        sandboxStatus: preview.status,
        runtimeVerification: runtimeFailed,
        logs: preview.logs.slice(-80),
      })
    } else {
      recordStep(step, "failed", "required", stepStartedAt, preview.error, {
        sandboxStatus: preview.status,
        sandboxValidation: preview.validation,
        runtimeVerification: runtimeFailed,
        logs: preview.logs.slice(-80),
      })
    }
    return {
      ok: false,
      files,
      previewUrl: preview.previewUrl,
      previewStatus: preview.status,
      steps,
      sandboxValidation: preview.validation,
      failure: {
        step,
        message: preview.error,
        data: {
          sandboxStatus: preview.status,
          sandboxValidation: preview.validation,
          logs: preview.logs.slice(-80),
        },
      },
    }
  }

  if (!preview.validation.some((step) => step.name === "build" && step.status === "passed")) {
    const message = "Production build did not report a passing build gate."
    recordStep("build", "failed", "required", stepStartedAt, message, {
      sandboxStatus: preview.status,
      sandboxValidation: preview.validation,
    })
    return {
      ok: false,
      files,
      previewUrl: preview.previewUrl,
      previewStatus: preview.status,
      steps,
      sandboxValidation: preview.validation,
      failure: {
        step: "build",
        message,
      },
    }
  }

  recordStep("runtime-smoke", "passed", "required", stepStartedAt, undefined, {
    sandboxStatus: preview.status,
    runtimeVerification: preview.runtimeVerification,
  })

  return {
    ok: true,
    files,
    previewUrl: preview.previewUrl,
    previewStatus: preview.status,
    steps,
    sandboxValidation: preview.validation,
  }
}

async function attemptTargetedRepair(input: {
  jobId: string
  prompt: string
  files: GeneratedFile[]
  blueprint: ControlledAppBlueprint
  editPlan: PartialEditPlan
  validationError: string
  repairAttempt: number
  maxRepairAttempts: number
  promptLanguage: "id" | "en"
  signal?: AbortSignal
}) {
  await GenerationJobService.assertNotCancelled(input.jobId)
  const currentFiles = [...input.files]
  const dependencyMap = buildDependencyMap(currentFiles)
  const failingFiles = pickFailingFiles(currentFiles, dependencyMap, input.validationError)
  const repairPrompt = [
    buildStaticValidationPrompt({
      prompt: input.prompt,
      dependencyMap,
      packageJson: currentFiles.find((file) => normalizePath(file.path) === "package.json") || null,
      previewError: input.validationError,
    }),
    "",
    buildBlueprintInstructionBlock(input.blueprint),
    "",
    buildPartialEditInstructionBlock(input.editPlan),
    "",
    "DETERMINISTIC_VALIDATION_FAILURE:",
    input.validationError,
    "",
    "TARGETED_REPAIR_ONLY:",
    "- Repair only the failing files or their direct imports.",
    "- Do not regenerate the entire project.",
    "- Return only changed files.",
    "- The repaired file must be syntactically valid TSX/TypeScript. No raw emoji, no unterminated strings, no split quoted strings.",
    "- If a fancy design is causing syntax risk, replace it with a minimal compile-safe version of the failing file.",
    "- The result will be revalidated through normalize -> static validation -> preview compile -> typecheck -> lint -> build before persistence.",
    `- Repair attempt: ${input.repairAttempt} / ${input.maxRepairAttempts}`,
    "",
    "FAILING_FILES_CONTEXT:",
    failingFiles.map((file) => `FILE ${file.path}\n${file.content}`).join("\n\n"),
  ].join("\n")

  const response = await runProviderAttempt({
    jobId: input.jobId,
    prompt: repairPrompt,
    purpose: "repair",
    selectedModel: "repair",
    promptLanguage: input.promptLanguage,
    signal: input.signal,
  })
  const parsed = parseGeneratedArtifact(response.message)
  const scoped = parsed.taskGraph
    ? { acceptedFiles: parsed.files, rejectedFiles: [] as GeneratedFile[] }
    : filterFilesForPartialEdit(parsed.files, input.editPlan)
  const executed = executeGeneratedTaskGraph(currentFiles, parsed.taskGraph, scoped.acceptedFiles, parsed.dependencies)
  const mergedFiles = executed.files
  const normalized = normalizeGeneratedDependencies(mergedFiles)

  return {
    files: normalized.files,
    repaired: scoped.acceptedFiles.length > 0,
    parsedFileCount: parsed.files.length,
    acceptedFileCount: scoped.acceptedFiles.length,
    rejectedFiles: scoped.rejectedFiles.map((file) => file.path).slice(0, 8),
    deletedPaths: executed.deletedPaths,
    installedDependencies: executed.installedDependencies,
    normalizedPackages: normalized.normalizedPackages,
    addedPackages: normalized.addedPackages,
  }
}

function shouldApplySafePreviewFallback(plan: GenerationPlan, validation: ValidationLifecycleResult) {
  const isPreviewFoundationPass =
    plan.productionMode !== "production_fullstack" &&
    plan.editPlan.mode === "full" &&
    plan.filePlan.length > 0 &&
    plan.filePlan.length <= PREVIEW_FOUNDATION_FILE_LIMIT
  if (!isPreviewFoundationPass) return false

  const failureMessage = validation.failure?.message || ""
  return validation.failure?.step === "preview-compile" || /unterminated|unexpected character|parse/i.test(failureMessage)
}

function buildSafePreviewFallbackFiles(input: {
  prompt: string
  appType: ControlledAppType
}): GeneratedFile[] {
  const lowerPrompt = input.prompt.toLowerCase()
  const isMarketplace =
    input.appType === "simple_marketplace" ||
    /\b(jual|beli|toko|dagang|market|produk|ecommerce|commerce)\b/i.test(lowerPrompt)
  const isNews = /\b(berita|portal|majalah|artikel|desa)\b/i.test(lowerPrompt)

  if (isMarketplace) {
    return [
      {
        path: "app/layout.tsx",
        language: "tsx",
        content: `import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "JBB Marketplace",
  description: "Preview marketplace lokal berbasis data dummy",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  )
}
`,
      },
      {
        path: "app/page.tsx",
        language: "tsx",
        content: `const products = [
  { name: "Kurung Manuk Bambu", area: "Majalengka Kota", price: "Rp 85.000", status: "Ready" },
  { name: "Kurung Manuk Besi", area: "Kadipaten", price: "Rp 140.000", status: "Favorit" },
  { name: "Pakan Harian", area: "Jatiwangi", price: "Rp 18.000", status: "Stok aman" },
  { name: "Aksesoris Tangkringan", area: "Leuwimunding", price: "Rp 25.000", status: "Baru" },
]

const stats = [
  { label: "Produk aktif", value: "48" },
  { label: "Penjual lokal", value: "12" },
  { label: "Area layanan", value: "Majalengka" },
]

export default function Page() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <p className="text-sm font-medium text-rose-600">JBB Majalengka</p>
            <h1 className="text-2xl font-bold">Jual beli kurung manuk lokal</h1>
          </div>
          <a className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white" href="#produk">
            Lihat produk
          </a>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Preview cepat</p>
          <h2 className="mt-3 text-4xl font-bold leading-tight">Pasar sederhana untuk kurung manuk dan kebutuhan hobi.</h2>
          <p className="mt-4 max-w-2xl text-slate-600">
            Semua data masih dummy agar preview tampil cepat. Tahap berikutnya bisa menambahkan database, login penjual,
            dan checkout.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {stats.map((item) => (
              <div key={item.label} className="rounded-md border bg-slate-50 p-4">
                <p className="text-2xl font-bold">{item.value}</p>
                <p className="text-sm text-slate-500">{item.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="font-semibold">Kategori populer</h3>
          <div className="mt-4 grid gap-3">
            {["Kurung bambu", "Kurung besi", "Pakan", "Aksesoris"].map((item) => (
              <div key={item} className="flex items-center justify-between rounded-md bg-slate-100 px-4 py-3">
                <span>{item}</span>
                <span className="text-sm text-slate-500">Dummy</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="produk" className="mx-auto max-w-6xl px-6 pb-10">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {products.map((product) => (
            <article key={product.name} className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="mb-4 flex h-28 items-center justify-center rounded-md bg-rose-50 text-sm font-semibold text-rose-700">
                Foto produk
              </div>
              <h3 className="font-semibold">{product.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{product.area}</p>
              <div className="mt-4 flex items-center justify-between">
                <span className="font-bold">{product.price}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{product.status}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
`,
      },
      {
        path: "app/globals.css",
        language: "css",
        content: `@import "tailwindcss";

:root {
  color-scheme: light;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f8fafc;
  font-family: Arial, Helvetica, sans-serif;
}
`,
      },
    ]
  }

  return [
    {
      path: "app/layout.tsx",
      language: "tsx",
      content: `import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Swift Preview",
  description: "Preview awal berbasis data dummy",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  )
}
`,
    },
    {
      path: "app/page.tsx",
      language: "tsx",
      content: `const cards = [
  { title: "${isNews ? "Artikel utama" : "Konten utama"}", body: "Data dummy untuk memastikan preview tampil cepat." },
  { title: "Kategori", body: "Susun bagian penting tanpa koneksi database dulu." },
  { title: "Tahap lanjut", body: "Integrasi backend dilakukan setelah tampilan dasar berhasil." },
]

export default function Page() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <section className="mx-auto max-w-5xl">
        <p className="text-sm font-semibold text-rose-600">Swift preview</p>
        <h1 className="mt-3 text-4xl font-bold">Preview awal siap ditampilkan</h1>
        <p className="mt-4 max-w-2xl text-slate-600">
          File ini dibuat sebagai fallback aman ketika output AI tidak lolos parser. Semua data masih dummy.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {cards.map((card) => (
            <article key={card.title} className="rounded-lg border bg-white p-5 shadow-sm">
              <h2 className="font-semibold">{card.title}</h2>
              <p className="mt-2 text-sm text-slate-600">{card.body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
`,
    },
    {
      path: "app/globals.css",
      language: "css",
      content: `@import "tailwindcss";

body {
  margin: 0;
  background: #f8fafc;
  font-family: Arial, Helvetica, sans-serif;
}
`,
    },
  ]
}

function mapLifecycleFailureToQualityStage(step?: ValidationLifecycleStep | null): GenerationQualityStage {
  if (!step) return "unknown"
  if (step === "static") return "static-validation"
  if (step === "dependency-install") return "dependency-planning"
  if (step === "preview-compile") return "preview-compile"
  if (step === "typecheck") return "typecheck"
  if (step === "lint") return "lint"
  if (step === "build") return "build"
  if (step === "runtime-smoke") return "runtime-smoke"
  if (step === "normalize") return "code-generation"
  return "unknown"
}

function sumStepDurations(steps: ValidationLifecycleStepResult[]) {
  return steps.reduce((sum, step) => sum + Math.max(0, step.durationMs || 0), 0)
}

async function recordGenerationQuality(input: {
  jobId: string
  projectId: string
  appType: ControlledAppType
  status: "completed" | "failed" | "cancelled"
  validation?: ValidationLifecycleResult | null
  repairAttempts: number
  providerLatencyMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  totalLatencyMs: number
  failureStage?: GenerationQualityStage | string | null
  failureCode?: string | null
  metadata?: Record<string, unknown> | null
}) {
  const job = await GenerationJobService.findById(input.jobId)
  if (!job) return

  const steps = input.validation?.steps || []
  const buildPassed = steps.some((step) => step.name === "build" && step.status === "passed")
  const runtimePassed = steps.some((step) => step.name === "runtime-smoke" && step.status === "passed")
  const validationLatencyMs = sumStepDurations(steps)

  await GenerationQualityService.recordSummary({
    jobId: input.jobId,
    userId: job.userId,
    projectId: input.projectId,
    appType: input.appType,
    status: input.status,
    failureStage:
      input.failureStage ||
      (input.validation?.failure ? mapLifecycleFailureToQualityStage(input.validation.failure.step) : null),
    failureCode: input.failureCode || input.validation?.failure?.message?.slice(0, 180) || null,
    buildPassed,
    runtimePassed,
    repairSucceeded: input.repairAttempts > 0 && input.status === "completed",
    deployValidated: false,
    repairAttempts: input.repairAttempts,
    providerLatencyMs: input.providerLatencyMs,
    validationLatencyMs,
    totalLatencyMs: input.totalLatencyMs,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens,
    metadata: {
      ...(input.metadata || {}),
      lifecycleSteps: steps.map((step) => ({
        name: step.name,
        status: step.status,
        policy: step.policy,
        durationMs: step.durationMs,
      })),
      previewStatus: input.validation?.previewStatus || null,
    },
  })
}

export async function executeGenerationJob(
  input: ExecuteGenerationJobInput,
  deps: ExecuteGenerationJobDeps
) {
  const promptLanguage = input.promptLanguage || "id"
  const jobStartedAt = performance.now()
  const metrics: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
  }
  let plan: GenerationPlan | null = null
  let blueprint: ControlledAppBlueprint | null = null
  let validation: ValidationLifecycleResult | null = null
  let repairAttempt = 0
  let providerLatencyMs = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0

  try {
    assertNotAborted(input.signal)
    await GenerationJobService.transition(input.jobId, {
      type: "job.stage.planning",
      status: "running",
      stage: "planning",
      label: "Planning app intent",
      progress: 5,
      startedAt: new Date(),
      message: "Planning app intent",
    })
    await GenerationJobService.assertNotCancelled(input.jobId)

    const existingFiles = await deps.loadProjectFiles(input.projectId)
    assertNotAborted(input.signal)
    plan = buildGenerationPlan({
      prompt: input.prompt,
      existingFiles,
      collaborationMode: input.collaborationMode,
      previewContext: input.previewContext,
    })
    blueprint = getControlledAppBlueprint(plan.appType)
    const appPlan = buildAppPlan({ prompt: input.prompt, plan })
    log("info", "app_plan", {
      jobId: input.jobId,
      projectId: input.projectId,
      appPlan,
    })
    log("info", "generation_manifest_planned", {
      jobId: input.jobId,
      projectId: input.projectId,
      classification: plan.productionMode,
      promptClassification: plan.objective,
      productionMode: plan.productionMode,
      fileCount: plan.filePlan.length,
      generatedFiles: plan.filePlan.map((file) => file.path),
    })
    await GenerationJobService.transition(input.jobId, {
      type: "job.plan.ready",
      status: "running",
      stage: "planning",
      label: "Architecture plan ready",
      progress: 10,
      plan,
      context: {
        fileCount: existingFiles.length,
      },
      message: "Architecture plan ready",
      data: {
        objective: plan.objective,
        appType: plan.appType,
        productionMode: plan.productionMode,
        maxFilesThisPass: plan.maxFilesThisPass,
        intent: plan.intent,
        blueprint: plan.blueprint,
        editPlan: {
          mode: plan.editPlan.mode,
          intent: plan.editPlan.intent,
          targetPaths: plan.editPlan.targetPaths,
          allowedNewPaths: plan.editPlan.allowedNewPaths,
        },
        filePlan: plan.filePlan,
        appPlan,
      },
    })

    let workingFiles = [...existingFiles]
    const fastScaffoldFiles = buildFastClinicFullStackScaffold({
      plan,
      prompt: input.prompt,
    })

    if (fastScaffoldFiles) {
      const previousWorkingFiles = workingFiles
      const scaffoldStartedAt = performance.now()
      workingFiles = mergeFilesByPath(workingFiles, fastScaffoldFiles)
      const normalized = normalizeGeneratedDependencies(workingFiles)
      workingFiles = normalized.files
      const scaffoldDurationMs = Math.round(performance.now() - scaffoldStartedAt)
      await transition(input.jobId, "parsing", "Generating compact full-stack clinic core", 55, {
        source: "fast_fullstack_scaffold",
        fileCount: workingFiles.length,
        changedPaths: fastScaffoldFiles.map((file) => file.path),
        addedPackages: normalized.addedPackages,
        durationMs: scaffoldDurationMs,
      })
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "parsing",
        message: "Compact full-stack clinic core ready in Explorer",
        allFiles: workingFiles,
        previousFiles: previousWorkingFiles,
        changedFiles: fastScaffoldFiles,
        deletedPaths: [],
        source: "fast_fullstack_scaffold",
        data: {
          durationMs: scaffoldDurationMs,
          fileCount: workingFiles.length,
          addedPackages: normalized.addedPackages,
        },
      })
      log("info", "generation_scaffold_completed", {
        jobId: input.jobId,
        projectId: input.projectId,
        source: "fast_fullstack_scaffold",
        fileCount: workingFiles.length,
        generatedFiles: summarizeGeneratedManifest(workingFiles),
      })
    } else {
      const usePreviewFoundationBatch =
        plan.productionMode !== "production_fullstack" &&
        plan.editPlan.mode === "full" &&
        plan.filePlan.length > 1 &&
        plan.filePlan.length <= PREVIEW_FOUNDATION_FILE_LIMIT
      const sliceBatchSize = plan.productionMode === "production_fullstack"
        ? PRODUCTION_FULLSTACK_BATCH_SIZE
        : usePreviewFoundationBatch
          ? plan.filePlan.length
          : 1

      for (
        let index = 0;
        index < plan.filePlan.length;
        index += sliceBatchSize
      ) {
      await GenerationJobService.assertNotCancelled(input.jobId)
      assertNotAborted(input.signal)
      const targets = plan.filePlan.slice(index, index + sliceBatchSize)
      const target = targets.length > 1
        ? {
            path: targets.map((item) => item.path).join(", "),
            reason:
              plan.productionMode === "production_fullstack"
                ? "Production full-stack batch keeps the job inside timeout while covering UI, API, data, and config"
                : "Preview-first foundation batch keeps the first render inside the timeout budget",
            action: "create_or_update" as const,
          }
        : plan.filePlan[index]
      const sliceIndex = Math.floor(index / sliceBatchSize) + 1
      const sliceTotal = Math.ceil(plan.filePlan.length / sliceBatchSize)
      const previousWorkingFiles = workingFiles
      const providerStartedAt = performance.now()
      const baseSlicePrompt = buildSlicePrompt({
          prompt: input.prompt,
          plan,
          blueprint,
          existingFiles: workingFiles,
          target,
          targets,
      })
      let response: Awaited<ReturnType<typeof runProviderAttempt>> | null = null
      let parsed: ReturnType<typeof parseGeneratedArtifact> | null = null
      let parseError: unknown = null

      for (let parseAttempt = 1; parseAttempt <= 2; parseAttempt += 1) {
        response = await runProviderAttempt({
          jobId: input.jobId,
          prompt: parseAttempt === 1
            ? baseSlicePrompt
            : [
                baseSlicePrompt,
                "",
                "RETRY_DUE_TO_MALFORMED_ARTIFACT:",
                "- Your previous response could not be parsed as a GeneratedArtifact.",
                "- Return ONLY valid JSON. No Markdown fences, no prose, no comments.",
                "- Include either {\"files\":[...]} or {\"taskGraph\":{\"operations\":[...]}}.",
                `- Cover exactly this slice target: ${target.path}.`,
              ].join("\n"),
          purpose: "generate",
          selectedModel: input.selectedModel,
          promptLanguage,
          signal: input.signal,
        })
        assertNotAborted(input.signal)
        try {
          parsed = parseGeneratedArtifact(response.message)
          parseError = null
          break
        } catch (error) {
          parseError = error
          if (!(error instanceof Error) || !error.message.startsWith("MALFORMED_GENERATED_ARTIFACT") || parseAttempt >= 2) {
            throw error
          }
          log("warn", "generation_slice_parse_retry", {
            jobId: input.jobId,
            projectId: input.projectId,
            sliceIndex,
            sliceTotal,
            target: target.path,
            error: error.message,
          })
          await transition(
            input.jobId,
            "parsing",
            `Retrying malformed file slice ${sliceIndex}/${sliceTotal}`,
            Math.min(55, 15 + Math.round((sliceIndex / Math.max(1, sliceTotal)) * 35)),
            {
              target: target.path,
              parseAttempt,
              error: error.message,
            }
          )
        }
      }
      if (!response || !parsed) {
        throw parseError instanceof Error ? parseError : new Error("MALFORMED_GENERATED_ARTIFACT")
      }
      assertNotAborted(input.signal)
      const sliceDurationMs = Math.round(performance.now() - providerStartedAt)
      providerLatencyMs += sliceDurationMs
      promptTokens += Math.max(0, response.tokenUsage?.promptTokens || 0)
      completionTokens += Math.max(0, response.tokenUsage?.completionTokens || 0)
      totalTokens += Math.max(0, response.tokenUsage?.totalTokens || 0)

      const scopedArtifact =
        plan.productionMode === "production_fullstack"
          ? scopeGeneratedArtifactToTargets(parsed, targets.map((item) => item.path))
          : parsed
      const scoped = scopedArtifact.taskGraph
        ? { acceptedFiles: scopedArtifact.files, rejectedFiles: [] as GeneratedFile[] }
        : plan.productionMode === "production_fullstack"
          ? filterGeneratedFilesToTargets(scopedArtifact.files, targets.map((item) => item.path))
          : filterFilesForPartialEdit(scopedArtifact.files, plan.editPlan)
      const executed = executeGeneratedTaskGraph(
        workingFiles,
        scopedArtifact.taskGraph,
        scoped.acceptedFiles,
        scopedArtifact.dependencies
      )
      workingFiles = executed.files
      const normalized = normalizeGeneratedDependencies(workingFiles)
      workingFiles = normalized.files
      const streamPaths = new Set([
        ...executed.changedFiles.map((file) => normalizePath(file.path)),
        ...(normalized.addedPackages.length > 0 || executed.installedDependencies.length > 0 ? ["package.json"] : []),
      ])
      const streamFiles = workingFiles.filter((file) => streamPaths.has(normalizePath(file.path)))

      await transition(
        input.jobId,
        "parsing",
        `Generating controlled file slice ${sliceIndex}/${sliceTotal}`,
        Math.min(55, 15 + Math.round((sliceIndex / Math.max(1, sliceTotal)) * 35)),
        {
          target: target.path,
          sliceDurationMs,
          parseFileCount: scopedArtifact.files.length,
          acceptedFileCount: scoped.acceptedFiles.length,
          rejectedFileCount: scoped.rejectedFiles.length,
          rejectedFiles: scoped.rejectedFiles.map((file) => file.path).slice(0, 8),
          taskOperationCount: scopedArtifact.taskGraph?.operations.length || 0,
          deletedPaths: executed.deletedPaths,
          installedDependencies: executed.installedDependencies,
          addedPackages: normalized.addedPackages,
        }
      )
      if (streamFiles.length > 0 || executed.deletedPaths.length > 0) {
        await emitGeneratedFilesUpdate({
          jobId: input.jobId,
          stage: "parsing",
          message: `File slice ${sliceIndex}/${sliceTotal} ready in Explorer`,
          allFiles: workingFiles,
          previousFiles: previousWorkingFiles,
          changedFiles: streamFiles,
          deletedPaths: executed.deletedPaths,
          source: "slice",
          data: {
            target: target.path,
            sliceIndex,
            sliceTotal,
            sliceDurationMs,
            acceptedFileCount: scoped.acceptedFiles.length,
            rejectedFileCount: scoped.rejectedFiles.length,
            taskOperationCount: scopedArtifact.taskGraph?.operations.length || 0,
            deletedPaths: executed.deletedPaths,
            installedDependencies: executed.installedDependencies,
            addedPackages: normalized.addedPackages,
          },
        })
      }

      log("info", "generation_slice_completed", {
        jobId: input.jobId,
        sliceIndex,
        sliceTotal,
        target: target.path,
        durationMs: sliceDurationMs,
      })
      }
    }

    await GenerationJobService.assertNotCancelled(input.jobId)
    assertNotAborted(input.signal)
    validation = await runValidationLifecycle({
      jobId: input.jobId,
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
      plan,
      blueprint,
      signal: input.signal,
      emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
    })

    while (!validation.ok && repairAttempt < MAX_REPAIR_ATTEMPTS) {
      repairAttempt += 1
      await GenerationJobService.assertNotCancelled(input.jobId)
      assertNotAborted(input.signal)
      await transition(
        input.jobId,
        "repairing",
        `Repairing validation failure ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}`,
        Math.min(88, 72 + repairAttempt * 5),
        {
          failure: validation.failure,
          steps: validation.steps,
        }
      )

      const repaired = await attemptTargetedRepair({
        jobId: input.jobId,
        prompt: input.prompt,
        files: validation.files,
        blueprint,
        editPlan: plan.editPlan,
        validationError: validation.failure?.message || "Validation lifecycle failed",
        repairAttempt,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
        promptLanguage,
        signal: input.signal,
      })

      assertNotAborted(input.signal)
      workingFiles = repaired.files
      const previousRepairFiles = validation.files
      await transition(
        input.jobId,
        "validating",
        `Revalidating repaired artifacts ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}`,
        Math.min(90, 76 + repairAttempt * 5),
        {
          repaired: repaired.repaired,
          parsedFileCount: repaired.parsedFileCount,
          acceptedFileCount: repaired.acceptedFileCount,
          rejectedFiles: repaired.rejectedFiles,
          deletedPaths: repaired.deletedPaths,
          installedDependencies: repaired.installedDependencies,
          addedPackages: repaired.addedPackages,
          normalizedPackages: repaired.normalizedPackages,
        }
      )
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "repairing",
        message: `Repaired files ${repairAttempt}/${MAX_REPAIR_ATTEMPTS} ready in Explorer`,
        allFiles: workingFiles,
        previousFiles: previousRepairFiles,
        changedFiles: repaired.files,
        deletedPaths: repaired.deletedPaths,
        source: "repair",
        data: {
          repairAttempt,
          repaired: repaired.repaired,
          parsedFileCount: repaired.parsedFileCount,
          acceptedFileCount: repaired.acceptedFileCount,
          rejectedFiles: repaired.rejectedFiles,
          deletedPaths: repaired.deletedPaths,
          installedDependencies: repaired.installedDependencies,
        },
      })

      validation = await runValidationLifecycle({
        jobId: input.jobId,
        projectId: input.projectId,
        prompt: input.prompt,
        files: workingFiles,
        plan,
        blueprint,
        signal: input.signal,
        emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
      })
      assertNotAborted(input.signal)
    }

    if (!validation.ok && shouldApplySafePreviewFallback(plan, validation)) {
      await GenerationJobService.assertNotCancelled(input.jobId)
      assertNotAborted(input.signal)
      const previousFallbackFiles = validation.files
      const fallback = normalizeGeneratedDependencies(
        buildSafePreviewFallbackFiles({
          prompt: input.prompt,
          appType: plan.appType,
        })
      )
      workingFiles = fallback.files

      await transition(input.jobId, "repairing", "Applying safe preview fallback", 91, {
        reason: validation.failure?.message || "Preview compile failed after AI repair",
        fallbackFileCount: workingFiles.length,
        addedPackages: fallback.addedPackages,
        normalizedPackages: fallback.normalizedPackages,
      })
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "repairing",
        message: "Safe preview fallback ready in Explorer",
        allFiles: workingFiles,
        previousFiles: previousFallbackFiles,
        changedFiles: workingFiles,
        deletedPaths: previousFallbackFiles
          .map((file) => normalizePath(file.path))
          .filter((path) => !workingFiles.some((file) => normalizePath(file.path) === path)),
        source: "repair",
        data: {
          fallbackApplied: true,
          failure: validation.failure || null,
          addedPackages: fallback.addedPackages,
          normalizedPackages: fallback.normalizedPackages,
        },
      })

      validation = await runValidationLifecycle({
        jobId: input.jobId,
        projectId: input.projectId,
        prompt: input.prompt,
        files: workingFiles,
        plan,
        blueprint,
        signal: input.signal,
        emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
      })
      assertNotAborted(input.signal)
    }

    workingFiles = validation.files
    const generatedFilesManifest = summarizeGeneratedManifest(workingFiles)
    const completedBlueprintValidation = validateBlueprintConstraints(workingFiles, blueprint, {
      requiredFiles:
        plan.productionMode === "production_fullstack" || plan.editPlan.mode === "partial"
          ? plan.filePlan.map((file) => file.path)
          : blueprint.requiredFiles,
    })
    log("info", "generation_manifest_completed", {
      jobId: input.jobId,
      projectId: input.projectId,
      classification: plan.productionMode,
      promptClassification: plan.objective,
      productionMode: plan.productionMode,
      fileCount: generatedFilesManifest.length,
      generatedFiles: generatedFilesManifest,
      requiredFilesMissing: completedBlueprintValidation.missingRequiredFiles,
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "generation.manifest.completed",
      stage: "validating",
      status: "running",
      message: "Generated artifact manifest completed",
      data: {
        classification: plan.productionMode,
        promptClassification: plan.objective,
        productionMode: plan.productionMode,
        fileCount: generatedFilesManifest.length,
        generatedFiles: generatedFilesManifest,
        requiredFilesMissing: completedBlueprintValidation.missingRequiredFiles,
        appPlan,
      },
    })
    metrics.previewStatus = validation.previewStatus
    metrics.previewError = validation.failure?.message || null
    metrics.validationLifecycle = {
      ok: validation.ok,
      repairAttempts: repairAttempt,
      steps: validation.steps,
      sandboxValidation: validation.sandboxValidation,
      failure: validation.failure || null,
    }
    metrics.quality = {
      appType: plan.appType,
      editMode: plan.editPlan.mode,
      editIntent: plan.editPlan.intent,
      targetFileCount: plan.editPlan.targetPaths.length,
      preservedFileCount: plan.editPlan.preservePaths.length,
      providerLatencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
    }

    if (!validation.ok) {
      log("warn", "Generation validation lifecycle failed", {
        jobId: input.jobId,
        projectId: input.projectId,
        repairAttempts: repairAttempt,
        failure: validation.failure,
      })
      throw new Error(validation.failure?.message || "Validation lifecycle failed")
    }

    await GenerationJobService.assertNotCancelled(input.jobId)
    assertNotAborted(input.signal)
    await transition(input.jobId, "persisting", "Persisting validated project artifacts", 94, {
      repairAttempts: repairAttempt,
      validationSteps: validation.steps.map((step) => ({
        name: step.name,
        status: step.status,
        policy: step.policy,
      })),
    })

    const saveResult = await ProjectFilePersistenceService.saveBufferedArtifacts({
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
      idempotencyKey: input.persistenceKey,
      generationJobId: input.jobId,
    })
    log("info", "database_persisted", {
      jobId: input.jobId,
      projectId: input.projectId,
      historyId: saveResult.historyId,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
    })
    log("info", "generation_files_persisted", {
      jobId: input.jobId,
      projectId: input.projectId,
      historyId: saveResult.historyId,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
    })
    log("info", "files_written", {
      jobId: input.jobId,
      projectId: input.projectId,
      historyId: saveResult.historyId,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "job.files.persisted",
      stage: "persisting",
      status: "running",
      message: "Project filesystem persisted",
      data: {
        source: "persisted",
        historyId: saveResult.historyId,
        fileDiff: saveResult.fileDiff,
        manifest: saveResult.manifest,
      },
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "files_written",
      stage: "persisting",
      status: "running",
      message: "Files written to project filesystem",
      data: {
        source: "persisted",
        historyId: saveResult.historyId,
        fileDiff: saveResult.fileDiff,
        manifest: saveResult.manifest,
      },
    })

    assertNotAborted(input.signal)
    metrics.persistence = {
      historyId: saveResult.historyId,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
    }
    await GenerationJobService.update(input.jobId, {
      metrics,
      previewUrl: validation.previewUrl,
    })
    log("info", "preview_ready", {
      jobId: input.jobId,
      projectId: input.projectId,
      historyId: saveResult.historyId,
      previewUrl: validation.previewUrl,
      previewStatus: validation.previewStatus,
      fileCount: workingFiles.length,
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "preview_ready",
      stage: "completed",
      status: "running",
      message: "Preview artifacts ready",
      data: {
        previewUrl: validation.previewUrl,
        historyId: saveResult.historyId,
        fileCount: workingFiles.length,
        previewStatus: validation.previewStatus,
      },
    })
    await recordGenerationQuality({
      jobId: input.jobId,
      projectId: input.projectId,
      appType: plan.appType,
      status: "completed",
      validation,
      repairAttempts: repairAttempt,
      providerLatencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      totalLatencyMs: performance.now() - jobStartedAt,
      metadata: {
        objective: plan.objective,
        editPlan: {
          mode: plan.editPlan.mode,
          intent: plan.editPlan.intent,
          targetPaths: plan.editPlan.targetPaths,
          allowedNewPaths: plan.editPlan.allowedNewPaths,
          preservedFileCount: plan.editPlan.preservePaths.length,
        },
        fileCount: workingFiles.length,
      },
    })
    await GenerationJobService.markCompleted(input.jobId, saveResult.historyId, validation.previewUrl)

    return {
      historyId: saveResult.historyId,
      files: workingFiles,
      previewUrl: validation.previewUrl,
    }
  } catch (error) {
    const cancelledBySignal =
      error instanceof Error && error.message === "GENERATION_JOB_CANCELLED"

    if (error instanceof GenerationJobCancelledError || cancelledBySignal) {
      await recordGenerationQuality({
        jobId: input.jobId,
        projectId: input.projectId,
        appType: plan?.appType || classifyControlledAppType(input.prompt),
        status: "cancelled",
        validation,
        repairAttempts: repairAttempt,
        providerLatencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        totalLatencyMs: performance.now() - jobStartedAt,
        failureStage: "code-generation",
        failureCode: "cancelled",
      }).catch(() => null)
      await GenerationJobService.markCancelled(input.jobId, "Generation cancelled")
      throw error
    }

    const serialized = serializeError(error)
    await GenerationJobService.update(input.jobId, {
      diagnostics: serialized,
      metrics,
    })
    await recordGenerationQuality({
      jobId: input.jobId,
      projectId: input.projectId,
      appType: plan?.appType || classifyControlledAppType(input.prompt),
      status: "failed",
      validation,
      repairAttempts: repairAttempt,
      providerLatencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      totalLatencyMs: performance.now() - jobStartedAt,
      failureStage: validation?.failure ? mapLifecycleFailureToQualityStage(validation.failure.step) : "unknown",
      failureCode: serialized.message,
      metadata: {
        errorName: serialized.name,
        editPlan: plan
          ? {
              mode: plan.editPlan.mode,
              intent: plan.editPlan.intent,
              targetPaths: plan.editPlan.targetPaths,
              allowedNewPaths: plan.editPlan.allowedNewPaths,
            }
          : null,
      },
    }).catch(() => null)
    await GenerationJobService.markFailed(input.jobId, serialized.message)
    throw error
  }
}
