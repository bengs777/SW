"use client"

import { signIn } from "next-auth/react"

type AuthResult = {
  ok: boolean
  url: URL | null
  error: string | null
}

const resolveRedirectUrl = (callbackUrl: string) =>
  new URL(callbackUrl, window.location.origin).toString()

export function navigateToExternalUrl(url: URL) {
  const targetUrl = url.toString()

  try {
    if (window.top && window.top !== window) {
      window.top.location.assign(targetUrl)
      return true
    }
  } catch {
    // Fall through to the current window or a new tab.
  }

  try {
    window.location.assign(targetUrl)
    return true
  } catch {
    return Boolean(window.open(targetUrl, "_blank", "noopener,noreferrer"))
  }
}

export async function startGoogleSignIn(callbackUrl: string) {
  const redirectTo = resolveRedirectUrl(callbackUrl)

  const response = await signIn("google", {
    redirect: false,
    callbackUrl: redirectTo,
  })

  return {
    ok: Boolean(response?.ok && response.url),
    url: response?.url ? new URL(response.url, window.location.origin) : null,
    error: response?.error ?? null,
  } satisfies AuthResult
}
