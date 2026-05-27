```txt
SYSTEM / MASTER PROMPT

Gunakan model:
deepseek/deepseek-v4-flash

Tujuan:
Ubah AI builder menjadi sistem seperti OpenRouter/Lovable/Bolt:
- seluruh chat user dan jawaban AI tampil realtime di panel kiri
- reasoning/progress generation tampil live
- code/file otomatis masuk Explorer
- preview update realtime
- artifact parsing deterministic
- replay-safe generation

JANGAN gunakan raw markdown sebagai source of truth.
Gunakan artifact registry.

==================================================
TARGET ARCHITECTURE
==================================================

Pisahkan sistem menjadi:

1. Conversation Streaming Layer
2. Artifact Extraction Layer
3. Workspace Filesystem Layer
4. Explorer Sync Layer
5. Preview Rebuild Layer

==================================================
CHAT PANEL REQUIREMENTS
==================================================

Buat panel conversation seperti OpenRouter.

Panel harus menampilkan:
- user prompts
- assistant responses
- planning/reasoning summary
- repair attempts
- retries
- generation phases
- errors
- tool execution status

Semua harus realtime streaming.

Gunakan structure:

type ChatMessage = {
  id: string
  role: "user" | "assistant" | "system"
  type?: "text" | "reasoning" | "artifact" | "error"
  content: string
  createdAt: number
}

==================================================
STREAMING REQUIREMENTS
==================================================

Gunakan stream=true.

Implement token streaming:
- append token realtime
- jangan tunggu full completion
- support interruption recovery
- support reconnect

Contoh:
onToken(token) {
  appendMessageToken(token)
}

==================================================
ARTIFACT FORMAT
==================================================

AI WAJIB output structured artifact.

JANGAN parse markdown biasa.

Gunakan XML-like format:

<message type="reasoning">
Membuat auth system
</message>

<file path="app/page.tsx">
export default function Page() {
  return <div>Hello</div>
}
</file>

<file path="components/Navbar.tsx">
...
</file>

==================================================
ARTIFACT PARSER
==================================================

Buat deterministic parser:
- extract file tags
- validate paths
- validate extension
- validate file size
- reject malformed artifact
- reject duplicate writes

Parser harus replay-safe.

==================================================
FILESYSTEM POLICY
==================================================

Gunakan sandbox workspace.

Allowlist:

app/
components/
lib/
styles/
public/

Block:
- ../ traversal
- absolute paths
- node_modules mutation
- hidden system files

Allowed extensions:
.ts
.tsx
.js
.jsx
.json
.css
.md

==================================================
EXPLORER INTEGRATION
==================================================

Explorer TIDAK boleh membaca raw AI chat.

Explorer hanya membaca:

artifactRegistry

Structure:

type Artifact = {
  path: string
  content: string
  hash: string
  createdAt: number
}

Saat artifact valid:
- write file ke workspace
- sync explorer realtime
- trigger preview rebuild

==================================================
GENERATION FLOW
==================================================

Flow wajib:

User Prompt
↓
DeepSeek Stream
↓
Conversation Panel Live Update
↓
Artifact Parser
↓
Artifact Validation
↓
Sandbox Write
↓
Explorer Refresh
↓
Preview Rebuild

==================================================
GENERATION STRATEGY
==================================================

JANGAN generate semua sekaligus.

Gunakan phased generation:

Phase 1 → project scaffold
Phase 2 → routing
Phase 3 → auth
Phase 4 → database
Phase 5 → dashboard
Phase 6 → UI polish

Tampilkan semua phase di conversation panel.

==================================================
ERROR HANDLING
==================================================

Jika generation gagal:
- tampilkan error di chat panel
- tampilkan repair attempt
- tampilkan failed file
- tampilkan retry status

JANGAN hanya tampilkan:
"Generation failed"

==================================================
DIFF STRATEGY
==================================================

Gunakan incremental patching.

JANGAN patch >5 file sekaligus.

Chunk patch:
- 1-3 file per mutation batch
- deterministic order
- replay-safe

==================================================
REPLAY SAFETY
==================================================

Requirements:
- artifact registry sebagai source of truth
- replay bisa restore workspace
- duplicate artifact blocked
- deterministic patch ordering
- hash validation wajib

==================================================
UI TARGET
==================================================

LEFT:
Conversation realtime

CENTER:
Preview/browser

RIGHT:
Explorer + file tree

==================================================
VALIDATION
==================================================

Tambahkan tests:
- streaming recovery
- malformed artifact rejection
- path traversal rejection
- explorer sync tests
- replay restoration tests
- duplicate artifact tests
- phased generation tests

==================================================
OUTPUT
==================================================

Berikan:
1. files changed
2. streaming architecture summary
3. artifact parser summary
4. explorer sync summary
5. replay safety summary
6. UI behavior summary
7. validation results
```
