import { SignIn } from '@clerk/nextjs'

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn
        fallbackRedirectUrl="/dashboard"
        signUpUrl="/signup"
      />
    </div>
  )
}
