export default function DashboardLoading() {
  return (
    <div className="space-y-6 pb-6">
      <div className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm sm:p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-5 w-36 rounded-full bg-muted" />
          <div className="h-10 w-3/4 rounded-2xl bg-muted/80" />
          <div className="h-4 w-full max-w-3xl rounded-full bg-muted/70" />
          <div className="flex flex-wrap gap-2 pt-2">
            <div className="h-8 w-40 rounded-full bg-muted/70" />
            <div className="h-8 w-48 rounded-full bg-muted/70" />
            <div className="h-8 w-32 rounded-full bg-muted/70" />
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="rounded-3xl border border-border/70 bg-card/80 p-5 shadow-sm"
          >
            <div className="animate-pulse space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-3">
                  <div className="h-3 w-24 rounded-full bg-muted" />
                  <div className="h-7 w-28 rounded-full bg-muted/80" />
                  <div className="h-4 w-32 rounded-full bg-muted/70" />
                </div>
                <div className="h-11 w-11 rounded-2xl bg-muted/70" />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <div className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm">
          <div className="animate-pulse space-y-4">
            <div className="h-5 w-40 rounded-full bg-muted" />
            <div className="h-4 w-72 rounded-full bg-muted/70" />
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-border/70 p-4">
                <div className="space-y-3">
                  <div className="h-4 w-40 rounded-full bg-muted" />
                  <div className="h-3 w-full rounded-full bg-muted/70" />
                  <div className="h-3 w-4/5 rounded-full bg-muted/70" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm">
          <div className="animate-pulse space-y-4">
            <div className="h-5 w-40 rounded-full bg-muted" />
            <div className="h-4 w-64 rounded-full bg-muted/70" />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="h-24 rounded-2xl bg-muted/70" />
              <div className="h-24 rounded-2xl bg-muted/70" />
            </div>
            <div className="h-24 rounded-2xl bg-muted/70" />
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm">
        <div className="animate-pulse space-y-4">
          <div className="h-5 w-40 rounded-full bg-muted" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-48 rounded-3xl bg-muted/70" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}