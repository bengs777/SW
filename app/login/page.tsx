import { GoogleAuthCard } from "@/components/auth/google-auth-card"

type AuthPageProps = {
  searchParams?: Promise<{
    callbackUrl?: string | string[]
  }>
}

function resolveCallbackUrl(value?: string | string[]) {
  const callbackUrl = Array.isArray(value) ? value[0] : value
  if (callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")) {
    return callbackUrl
  }

  return "/dashboard"
}

export default async function LoginPage({ searchParams }: AuthPageProps) {
  const params = searchParams ? await searchParams : {}
  const callbackUrl = resolveCallbackUrl(params.callbackUrl)
  const callbackQuery = callbackUrl === "/dashboard" ? "" : `?callbackUrl=${encodeURIComponent(callbackUrl)}`

  return (
    <GoogleAuthCard
      title="Continue with Google"
      description="Google is the only sign-in method for Swift."
      buttonLabel="Continue with Google"
      loadingLabel="Redirecting..."
      helperText="If you already have an account, use the same Google button. New users are created automatically."
      footerLabel="Need to create an account? Go to sign up"
      footerHref={`/signup${callbackQuery}`}
      errorMessage="Failed to sign in with Google"
      callbackUrl={callbackUrl}
    />
  )
}
