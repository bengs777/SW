export default function ApiReferencePage() {
  return (
    <main className="min-h-screen bg-background px-4 py-16 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">API Reference</h1>
        <p className="text-muted-foreground">
          Endpoint utama saat ini tersedia melalui area authenticated di dashboard dan API routes internal.
        </p>
        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-foreground">Core Endpoints</h2>
          <ul className="list-disc space-y-2 pl-6 text-sm text-foreground">
            <li>POST /api/generate</li>
            <li>GET /api/projects</li>
            <li>POST /api/projects</li>
            <li>GET /api/models</li>
            <li>GET /api/providers/status</li>
          </ul>
        </section>
      </div>
    </main>
  )
}
