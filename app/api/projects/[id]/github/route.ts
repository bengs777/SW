import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import { splitWorkspaceStateFiles } from "@/lib/workspace-state"
import type { GeneratedFile } from "@/lib/types"

const MAX_GITHUB_FILE_BYTES = 900_000

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "swift-project"
}

async function githubFetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const message = typeof data?.message === "string" ? data.message : `GitHub API rejected request (${response.status})`
    throw new Error(message)
  }
  return data as T
}

async function resolveProject(projectId: string, userId: string) {
  return prisma.project.findFirst({
    where: {
      id: projectId,
      workspace: {
        members: {
          some: { userId },
        },
      },
    },
    include: { files: true },
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const token = process.env.GITHUB_TOKEN || process.env.SWIFT_GITHUB_TOKEN
  if (!token) {
    return NextResponse.json(
      {
        error: "GitHub push is not configured. Set GITHUB_TOKEN or SWIFT_GITHUB_TOKEN on the server.",
        setupRequired: true,
      },
      { status: 501 }
    )
  }

  const { id } = await params
  const project = await resolveProject(id, session.user.id)
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const body = await request.json().catch(() => ({}))
  const rawFiles = Array.isArray((body as { files?: unknown }).files)
    ? ((body as { files: GeneratedFile[] }).files)
    : project.files.map((file) => ({
        path: file.path,
        content: file.content,
        language: file.language,
      } as GeneratedFile))
  const { files } = splitWorkspaceStateFiles(ProjectFilesystemService.normalizeFiles(rawFiles))
  if (files.length === 0) {
    return NextResponse.json({ error: "No files available to push." }, { status: 400 })
  }

  const oversized = files.find((file) => Buffer.byteLength(file.content || "", "utf8") > MAX_GITHUB_FILE_BYTES)
  if (oversized) {
    return NextResponse.json({ error: `File ${oversized.path} is too large for direct GitHub push.` }, { status: 413 })
  }

  const viewer = await githubFetch<{ login: string }>("https://api.github.com/user", token)
  const repoName = slugify(String((body as { repoName?: unknown }).repoName || project.name))
  let repo = await githubFetch<{ html_url: string; default_branch: string }>(
    "https://api.github.com/user/repos",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        name: repoName,
        private: true,
        auto_init: false,
      }),
    }
  ).catch(async (error) => {
    if (!/already exists|name already exists/i.test(error instanceof Error ? error.message : String(error))) {
      throw error
    }
    return githubFetch<{ html_url: string; default_branch: string }>(
      `https://api.github.com/repos/${viewer.login}/${repoName}`,
      token
    )
  })

  let parentSha: string | null = null
  let baseTree: string | null = null
  try {
    const ref = await githubFetch<{ object: { sha: string } }>(
      `https://api.github.com/repos/${viewer.login}/${repoName}/git/ref/heads/${repo.default_branch || "main"}`,
      token
    )
    parentSha = ref.object.sha
    const commit = await githubFetch<{ tree: { sha: string } }>(
      `https://api.github.com/repos/${viewer.login}/${repoName}/git/commits/${parentSha}`,
      token
    )
    baseTree = commit.tree.sha
  } catch {
    parentSha = null
    baseTree = null
    repo = { ...repo, default_branch: "main" }
  }

  const tree = await githubFetch<{ sha: string }>(
    `https://api.github.com/repos/${viewer.login}/${repoName}/git/trees`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: files.map((file) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          content: file.content || "",
        })),
      }),
    }
  )

  const commit = await githubFetch<{ sha: string }>(
    `https://api.github.com/repos/${viewer.login}/${repoName}/git/commits`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        message: `Update ${project.name} from Swift`,
        tree: tree.sha,
        ...(parentSha ? { parents: [parentSha] } : {}),
      }),
    }
  )

  if (parentSha) {
    await githubFetch(
      `https://api.github.com/repos/${viewer.login}/${repoName}/git/refs/heads/${repo.default_branch || "main"}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha }),
      }
    )
  } else {
    await githubFetch(
      `https://api.github.com/repos/${viewer.login}/${repoName}/git/refs`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/main", sha: commit.sha }),
      }
    )
  }

  return NextResponse.json({
    success: true,
    repository: {
      owner: viewer.login,
      name: repoName,
      url: repo.html_url,
      branch: repo.default_branch || "main",
      commitSha: commit.sha,
    },
  })
}
