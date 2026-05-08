"use client"

import Link from "next/link"
import { useState } from "react"
import { Chrome, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { navigateToExternalUrl, startGoogleSignIn } from "@/lib/auth-client"

type AuthFeedback = {
  type: "error" | "success"
  text: string
}

type GoogleAuthCardProps = {
  title: string
  description: string
  buttonLabel: string
  loadingLabel: string
  helperText: string
  footerLabel: string
  footerHref: string
  errorMessage: string
  callbackUrl?: string
}

export function GoogleAuthCard({
  title,
  description,
  buttonLabel,
  loadingLabel,
  helperText,
  footerLabel,
  footerHref,
  errorMessage,
  callbackUrl = "/dashboard",
}: GoogleAuthCardProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [feedback, setFeedback] = useState<AuthFeedback | null>(null)

  const handleGoogleAuth = async () => {
    setIsLoading(true)
    setFeedback(null)

    try {
      const result = await startGoogleSignIn(callbackUrl)

      if (result.url) {
        const redirected = navigateToExternalUrl(result.url)

        if (!redirected) {
          setFeedback({
            type: "error",
            text: "Unable to open Google sign-in. Please allow pop-ups and try again.",
          })
          setIsLoading(false)
        }

        return
      }

      setFeedback({
        type: "error",
        text: result.error || errorMessage,
      })
      setIsLoading(false)
    } catch {
      setFeedback({ type: "error", text: errorMessage })
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-semibold text-foreground">Swift</span>
        </Link>

        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-semibold text-foreground">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>

          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={handleGoogleAuth}
            disabled={isLoading}
            suppressHydrationWarning
          >
            <Chrome className="h-4 w-4" />
            {buttonLabel}
          </Button>

          {feedback && (
            <p
              className={`mt-4 text-sm ${
                feedback.type === "error"
                  ? "text-destructive"
                  : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {feedback.text}
            </p>
          )}

          <p className="mt-4 text-sm text-muted-foreground">{helperText}</p>

          <Button asChild variant="ghost" className="mt-4 w-full text-sm">
            <Link href={footerHref}>{footerLabel}</Link>
          </Button>

          {isLoading && (
            <div className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              {loadingLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}