"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import { Wallet, ArrowUpRight, ArrowDownLeft } from "lucide-react"
import { BillingPanel } from "@/components/dashboard/billing-panel"
import { formatDistanceToNow } from "date-fns"

interface BillingData {
  balance: number
  welcomeBonusGrantedAt: string | null
  welcomeBonusAmount: number
  topupMinimum: number
  topUpOrders: Array<{
    id: string
    reference: string
    amount: number
    status: string
    provider: string
    createdAt: string
  }>
  billingTransactions: Array<{
    id: string
    kind: string
    direction: string
    amount: number
    createdAt: string
    description?: string
  }>
}

export function BillingSettings() {
  const [billingData, setBillingData] = useState<BillingData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    const fetchBillingData = async () => {
      setIsLoading(true)
      setError("")

      try {
        const response = await fetch("/api/billing/overview")
        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
          setError(data.error || "Failed to load billing information")
          return
        }

        setBillingData(data)
      } catch (err) {
        console.error("[v0] Failed to fetch billing data:", err)
        setError("Unable to load billing information right now.")
      } finally {
        setIsLoading(false)
      }
    }

    fetchBillingData()
  }, [])

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Spinner className="mr-2" />
          Loading billing information...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const balance = billingData?.balance ?? 0
  const transactions = billingData?.billingTransactions ?? []
  const topUpOrders = billingData?.topUpOrders ?? []

  return (
    <div className="space-y-6">
      {/* Balance Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Balance
          </CardTitle>
          <CardDescription>Your current account balance and recent transactions.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-2">
            <div className="text-4xl font-bold">Rp {balance.toLocaleString("id-ID")}</div>
            <p className="text-sm text-muted-foreground mb-1">IDR</p>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            You have enough balance for approximately {Math.floor(balance / 2000)} generations.
          </p>
        </CardContent>
      </Card>

      {/* Top Up Card */}
      <Card>
        <CardHeader>
          <CardTitle>Add Balance</CardTitle>
          <CardDescription>Top up your account with various payment methods.</CardDescription>
        </CardHeader>
        <CardContent>
          <BillingPanel />
        </CardContent>
      </Card>

      {/* Recent Transactions */}
      {transactions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent Activity</CardTitle>
            <CardDescription>Your last 10 transactions.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {transactions.map((transaction) => (
                <div
                  key={transaction.id}
                  className="flex items-center justify-between rounded-lg border border-border/70 bg-card/50 p-4"
                >
                  <div className="flex items-center gap-3 flex-1">
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-full ${
                        transaction.direction === "in"
                          ? "bg-green-500/10 text-green-600 dark:text-green-400"
                          : "bg-red-500/10 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {transaction.direction === "in" ? (
                        <ArrowDownLeft className="h-5 w-5" />
                      ) : (
                        <ArrowUpRight className="h-5 w-5" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {transaction.kind === "generation"
                          ? "Generation"
                          : transaction.kind === "topup"
                          ? "Top Up"
                          : transaction.description || transaction.kind}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(transaction.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p
                      className={`font-semibold ${
                        transaction.direction === "in"
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {transaction.direction === "in" ? "+" : "-"}Rp{" "}
                      {transaction.amount.toLocaleString("id-ID")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top Up Orders */}
      {topUpOrders.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Top Up Orders</CardTitle>
            <CardDescription>Your recent top-up transactions.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topUpOrders.map((order) => (
                <div
                  key={order.id}
                  className="flex items-center justify-between rounded-lg border border-border/70 bg-card/50 p-4"
                >
                  <div className="flex-1">
                    <p className="font-medium text-sm">{order.reference}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(order.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="font-semibold text-sm">
                        Rp {order.amount.toLocaleString("id-ID")}
                      </p>
                      <Badge
                        variant={
                          order.status === "paid"
                            ? "default"
                            : order.status === "pending"
                            ? "secondary"
                            : "destructive"
                        }
                        className="rounded-full text-xs mt-1"
                      >
                        {order.status}
                      </Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
