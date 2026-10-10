import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import http from "node:http"
import { projects, generationJobs } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"
import { getProjectAccess } from "@/lib/auth/project-access"
import { sandboxProvider } from "@/lib/sandbox/sandbox-provider"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function probePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const client = http.get(`http://127.0.0.1:${port}/`, { timeout: 1000 }, (res) => {
      resolve(true)
      res.resume()
    })
    client.on("error", () => resolve(false))
    client.on("timeout", () => {
      client.destroy()
      resolve(false)
    })
  })
}

async function assertAccess(projectId: string, request: NextRequest) {
  // 1. Preview token in query parameter
  const previewToken = request.nextUrl.searchParams.get("previewToken")
  if (previewToken) {
    return true
  }

  // 2. Project-scoped preview cookie
  const cookieToken = request.cookies.get(`swift_preview_${projectId}`)?.value
  if (cookieToken) {
    return true
  }

  // 3. User session authentication
  const session = await getSession()
  if (session?.userId) {
    const access = await getProjectAccess(projectId, { userId: session.userId, email: session.email })
    if (access) {
      return true
    }
  }

  // 4. Sub-resource request originating from an authorized preview page or dashboard
  const referer = request.headers.get("referer")
  if (referer) {
    try {
      const refUrl = new URL(referer)
      const allowedPath = `/preview/${projectId}`
      const allowedApiPath = `/api/preview/${projectId}`
      const allowedDashPath = `/dashboard/project/${projectId}`
      if (
        refUrl.origin === request.nextUrl.origin &&
        (refUrl.pathname.startsWith(allowedPath) ||
         refUrl.pathname.startsWith(allowedApiPath) ||
         refUrl.pathname.startsWith(allowedDashPath))
      ) {
        return true
      }
    } catch {}
  }

  return false
}

async function handleProxy(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  try {
    const { id: projectId, path: subpathSegments } = await params
    const hasAccess = await assertAccess(projectId, request)
    if (!hasAccess) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

  let target: { targetUrl: string; port: number } | null = null
  try {
    const [latestJob] = await db
      .select({ previewUrl: generationJobs.previewUrl })
      .from(generationJobs)
      .where(eq(generationJobs.projectId, projectId))
      .orderBy(desc(generationJobs.createdAt))
      .limit(1)

    if (latestJob?.previewUrl) {
      const parsed = new URL(latestJob.previewUrl)
      const port = Number(parsed.port) || 4300
      const isAlive = await probePort(port)
      if (isAlive) {
        target = { targetUrl: `http://127.0.0.1:${port}`, port }
      }
    }
  } catch {}

  if (!target) {
    target = await sandboxProvider.getPreviewTarget(projectId)
  }
  if (!target) {
    // Sandbox is starting or not available yet
    return new NextResponse(
      `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Mempersiapkan Runtime Preview...</title>
  <meta http-equiv="refresh" content="3">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #09090b; color: #fafafa; text-align: center; }
    .card { max-width: 420px; padding: 24px; border: 1px solid #27272a; border-radius: 12px; background: #18181b; }
    h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
    p { margin: 0; font-size: 13px; color: #a1a1aa; line-height: 1.5; }
    .spinner { display: inline-block; width: 22px; height: 22px; border: 2px solid #3f3f46; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h3>Sandbox Sedang Mempersiapkan Runtime...</h3>
    <p>Aplikasi sedang dimuat pada sandbox runtime. Halaman akan otomatis memuat ulang dalam 3 detik.</p>
  </div>
</body>
</html>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "frame-ancestors 'self'",
        },
      }
    )
  }

  const prefix = `/api/preview/${projectId}`
  const altPrefix = `/preview/${projectId}`
  let subpath = ""
  if (request.nextUrl.pathname.startsWith(prefix)) {
    subpath = request.nextUrl.pathname.slice(prefix.length).replace(/^\/+/, "")
  } else if (request.nextUrl.pathname.startsWith(altPrefix)) {
    subpath = request.nextUrl.pathname.slice(altPrefix.length).replace(/^\/+/, "")
  } else if (subpathSegments && subpathSegments.length > 0) {
    subpath = subpathSegments.join("/")
  }

  // Translate __sandbox_next__ back to _next for upstream dev server
  if (subpath.startsWith("__sandbox_next__/")) {
    subpath = "_next/" + subpath.slice("__sandbox_next__/".length)
  } else if (subpath === "__sandbox_next__") {
    subpath = "_next"
  }

  const queryString = request.nextUrl.search
  const targetUrl = `${target.targetUrl}/${subpath}${queryString}`

  const forwardHeaders = new Headers()
    for (const [key, val] of request.headers.entries()) {
      // Don't forward host header to avoid upstream rejection
      if (!["host", "connection"].includes(key.toLowerCase())) {
        forwardHeaders.set(key, val)
      }
    }
    forwardHeaders.set("X-Forwarded-Host", request.headers.get("host") || "")
    forwardHeaders.set("X-Forwarded-Proto", request.nextUrl.protocol.replace(":", ""))

    const reqInit: RequestInit = {
      method: request.method,
      headers: forwardHeaders,
      redirect: "manual",
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      reqInit.body = await request.arrayBuffer()
    }

    const upstreamResponse = await fetch(targetUrl, reqInit)
    const responseHeaders = new Headers()

    for (const [key, val] of upstreamResponse.headers.entries()) {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
        responseHeaders.set(key, val)
      }
    }

    // Set secure embedding headers specifically for Preview Gateway
    responseHeaders.set("X-Frame-Options", "SAMEORIGIN")
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'self'")

    const gatewayPrefix = `/api/preview/${encodeURIComponent(projectId)}`
    const contentType = upstreamResponse.headers.get("content-type") || ""

    const effectiveToken = request.nextUrl.searchParams.get("previewToken") ||
      request.cookies.get(`swift_preview_${projectId}`)?.value ||
      "authorized"

    if (upstreamResponse.status === 304) {
      const res = new NextResponse(null, {
        status: 304,
        headers: responseHeaders,
      })
      res.cookies.set(`swift_preview_${projectId}`, effectiveToken, {
        path: "/",
        sameSite: "lax",
      })
      return res
    }

    if (contentType.includes("text/html")) {
      let html = await upstreamResponse.text()
      // Rewrite internal Next.js assets to route back through Preview Gateway avoiding _next collision
      html = html.replace(/href="\/_next\//g, `href="${gatewayPrefix}/__sandbox_next__/`)
      html = html.replace(/src="\/_next\//g, `src="${gatewayPrefix}/__sandbox_next__/`)
      html = html.replace(/url\(\/_next\//g, `url(${gatewayPrefix}/__sandbox_next__/`)
      html = html.replace(/"\/_next\//g, `"${gatewayPrefix}/__sandbox_next__/`)
      html = html.replace(/'\/_next\//g, `'${gatewayPrefix}/__sandbox_next__/`)

      // Rewrite root-relative links in HTML (e.g. href="/" or href="/booking") so they stay within preview gateway
      html = html.replace(/href="\/(?!\/|api\/preview|preview|__sandbox_next__)([^"]*)"/g, `href="${gatewayPrefix}/$1"`)
      html = html.replace(/href='\/(?!\/|api\/preview|preview|__sandbox_next__)([^']*)'/g, `href='${gatewayPrefix}/$1'`)

      // Navigation interceptor script to keep internal routing inside preview gateway
      const navInterceptor = `<script>
(function() {
  var prefix = "${gatewayPrefix}";
  var origPush = history.pushState;
  history.pushState = function(state, unused, url) {
    if (typeof url === "string" && url.startsWith("/") && !url.startsWith(prefix) && !url.startsWith("/preview/") && !url.startsWith("/api/preview/")) {
      url = prefix + url;
    }
    return origPush.call(this, state, unused, url);
  };
  var origReplace = history.replaceState;
  history.replaceState = function(state, unused, url) {
    if (typeof url === "string" && url.startsWith("/") && !url.startsWith(prefix) && !url.startsWith("/preview/") && !url.startsWith("/api/preview/")) {
      url = prefix + url;
    }
    return origReplace.call(this, state, unused, url);
  };
  document.addEventListener("click", function(e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    var rawHref = a.getAttribute("href");
    if (!rawHref) return;
    if (rawHref.startsWith("#") || rawHref.startsWith("javascript:") || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) return;
    if (rawHref.startsWith("http://") || rawHref.startsWith("https://")) {
      try {
        var u = new URL(rawHref);
        if (u.origin === window.location.origin && !u.pathname.startsWith(prefix) && !u.pathname.startsWith("/preview/")) {
          e.preventDefault();
          window.location.href = prefix + u.pathname + u.search + u.hash;
        }
      } catch(err) {}
      return;
    }
    if (rawHref.startsWith("/") && !rawHref.startsWith(prefix) && !rawHref.startsWith("/preview/")) {
      e.preventDefault();
      window.location.href = prefix + rawHref;
    }
  }, true);
})();
</script>`

      // Inject base tag and navigation interceptor
      if (!html.includes("<base ") && html.includes("<head>")) {
        html = html.replace("<head>", `<head><base href="${gatewayPrefix}/">${navInterceptor}`)
      } else if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${navInterceptor}`)
      }

      const res = new NextResponse(html, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      })
      res.cookies.set(`swift_preview_${projectId}`, effectiveToken, {
        path: "/",
        sameSite: "lax",
        maxAge: 86400,
      })
      return res
    }

    if (contentType.includes("application/javascript") || contentType.includes("text/javascript")) {
      let js = await upstreamResponse.text()
      // Rewrite runtime asset chunk paths (e.g. Turbopack / Webpack asset prefixes)
      if (js.includes("/_next/")) {
        js = js.replace(/"\/_next\//g, `"${gatewayPrefix}/__sandbox_next__/`)
        js = js.replace(/'\/_next\//g, `'${gatewayPrefix}/__sandbox_next__/`)
      }
      const res = new NextResponse(js, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      })
      res.cookies.set(`swift_preview_${projectId}`, effectiveToken, {
        path: "/",
        sameSite: "lax",
      })
      return res
    }

    if (contentType.includes("text/css")) {
      let css = await upstreamResponse.text()
      if (css.includes("/_next/")) {
        css = css.replace(/url\(\s*["']?\/_next\//g, `url("${gatewayPrefix}/__sandbox_next__/`)
      }
      const res = new NextResponse(css, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      })
      res.cookies.set(`swift_preview_${projectId}`, effectiveToken, {
        path: "/",
        sameSite: "lax",
      })
      return res
    }

    const bodyBuffer = await upstreamResponse.arrayBuffer()
    const res = new NextResponse(bodyBuffer, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    })
    res.cookies.set(`swift_preview_${projectId}`, effectiveToken, {
      path: "/",
      sameSite: "lax",
    })
    return res
  } catch (err: any) {
    return new NextResponse(
      `Sandbox preview proxy error: ${err instanceof Error ? err.message : String(err)}`,
      {
        status: 502,
        headers: {
          "Content-Type": "text/plain",
          "X-Frame-Options": "SAMEORIGIN",
        },
      }
    )
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; path?: string[] }> }
) {
  try {
    return await handleProxy(request, context)
  } catch (err: any) {
    return new NextResponse(`CRASH_IN_GET: ${err?.stack || err?.message || String(err)}`, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }
}
export const POST = handleProxy
export const PUT = handleProxy
export const DELETE = handleProxy
export const PATCH = handleProxy
export const HEAD = handleProxy
export const OPTIONS = handleProxy
