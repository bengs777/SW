type CartDrawerProps = {
  items: Array<{
    name: string
    qty: number
    price: string
  }>
  isLoading?: boolean
}

const primaryButton =
  "inline-flex min-h-12 items-center justify-center rounded-full bg-[#f6b33b] px-6 py-3 text-sm font-black text-[#173b2f] shadow-sm transition hover:bg-[#ffd36c] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f6b33b]"

export function CartDrawer({ items, isLoading = false }: CartDrawerProps) {
  const hasItems = items.length > 0
  const totalItems = items.reduce((total, item) => total + item.qty, 0)

  return (
    <aside
      aria-labelledby="cart-title"
      className="h-fit rounded-3xl border border-[#ecdcc1] bg-white p-5 shadow-lg lg:sticky lg:top-6"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.18em] text-[#b25726]">Cart</p>
          <h2 id="cart-title" className="mt-1 text-2xl font-black">
            Pesananmu
          </h2>
        </div>
        <span className="rounded-full bg-[#173b2f] px-3 py-1 text-sm font-bold text-white">
          {hasItems ? `${totalItems} item` : "0 item"}
        </span>
      </div>

      {isLoading ? (
        <div aria-busy="true" aria-label="Memuat cart" className="mt-6 space-y-4">
          {[1, 2].map((item) => (
            <div key={item} className="rounded-2xl bg-[#fff7e8] p-4">
              <div className="h-5 w-3/4 animate-pulse rounded-full bg-zinc-200" />
              <div className="mt-3 h-4 w-1/3 animate-pulse rounded-full bg-zinc-200" />
            </div>
          ))}
        </div>
      ) : hasItems ? (
        <>
          <ul className="mt-6 space-y-4">
            {items.map((item) => (
              <li
                key={item.name}
                className="flex items-center justify-between gap-4 rounded-2xl bg-[#fff7e8] p-4"
              >
                <div>
                  <p className="font-bold">{item.name}</p>
                  <p className="mt-1 text-sm text-zinc-500">Qty {item.qty}</p>
                </div>
                <p className="text-sm font-black text-[#173b2f]">{item.price}</p>
              </li>
            ))}
          </ul>

          <dl className="mt-6 space-y-3 border-t border-[#ecdcc1] pt-5 text-sm">
            <div className="flex justify-between text-zinc-600">
              <dt>Subtotal</dt>
              <dd>Rp74.000</dd>
            </div>
            <div className="flex justify-between text-zinc-600">
              <dt>Ongkir</dt>
              <dd>Rp8.000</dd>
            </div>
            <div className="flex justify-between text-lg font-black">
              <dt>Total</dt>
              <dd>Rp82.000</dd>
            </div>
          </dl>

          <button type="button" className={`${primaryButton} mt-6 w-full rounded-2xl`}>
            Checkout
          </button>
        </>
      ) : (
        <div className="mt-6 rounded-2xl border border-dashed border-[#d8c5a7] bg-[#fffaf3] p-6 text-center">
          <p className="font-black">Cart masih kosong</p>
          <p className="mt-2 text-sm leading-6 text-zinc-600">
            Tambahkan soto favoritmu untuk melihat ringkasan pesanan di sini.
          </p>
          <a href="#menu" className={`${primaryButton} mt-5`}>
            Pilih Menu
          </a>
        </div>
      )}
    </aside>
  )
}
