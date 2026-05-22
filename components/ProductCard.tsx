type ProductCardProps = {
  product: {
    name: string
    description: string
    price: string
    tag: string
    image: string
  }
}

const buttonClass =
  "inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-[#173b2f] px-4 py-3 text-sm font-bold text-white transition hover:bg-[#235846] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#173b2f]"

export function ProductCard({ product }: ProductCardProps) {
  return (
    <article className="group overflow-hidden rounded-3xl border border-[#ecdcc1] bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-xl">
      <div className="flex min-h-44 items-center justify-center bg-[#f0c36b] p-6">
        <div
          aria-hidden="true"
          className="flex h-28 w-28 items-center justify-center rounded-full border-[12px] border-white bg-[#b25726] text-3xl font-black text-white shadow-lg"
        >
          {product.image}
        </div>
      </div>

      <div className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="rounded-full bg-[#fff2d5] px-3 py-1 text-xs font-bold text-[#9a431b]">
            {product.tag}
          </span>
          <p className="text-base font-black text-[#173b2f]">{product.price}</p>
        </div>

        <h3 className="text-xl font-black">{product.name}</h3>
        <p className="mt-2 min-h-16 text-sm leading-6 text-zinc-600">{product.description}</p>

        <button type="button" className={`${buttonClass} mt-5 group-hover:bg-[#235846]`}>
          Tambah ke Cart
        </button>
      </div>
    </article>
  )
}
