"use client"

import { useEffect, useState } from "react"
import { Coins, AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"

interface BalanceInfoProps {
  userId?: string
  showAlert?: boolean
}

interface BalanceData {
  balance: number
  email: string
}

export function BalanceInfo({ userId, showAlert = true }: BalanceInfoProps) {
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchBalance = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch("/api/user/balance")
      const data = await response.json()
      
      if (!response.ok) {
        setError(data.error || "Failed to fetch balance")
        return
      }

      setBalance(data.balance)
    } catch (err) {
      setError("Failed to fetch balance")
      console.error("[v0] Balance fetch error:", err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchBalance()
    // Refresh balance every 30 seconds
    const interval = setInterval(fetchBalance, 30000)
    return () => clearInterval(interval)
  }, [])

  const costPerGeneration = 2000
  const hasEnoughBalance = balance !== null && balance >= costPerGeneration
  const isLowBalance = balance !== null && balance < 50000

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      {/* Balance Display */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground">Saldo Anda</span>
            {loading ? (
              <span className="text-sm text-muted-foreground">Loading...</span>
            ) : error ? (
              <span className="text-xs text-destructive">{error}</span>
            ) : (
              <span className={`text-base font-semibold ${isLowBalance ? "text-yellow-600 dark:text-yellow-500" : "text-foreground"}`}>
                Rp {(balance || 0).toLocaleString("id-ID")}
              </span>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={fetchBalance}
          disabled={loading}
          className="h-8 w-8 p-0"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Cost Info */}
      <div className="text-xs text-muted-foreground">
        Biaya per generasi: <span className="font-medium text-foreground">Rp {costPerGeneration.toLocaleString("id-ID")}</span>
      </div>

      {/* Alerts */}
      {showAlert && (
        <>
          {!hasEnoughBalance && balance !== null && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="text-xs text-destructive">
                <div className="font-medium">Saldo tidak cukup</div>
                <div>Anda memerlukan Rp {costPerGeneration.toLocaleString("id-ID")} untuk membuat kode</div>
              </div>
            </div>
          )}

          {isLowBalance && hasEnoughBalance && (
            <div className="flex items-start gap-2 rounded-md bg-yellow-500/10 p-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 text-yellow-600 dark:text-yellow-500" />
              <div className="text-xs text-yellow-700 dark:text-yellow-400">
                <div className="font-medium">Saldo menipis</div>
                <div>Anda hanya punya {Math.floor((balance || 0) / costPerGeneration)} generasi tersisa</div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Top Up Button */}
      {!hasEnoughBalance && (
        <Link href="/dashboard/settings?tab=billing">
          <Button size="sm" className="w-full" variant="default">
            Top Up Sekarang
          </Button>
        </Link>
      )}

      {isLowBalance && hasEnoughBalance && (
        <Link href="/dashboard/settings?tab=billing">
          <Button size="sm" className="w-full" variant="outline">
            Top Up
          </Button>
        </Link>
      )}
    </div>
  )
}
