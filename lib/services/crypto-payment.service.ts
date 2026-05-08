import { ethers } from "ethers"
import { env } from "@/lib/env"
import { prisma } from "@/lib/db/client"
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

function getChainName(chainId: number): string {
  if (chainId === 56 || chainId === env.bnbChainId) {
    return "BNB Chain"
  }
  if (chainId === 8453 || chainId === env.baseChainId) {
    return "Base"
  }
  throw new Error(`Unsupported chain ID: ${chainId}`)
}

function getTokenSymbol(chainId: number): string {
  return "Native" // ETH for Base, BNB for BSC
}

async function getPriceInUsd(chainId: number): Promise<number> {
  try {
    if (chainId === 56 || chainId === env.bnbChainId) {
      // BNB price - using CoinGecko free API
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd")
      const data = (await response.json()) as Record<string, Record<string, number>>
      return data.binancecoin?.usd || 600 // fallback price
    }
    if (chainId === 8453 || chainId === env.baseChainId) {
      // ETH price
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
      const data = (await response.json()) as Record<string, Record<string, number>>
      return data.ethereum?.usd || 2500 // fallback price
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

    // Convert USD to token (assuming price in USD cents input)
    const amountInUsd = request.amountInUsd / 100 // convert from cents
    const amountInToken = (amountInUsd / priceInUsd).toFixed(6)

    // Generate checkout URL (simple payment page)
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

      // Validate recipient
      if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) {
        return {
          isValid: false,
          senderAddress: tx.from,
          actualAmount: ethers.formatEther(tx.value),
          confirmations,
          error: "Invalid recipient address",
        }
      }

      // Validate amount (with small tolerance for gas)
      const actualAmount = ethers.formatEther(tx.value)
      const expectedAmountNum = parseFloat(expectedAmount)
      const actualAmountNum = parseFloat(actualAmount)
      const tolerance = expectedAmountNum * 0.01 // 1% tolerance

      if (Math.abs(actualAmountNum - expectedAmountNum) > tolerance) {
        return {
          isValid: false,
          senderAddress: tx.from,
          actualAmount,
          confirmations,
          error: `Invalid amount. Expected ~${expectedAmount}, got ${actualAmount}`,
        }
      }

      // Check if transaction succeeded
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
      const topUpOrder = await prisma.topUpOrder.findUnique({
        where: { id: topUpOrderId },
        include: { user: true, cryptoPayment: true },
      })

      if (!topUpOrder || !topUpOrder.cryptoPayment) {
        throw new Error("TopUpOrder or CryptoPayment not found")
      }

      const verification = await this.verifyTransaction(
        txHash,
        topUpOrder.chainId!,
        topUpOrder.tokenAmount || "0",
        env.cryptoPaymentAddress
      )

      if (!verification.isValid) {
        await prisma.cryptoPayment.update({
          where: { id: topUpOrder.cryptoPayment.id },
          data: {
            status: "failed",
            errorMessage: verification.error,
          },
        })
        return false
      }

      const confirmationsNeeded = env.cryptoPaymentConfirmationsRequired
      const isConfirmed = verification.confirmations >= confirmationsNeeded

      // Update CryptoPayment record
      await prisma.cryptoPayment.update({
        where: { id: topUpOrder.cryptoPayment.id },
        data: {
          status: isConfirmed ? "confirmed" : "confirming",
          confirmations: verification.confirmations,
          blockNumber: undefined, // Will be set by webhook if needed
          confirmedAt: isConfirmed ? new Date() : null,
        },
      })

      if (!isConfirmed) {
        return false // Still waiting for confirmations
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

      await prisma.cryptoPayment.update({
        where: { id: topUpOrder.cryptoPayment.id },
        data: {
          status: "confirmed",
          confirmations: verification.confirmations,
          blockNumber: undefined,
          confirmedAt: new Date(),
          transactionHash: txHash,
        },
      })

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
