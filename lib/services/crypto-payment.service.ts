import { ethers } from "ethers"
import { env } from "@/lib/env"
import { db } from "@/lib/db/client"
import { topUpOrders, cryptoPayments } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { BillingService } from "@/lib/services/billing.service"

export type CryptoChain = "bsc" | "base"

export interface CryptoPaymentRequest {
  reference: string
  amountInUsd: number
  chainId: number
  chainName: string
  senderAddress: string
}

export interface CryptoPaymentResponse {
  checkoutUrl: string
  paymentAddress: string
  amountInToken: string
  chainId: number
  chainName: string
}

function getRpcUrl(chainId: number): string {
  if (chainId === 56 || chainId === env.bnbChainId) {
    return env.bnbRpcUrl
  }
  if (chainId === 8453 || chainId === env.baseChainId) {
    return env.baseRpcUrl
  }
  throw new Error(`Unsupported chain ID: ${chainId}`)
}

function getTokenSymbol(chainId: number): string {
  if (chainId === 56 || chainId === env.bnbChainId) {
    return "BNB"
  }
  if (chainId === 8453 || chainId === env.baseChainId) {
    return "ETH"
  }
  throw new Error(`Unsupported chain ID: ${chainId}`)
}

async function getPriceInUsd(chainId: number): Promise<number> {
  try {
    if (chainId === 56 || chainId === env.bnbChainId) {
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd")
      const data = (await response.json()) as Record<string, Record<string, number>>
      return data.binancecoin?.usd || 600
    }
    if (chainId === 8453 || chainId === env.baseChainId) {
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
      const data = (await response.json()) as Record<string, Record<string, number>>
      return data.ethereum?.usd || 2500
    }
  } catch (error) {
    console.error("Error fetching price:", error)
  }
  return 0
}

export class CryptoPaymentService {
  static async createPaymentRequest(request: CryptoPaymentRequest): Promise<CryptoPaymentResponse> {
    if (!env.cryptoPaymentAddress) {
      throw new Error("Crypto payment address not configured")
    }

    const priceInUsd = await getPriceInUsd(request.chainId)
    if (priceInUsd === 0) {
      throw new Error("Unable to fetch current crypto price")
    }

    const amountInUsd = request.amountInUsd / 100
    const amountInToken = (amountInUsd / priceInUsd).toFixed(6)

    const params = new URLSearchParams({
      ref: request.reference,
      chain: String(request.chainId),
      amount: amountInToken,
      token: getTokenSymbol(request.chainId),
      recipient: env.cryptoPaymentAddress,
      sender: request.senderAddress,
    })

    const checkoutUrl = `${env.appUrl}/api/crypto/checkout?${params.toString()}`

    return {
      checkoutUrl,
      paymentAddress: env.cryptoPaymentAddress,
      amountInToken,
      chainId: request.chainId,
      chainName: request.chainName,
    }
  }

  static async verifyTransaction(
    txHash: string,
    chainId: number,
    expectedAmount: string,
    expectedRecipient: string
  ): Promise<{
    isValid: boolean
    senderAddress: string | null
    actualAmount: string | null
    confirmations: number
    error?: string
  }> {
    try {
      const rpcUrl = getRpcUrl(chainId)
      const provider = new ethers.JsonRpcProvider(rpcUrl)

      const receipt = await provider.getTransactionReceipt(txHash)
      if (!receipt) {
        return {
          isValid: false,
          senderAddress: null,
          actualAmount: null,
          confirmations: 0,
          error: "Transaction not found",
        }
      }

      const tx = await provider.getTransaction(txHash)
      if (!tx) {
        return {
          isValid: false,
          senderAddress: null,
          actualAmount: null,
          confirmations: 0,
          error: "Transaction details not found",
        }
      }

      const currentBlock = await provider.getBlockNumber()
      const confirmations = receipt.blockNumber ? currentBlock - receipt.blockNumber : 0

      if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) {
        return {
          isValid: false,
          senderAddress: tx.from,
          actualAmount: ethers.formatEther(tx.value),
          confirmations,
          error: "Invalid recipient address",
        }
      }

      const actualAmount = ethers.formatEther(tx.value)
      const expectedAmountNum = parseFloat(expectedAmount)
      const actualAmountNum = parseFloat(actualAmount)
      const tolerance = expectedAmountNum * 0.01

      if (Math.abs(actualAmountNum - expectedAmountNum) > tolerance) {
        return {
          isValid: false,
          senderAddress: tx.from,
          actualAmount,
          confirmations,
          error: `Invalid amount. Expected ~${expectedAmount}, got ${actualAmount}`,
        }
      }

      if (receipt.status !== 1) {
        return {
          isValid: false,
          senderAddress: tx.from,
          actualAmount,
          confirmations,
          error: "Transaction failed",
        }
      }

      return {
        isValid: true,
        senderAddress: tx.from,
        actualAmount,
        confirmations,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        isValid: false,
        senderAddress: null,
        actualAmount: null,
        confirmations: 0,
        error: errorMessage,
      }
    }
  }

  static async finalizePayment(topUpOrderId: string, txHash: string): Promise<boolean> {
    try {
      const topUpOrderResult = await db.select().from(topUpOrders)
        .where(eq(topUpOrders.id, topUpOrderId))
        .limit(1)

      if (topUpOrderResult.length === 0) {
        throw new Error("TopUpOrder not found")
      }

      const topUpOrder = topUpOrderResult[0]

      const cryptoPaymentResult = await db.select().from(cryptoPayments)
        .where(eq(cryptoPayments.topUpOrderId, topUpOrderId))
        .limit(1)

      if (cryptoPaymentResult.length === 0) {
        throw new Error("CryptoPayment not found")
      }

      const cryptoPayment = cryptoPaymentResult[0]

      const verification = await this.verifyTransaction(
        txHash,
        topUpOrder.chainId!,
        topUpOrder.tokenAmount || "0",
        env.cryptoPaymentAddress
      )

      if (!verification.isValid) {
        await db.update(cryptoPayments)
          .set({
            status: "failed",
            errorMessage: verification.error,
          })
          .where(eq(cryptoPayments.id, cryptoPayment.id))
        return false
      }

      const confirmationsNeeded = env.cryptoPaymentConfirmationsRequired
      const isConfirmed = verification.confirmations >= confirmationsNeeded

      await db.update(cryptoPayments)
        .set({
          status: isConfirmed ? "confirmed" : "confirming",
          confirmations: verification.confirmations,
          confirmedAt: isConfirmed ? new Date() : null,
        })
        .where(eq(cryptoPayments.id, cryptoPayment.id))

      if (!isConfirmed) {
        return false
      }

      const finalized = await BillingService.finalizeTopUpOrder({
        reference: topUpOrder.reference,
        providerReference: txHash,
        response: JSON.stringify({
          txHash,
          chainId: topUpOrder.chainId,
          tokenAmount: topUpOrder.tokenAmount,
        }),
        amount: topUpOrder.amount,
        paidAt: new Date(),
      })

      await db.update(cryptoPayments)
        .set({
          status: "confirmed",
          confirmations: verification.confirmations,
          confirmedAt: new Date(),
          transactionHash: txHash,
        })
        .where(eq(cryptoPayments.id, cryptoPayment.id))

      if (finalized.order.status !== "paid") {
        throw new Error("FAILED_TO_FINALIZE_CRYPTO_PAYMENT")
      }

      return true
    } catch (error) {
      console.error("Error finalizing crypto payment:", error)
      return false
    }
  }
}
