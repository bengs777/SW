import { DashboardSidebar } from "@/components/dashboard/sidebar"
import { getSession } from "@/auth"
import { redirect } from "next/navigation"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()

  if (!session?.email) {
    redirect("/login")
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
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
  )
}
