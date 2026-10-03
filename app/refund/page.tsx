export default function RefundPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-16 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">Refund Policy</h1>
        <p className="text-sm text-muted-foreground">
          Swift sells digital credits used to run AI generation. Because credits are consumed the moment a
          generation runs, refunds are limited and handled case by case.
        </p>

        <h2 className="pt-4 text-xl font-semibold text-foreground">Eligible refunds</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>A top-up was charged but the credits were never added to your balance.</li>
          <li>The same order was charged twice because of a payment provider error.</li>
          <li>A subscription renewal failed to deliver the plan benefits it paid for.</li>
          <li>A technical fault on our side made the service unusable for a sustained period.</li>
        </ul>

        <h2 className="pt-4 text-xl font-semibold text-foreground">Not eligible</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>Credits that have already been spent on generations, including failed generations.</li>
          <li>Change of mind after a top-up has been credited.</li>
          <li>Partial usage of a subscription period.</li>
          <li>Accounts suspended for violating the terms of service.</li>
        </ul>

        <h2 className="pt-4 text-xl font-semibold text-foreground">How to request a refund</h2>
        <p className="text-sm text-muted-foreground">
          Email <a href="mailto:hello@swift.app" className="text-foreground underline underline-offset-4">hello@swift.app</a>{" "}
          from the account that made the purchase. Include your order reference, the payment method, and a short
          description of the problem.
        </p>

        <h2 className="pt-4 text-xl font-semibold text-foreground">Processing time</h2>
        <p className="text-sm text-muted-foreground">
          Approved refunds are issued within 14 business days to the original payment method. Bank and payment
          provider timelines may add further delays.
        </p>
      </div>
    </main>
  )
}
