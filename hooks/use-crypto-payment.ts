import { useState } from "react"
import { useToast } from "@/hooks/use-toast"
import { MIN_CRYPTO_PAYMENT_USD, MIN_CRYPTO_PAYMENT_USD_CENTS, TOPUP_MINIMUM_IDR } from "@/lib/billing/constants"
import { type BillingPlanId, type BillingPurchaseType } from "@/lib/billing/plans"

interface CryptoPaymentRequest {
  amountInUsd: number
  chainId: number
  purchaseType?: BillingPurchaseType
  planId?: BillingPlanId
  workspaceId?: string
  source?: string
  note?: string
}

interface CryptoPaymentResponse {
  orderId: string
  reference: string
  checkoutUrl: string
  paymentAddress: string
  amountInToken: string
  chainId: number
  chainName: string
  expiresAt: string
}

export function useCryptoPayment() {
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)

  const createPaymentRequest = async (
    amountInUsd: number,
    chainId: number,
    extraData?: Omit<CryptoPaymentRequest, "amountInUsd" | "chainId">
  ): Promise<CryptoPaymentResponse | null> => {
    if (!amountInUsd || amountInUsd < MIN_CRYPTO_PAYMENT_USD_CENTS) {
      toast({
        title: "Invalid Amount",
        description: `Minimum payment is Rp ${TOPUP_MINIMUM_IDR.toLocaleString("id-ID")} (~${MIN_CRYPTO_PAYMENT_USD.toFixed(2)} USDT)`,
        variant: "destructive",
      })
      return null
    }

    setIsLoading(true)
    try {
      const response = await fetch("/api/billing/crypto/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountInUsd,
          chainId,
          ...extraData,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to create payment request")
      }

      const data = (await response.json()) as CryptoPaymentResponse
      return data
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      toast({
        title: "Payment Error",
        description: message,
        variant: "destructive",
      })
      return null
    } finally {
      setIsLoading(false)
    }
  }

  const openCheckout = async (
    amountInUsd: number,
    chainId: number,
    extraData?: Omit<CryptoPaymentRequest, "amountInUsd" | "chainId">
  ): Promise<void> => {
    const response = await createPaymentRequest(amountInUsd, chainId, extraData)
    if (response) {
      // Open checkout page in new window or redirect
      window.open(response.checkoutUrl, "_blank")
    }
  }

  return {
    isLoading,
    createPaymentRequest,
    openCheckout,
  }
}
