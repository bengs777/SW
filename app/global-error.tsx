'use client'

import Link from "next/link"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground">
        <main className="flex min-h-screen items-center justify-center px-6 py-16">
          <section className="w-full max-w-xl rounded-3xl border border-border/70 bg-card p-8 shadow-xl shadow-black/5 text-center">
            <p className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
              Critical error
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
              Swift hit a rendering error
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The app could not finish rendering this page. Try again or go back to the home page.
            </p>
            {error.digest ? (
              <div className="mt-5 rounded-2xl border border-border/70 bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
                Error ID: {error.digest}
              </div>
            ) : null}
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center justify-center rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                Try again
              </button>
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                Back to home
              </Link>
            </div>
          </section>
        </main>
      </body>
    </html>
  )
}