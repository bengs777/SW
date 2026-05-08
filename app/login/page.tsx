import { GoogleAuthCard } from "@/components/auth/google-auth-card"

export default function LoginPage() {
  return (
    <GoogleAuthCard
      title="Continue with Google"
      description="Google is the only sign-in method for Swift."
      buttonLabel="Continue with Google"
      loadingLabel="Redirecting..."
      helperText="If you already have an account, use the same Google button. New users are created automatically."
      footerLabel="Need to create an account? Go to sign up"
      footerHref="/signup"
      errorMessage="Failed to sign in with Google"
    />
  )
}
