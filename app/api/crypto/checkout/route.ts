import { NextRequest, NextResponse } from "next/server"
import { env } from "@/lib/env"

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const SUPPORTED_CHAINS = new Set(["56", "8453"])

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function toSafeScriptJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

function normalizeAmount(value: string | null) {
  if (!value || value.length > 64) {
    return null
  }

  if (!/^(?:\d+|\d+\.\d+|\.\d+)$/.test(value)) {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 18,
  })
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const ref = searchParams.get("ref")
  const chain = searchParams.get("chain")
  const amount = normalizeAmount(searchParams.get("amount"))
  const recipient = searchParams.get("recipient")

  if (
    !ref ||
    !REFERENCE_PATTERN.test(ref) ||
    !chain ||
    !SUPPORTED_CHAINS.has(chain) ||
    !amount ||
    !recipient ||
    !EVM_ADDRESS_PATTERN.test(recipient)
  ) {
    return new NextResponse("Invalid payment parameters", { status: 400 })
  }

  const chainName = chain === "56" ? "BNB Chain" : chain === "8453" ? "Base" : "Unknown"
  const tokenSymbol = chain === "56" ? "BNB" : chain === "8453" ? "ETH" : "Native"
  const safeRef = escapeHtml(ref)
  const safeAmount = escapeHtml(amount)
  const safeRecipient = escapeHtml(recipient)
  const safeChainName = escapeHtml(chainName)
  const safeTokenSymbol = escapeHtml(tokenSymbol)
  const paymentDataJson = toSafeScriptJson({
    ref,
    recipient,
    appUrl: env.appUrl,
  })

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crypto Payment - Swift</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
    }
    
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    
    .header h1 {
      font-size: 28px;
      margin-bottom: 8px;
      color: #333;
    }
    
    .header p {
      color: #666;
      font-size: 14px;
    }
    
    .payment-details {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 30px;
    }
    
    .detail-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      font-size: 14px;
    }
    
    .detail-row:last-child {
      margin-bottom: 0;
    }
    
    .detail-label {
      color: #666;
    }
    
    .detail-value {
      font-weight: 600;
      color: #333;
      word-break: break-all;
    }
    
    .amount-highlight {
      font-size: 24px !important;
      color: #667eea;
    }
    
    .chain-badge {
      display: inline-block;
      background: #667eea;
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      margin-top: 8px;
    }
    
    .copy-button {
      background: none;
      border: none;
      cursor: pointer;
      color: #667eea;
      font-size: 12px;
      padding: 0;
      margin-left: 8px;
      text-decoration: underline;
    }
    
    .instructions {
      background: #e8f4f8;
      border-left: 4px solid #667eea;
      padding: 16px;
      margin-bottom: 24px;
      border-radius: 4px;
    }
    
    .instructions h3 {
      font-size: 14px;
      margin-bottom: 10px;
      color: #333;
    }
    
    .instructions ol {
      margin-left: 20px;
      font-size: 13px;
      color: #555;
      line-height: 1.6;
    }
    
    .instructions li {
      margin-bottom: 8px;
    }
    
    .transaction-input {
      margin-bottom: 24px;
    }
    
    .transaction-input label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #333;
    }
    
    .transaction-input input {
      width: 100%;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      font-family: monospace;
    }
    
    .transaction-input input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    
    button {
      width: 100%;
      padding: 14px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
    }
    
    button:hover:not(:disabled) {
      background: #5568d3;
    }
    
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    
    .message {
      margin-top: 16px;
      padding: 12px;
      border-radius: 6px;
      font-size: 14px;
      text-align: center;
    }
    
    .message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    
    .message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
    
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #f3f3f3;
      border-top: 2px solid #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 8px;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .footer-text {
      text-align: center;
      font-size: 12px;
      color: #999;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>💳 Send Crypto Payment</h1>
      <p>Complete your top-up order</p>
    </div>
    
    <div class="payment-details">
      <div class="detail-row">
        <span class="detail-label">Reference ID:</span>
        <span class="detail-value">${safeRef}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Amount to send:</span>
        <span class="detail-value amount-highlight">${safeAmount} ${safeTokenSymbol}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Network:</span>
        <span class="detail-value">${safeChainName}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Send to:</span>
        <span class="detail-value">${safeRecipient}
          <button class="copy-button" type="button" id="copyRecipientButton">Copy</button>
        </span>
      </div>
    </div>
    
    <div class="instructions">
      <h3>📋 Instructions:</h3>
      <ol>
        <li>Copy the recipient address above</li>
        <li>Open your wallet (MetaMask, Phantom, Trust Wallet, etc.)</li>
        <li>Switch to ${safeChainName}</li>
        <li>Send exactly <strong>${safeAmount} ${safeTokenSymbol}</strong> to the recipient address</li>
        <li>Paste your transaction hash below</li>
        <li>Click "Verify Payment"</li>
      </ol>
    </div>
    
    <form onsubmit="verifyPayment(event)">
      <div class="transaction-input">
        <label for="txHash">Transaction Hash (0x...):</label>
        <input
          id="txHash"
          type="text"
          placeholder="0x..."
          required
          pattern="^0x[a-fA-F0-9]{64}$"
        />
      </div>
      <button type="submit" id="verifyBtn">Verify Payment</button>
      <div id="message"></div>
    </form>
    
    <div class="footer-text">
      ⏱️ This payment link expires in ${env.cryptoPaymentTimeoutMinutes} minutes
    </div>
  </div>

  <script>
    const paymentData = ${paymentDataJson};

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        alert('Address copied to clipboard!');
      });
    }

    document.getElementById('copyRecipientButton').addEventListener('click', () => {
      copyToClipboard(paymentData.recipient);
    });

    async function verifyPayment(e) {
      e.preventDefault();
      const txHash = document.getElementById('txHash').value;
      const btn = document.getElementById('verifyBtn');
      const msgDiv = document.getElementById('message');
      
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Verifying...';
      msgDiv.textContent = '';
      
      try {
        const response = await fetch('/api/billing/crypto/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topUpOrderId: paymentData.ref,
            transactionHash: txHash,
          }),
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
          msgDiv.className = 'message success';
          msgDiv.textContent = '✅ Payment verified! Your balance will be updated shortly.';
          setTimeout(() => {
            window.location.href = paymentData.appUrl + '/dashboard/settings?tab=billing';
          }, 2000);
        } else {
          msgDiv.className = 'message error';
          msgDiv.textContent = '⏳ Payment received! Waiting for confirmations...';
          btn.disabled = false;
          btn.innerHTML = 'Verify Payment';
        }
      } catch (err) {
        msgDiv.className = 'message error';
        msgDiv.textContent = '❌ Error: ' + (err.message || 'Unknown error');
        btn.disabled = false;
        btn.innerHTML = 'Verify Payment';
      }
    }
  </script>
</body>
</html>
  `

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  })
}
