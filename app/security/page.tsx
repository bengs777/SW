export default function SecurityPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-16 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">Security</h1>
        <p className="text-sm text-muted-foreground">
          We apply authentication controls, secret management, and rate limiting to protect user accounts
          and API usage.
        </p>
        <p className="text-sm text-muted-foreground">
          For security reports, contact: security@swift.app.
        </p>
      </div>
    </main>
  )
}
