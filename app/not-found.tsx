import Link from "next/link"

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6 py-16">
      <section className="w-full max-w-xl rounded-3xl border border-border/70 bg-card p-8 text-center shadow-xl shadow-black/5">
        <p className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
          404
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The page you are looking for does not exist or has moved.
        </p>
        <div className="mt-6 flex justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Back to home
          </Link>
        </div>
      </section>
    </main>
  )
}