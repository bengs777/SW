"use client"

import { useEffect } from "react"
import Link from "next/link"
import { AlertTriangle, Home, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[dashboard] Unhandled error:", error)
  }, [error])

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <Card className="w-full max-w-xl overflow-hidden border-border/70 shadow-xl shadow-black/5">
        <div className="h-1 w-full bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500" />
        <CardHeader className="space-y-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <CardTitle>Dashboard temporarily unavailable</CardTitle>
          <CardDescription>
            We hit an unexpected server error while loading the dashboard. The rest of the app should still be reachable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error.digest && (
            <div className="rounded-2xl border border-border/70 bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
              Error ID: {error.digest}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button onClick={reset} className="gap-2 rounded-full px-4">
              <RotateCcw className="h-4 w-4" />
              Try again
            </Button>
            <Button asChild variant="outline" className="gap-2 rounded-full px-4">
              <Link href="/dashboard">
                <Home className="h-4 w-4" />
                Back to dashboard
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
