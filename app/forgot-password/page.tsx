"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Password reset is no longer used</CardTitle>
          <CardDescription>
            Swift now uses Google sign-in only. If you need access, continue with Google on the login page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            There is no separate password reset flow now. Use Google sign-in from the login page to access or create your account.
          </p>

          <div className="flex gap-3">
            <Button asChild className="flex-1">
              <Link href="/login">Go to login</Link>
            </Button>
            <Button asChild variant="outline" className="flex-1">
              <Link href="/signup">Go to sign up</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}