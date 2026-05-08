import { GoogleAuthCard } from "@/components/auth/google-auth-card"

export default function SignupPage() {
  return (
    <GoogleAuthCard
      title="Create your account with Google"
      description="New accounts are created automatically when you continue with Google."
      buttonLabel="Continue with Google"
      loadingLabel="Redirecting to Google..."
      helperText="Already have an account? Use the same Google button to sign in."
      footerLabel="Want to go back? Sign in with Google"
      footerHref="/login"
      errorMessage="Failed to sign up with Google"
    />
  )
}
