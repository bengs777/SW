import { DashboardSidebar } from "@/components/dashboard/sidebar"
import { AuthSessionProvider } from "@/components/providers/session-provider"
import { auth } from "@/auth"
import { redirect } from "next/navigation"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  if (!session?.user?.email) {
    redirect("/login")
  }

  return (
    <AuthSessionProvider>
      <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
        <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,oklch(0.985_0_0_/_0.82),transparent_32%),radial-gradient(circle_at_top_right,oklch(0.97_0_0_/_0.55),transparent_26%)] dark:bg-[radial-gradient(circle_at_top_left,oklch(0.269_0_0_/_0.82),transparent_28%),radial-gradient(circle_at_top_right,oklch(0.205_0_0_/_0.52),transparent_24%)]" />
        <div className="flex min-h-screen flex-col lg:flex-row">
          <DashboardSidebar />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <div className="mx-auto flex min-h-full w-full max-w-[1600px] flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
                {children}
              </div>
            </div>
          </main>
        </div>
      </div>
    </AuthSessionProvider>
  )
}
