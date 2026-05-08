import { Badge } from "@/components/ui/badge"
import { Zap } from "lucide-react"

interface OrchestratorBadgeProps {
  size?: "sm" | "md"
  showCost?: boolean
}

export function OrchestratorBadge({ size = "md", showCost = true }: OrchestratorBadgeProps) {
  const sizeClasses = {
    sm: "px-2 py-1 text-xs gap-1",
    md: "px-3 py-1.5 text-sm gap-1.5",
  }

  return (
    <Badge className={`${sizeClasses[size]} bg-purple-500/20 text-purple-700 border-purple-200 hover:bg-purple-500/30 flex items-center`}>
      <Zap className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} />
      <span>Orchestrator</span>
      {showCost && <span className="text-purple-600 font-semibold">5K</span>}
    </Badge>
  )
}
