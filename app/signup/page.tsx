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

export default async function SignupPage({ searchParams }: AuthPageProps) {
  const params = searchParams ? await searchParams : {}
  const callbackUrl = resolveCallbackUrl(params.callbackUrl)
  const callbackQuery = callbackUrl === "/dashboard" ? "" : `?callbackUrl=${encodeURIComponent(callbackUrl)}`

  return (
    <GoogleAuthCard
      title="Create your account with Google"
      description="New accounts are created automatically and receive 10.000 credits when you continue with Google."
      buttonLabel="Continue with Google"
      loadingLabel="Redirecting to Google..."
      helperText="Already have an account? Use the same Google button to sign in."
      footerLabel="Want to go back? Sign in with Google"
      footerHref={`/login${callbackQuery}`}
      errorMessage="Failed to sign up with Google"
      callbackUrl={callbackUrl}
    />
  )
}
