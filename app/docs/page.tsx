export default function DocsPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-16 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">Swift Documentation</h1>
        <p className="text-muted-foreground">
          Quick start: buat akun, pilih template, generate project, lalu iterasi lewat editor dan preview.
        </p>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-foreground">Quick Start</h2>
          <ol className="list-decimal space-y-2 pl-6 text-sm text-foreground">
            <li>Create account di halaman signup.</li>
            <li>Buka dashboard dan pilih workspace.</li>
            <li>Buat project baru dari prompt atau template.</li>
            <li>Iterasi hasil generate dan export code.</li>
          </ol>
        </section>
        <section id="status" className="space-y-2">
          <h2 className="text-xl font-semibold text-foreground">Service Status</h2>
          <p className="text-sm text-muted-foreground">
            Untuk saat ini status dipublikasikan manual lewat update di dashboard dan email support.
          </p>
        </section>
      </div>
    </main>
  )
}
