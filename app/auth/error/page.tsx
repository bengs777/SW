import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const errorMessages: { [key: string]: string } = {
  AccessDenied: "Access was denied. You may not have the required permissions.",
  Configuration:
    "There is a problem with the server configuration. Please contact support.",
  Verification:
    "The token has expired or has already been used. Please try signing in again.",
  Default: "An unknown error occurred. Please try again later.",
}

type AuthErrorPageProps = {
  searchParams: Promise<{ error?: string }>
}

export default async function AuthErrorPage({ searchParams }: AuthErrorPageProps) {
  const { error } = await searchParams
  const message =
    error && errorMessages[error] ? errorMessages[error] : errorMessages.Default

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border/80 shadow-lg">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl font-semibold">Authentication Error</CardTitle>
          <CardDescription>
            {error ? `Error code: ${error}` : "Please try signing in again."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{message}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild className="flex-1">
              <Link href="/login">Go back to Login</Link>
            </Button>
            <Button asChild variant="outline" className="flex-1">
              <Link href="/">Go home</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
