import { CartDrawer } from "@/components/CartDrawer"
import { ProductCard } from "@/components/ProductCard"

const sotoMenus = [
  {
    name: "Soto Ayam Lamongan",
    description: "Kuah kuning gurih, ayam suwir, koya, telur, dan jeruk nipis.",
    price: "Rp28.000",
    tag: "Favorit",
    image: "SA",
  },
  {
    name: "Soto Betawi",
    description: "Daging sapi empuk dengan kuah santan susu yang kaya rempah.",
    price: "Rp42.000",
    tag: "Premium",
    image: "SB",
  },
  {
    name: "Soto Kudus",
    description: "Porsi hangat dengan ayam kampung, tauge, seledri, dan bawang goreng.",
    price: "Rp26.000",
    tag: "Ringan",
    image: "SK",
  },
  {
    name: "Soto Mie Bogor",
    description: "Mie kuning, risol renyah, daging, tomat, dan kuah segar.",
    price: "Rp34.000",
    tag: "Komplet",
    image: "SM",
  },
]

const cartItems = [
  { name: "Soto Ayam Lamongan", qty: 2, price: "Rp56.000" },
  { name: "Sate Telur Puyuh", qty: 3, price: "Rp18.000" },
]

const categories = [
  { name: "Soto Ayam", count: "5 menu", color: "bg-[#f6b33b]" },
  { name: "Soto Sapi", count: "4 menu", color: "bg-[#b25726]" },
  { name: "Paket Komplet", count: "6 paket", color: "bg-[#173b2f]" },
  { name: "Lauk Tambahan", count: "9 item", color: "bg-[#5d7f4f]" },
]

const testimonials = [
  {
    name: "Dina Prasetyo",
    role: "Pelanggan rutin",
    quote:
      "Kuahnya masih panas waktu sampai, koya dan sambalnya dipisah rapi. Rasanya seperti makan di warung langganan.",
  },
  {
    name: "Raka Mahendra",
    role: "Order kantor",
    quote:
      "Paket sotonya praktis untuk makan siang tim. Porsi pas, pengiriman cepat, dan semua pesanan lengkap.",
  },
  {
    name: "Maya Sari",
    role: "Ibu rumah tangga",
    quote:
      "Anak-anak suka Soto Ayam Lamongan. Bumbunya gurih tapi tetap ringan, jadi aman buat makan malam keluarga.",
  },
]

const stats = ["25 menit", "4.9 rating", "12 menu"]
const filters = ["Semua", "Ayam", "Sapi", "Komplet"]

const isMenuLoading = false
const isCartLoading = false

const primaryButton =
  "inline-flex min-h-12 items-center justify-center rounded-full bg-[#f6b33b] px-6 py-3 text-sm font-black text-[#173b2f] shadow-sm transition hover:bg-[#ffd36c] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f6b33b]"

export default function LandingPage() {
  const hasMenu = sotoMenus.length > 0

  return (
    <main className="min-h-screen bg-[#fffaf3] text-zinc-950">
      <header className="relative overflow-hidden bg-[#173b2f] text-white">
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-16 bg-[#fffaf3] sm:h-24" />

        <div className="relative mx-auto grid max-w-7xl gap-8 px-4 pb-12 pt-5 sm:px-6 sm:pb-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:px-8 lg:pb-24">
          <nav aria-label="Navigasi utama" className="col-span-full flex items-center justify-between">
            <a
              href="#home"
              aria-label="Soto Online home"
              className="flex items-center gap-3 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#f6b33b]"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f6b33b] text-sm font-black text-[#173b2f]">
                SO
              </span>
              <span>
                <span className="block text-base font-bold">Soto Online</span>
                <span className="block text-xs text-white/65">Masak hangat setiap order</span>
              </span>
            </a>

            <div className="hidden items-center gap-2 sm:flex">
              <a
                href="#menu"
                className="rounded-full px-4 py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f6b33b]"
              >
                Menu
              </a>
              <a href="#order" className={primaryButton}>
                Order
              </a>
            </div>
          </nav>

          <section id="home" aria-labelledby="hero-title" className="max-w-2xl py-4 lg:py-14">
            <p className="mb-4 inline-flex rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-[#f7d58a]">
              Antar cepat untuk makan siang, malam, dan acara keluarga
            </p>

            <h1 id="hero-title" className="text-4xl font-black leading-tight tracking-tight sm:text-6xl">
              Semangkuk soto hangat, dipesan tanpa ribet.
            </h1>

            <p className="mt-5 max-w-xl text-base leading-8 text-white/78 sm:text-lg">
              Pilih varian soto Nusantara favoritmu, tambah lauk pendamping, lalu nikmati kuah
              rempah yang dimasak segar dari dapur kami.
            </p>

            <form
              action="#menu"
              role="search"
              aria-label="Cari menu soto"
              className="mt-8 flex flex-col gap-3 sm:flex-row"
            >
              <label className="flex min-h-14 flex-1 items-center rounded-full bg-white px-5 text-zinc-900 shadow-xl shadow-black/10 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#f6b33b]">
                <span className="sr-only">Cari menu soto</span>
                <input
                  type="search"
                  placeholder="Cari soto ayam, betawi, kudus..."
                  className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-500"
                />
              </label>
              <button type="submit" className={primaryButton}>
                Pesan Sekarang
              </button>
            </form>

            <dl className="mt-8 grid max-w-lg grid-cols-3 gap-3 text-center">
              {stats.map((item) => (
                <div key={item} className="rounded-2xl border border-white/15 bg-white/10 px-3 py-4">
                  <dt className="text-sm font-bold text-[#f7d58a]">{item}</dt>
                  <dd className="mt-1 text-xs text-white/60">Siap dinikmati</dd>
                </div>
              ))}
            </dl>
          </section>

          <aside aria-label="Menu best seller" className="relative mx-auto w-full max-w-lg">
            <div className="aspect-[4/5] rounded-[2rem] bg-[#f7d58a] p-4 shadow-2xl shadow-black/25 sm:p-6">
              <div className="flex h-full flex-col justify-between rounded-[1.5rem] bg-[#fff7e8] p-5 text-zinc-950">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-[#b25726]">Best seller hari ini</p>
                    <h2 className="mt-2 text-2xl font-black leading-tight sm:text-3xl">
                      Soto Betawi Komplet
                    </h2>
                  </div>
                  <span className="rounded-full bg-[#173b2f] px-3 py-1 text-xs font-bold text-white">
                    Hot
                  </span>
                </div>

                <div aria-hidden="true" className="my-6 flex flex-1 items-center justify-center rounded-full bg-[#f6b33b] shadow-inner sm:my-8">
                  <div className="flex h-44 w-44 items-center justify-center rounded-full border-[16px] border-white bg-[#d9662d] text-center text-4xl font-black text-white shadow-2xl sm:h-64 sm:w-64 sm:text-5xl">
                    Soto
                  </div>
                </div>

                <ul className="grid grid-cols-3 gap-2 text-center text-xs font-semibold">
                  {["Daging", "Emping", "Acar"].map((item) => (
                    <li key={item} className="rounded-full bg-white px-3 py-2">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </aside>
        </div>
      </header>

      <section aria-labelledby="category-title" className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#b25726]">Kategori</p>
            <h2 id="category-title" className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">
              Mau yang ringan atau komplet?
            </h2>
          </div>
          <p className="max-w-md text-sm leading-6 text-zinc-600">
            Semua menu dibuat dari kaldu harian, bumbu segar, dan topping yang dikemas terpisah
            supaya teksturnya tetap enak.
          </p>
        </div>

        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {categories.map((category) => (
            <button
              key={category.name}
              type="button"
              className="rounded-3xl border border-[#ecdcc1] bg-white p-5 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-lg active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f6b33b]"
            >
              <span aria-hidden="true" className={`mb-6 block h-3 w-16 rounded-full ${category.color}`} />
              <span className="block text-xl font-black">{category.name}</span>
              <span className="mt-2 block text-sm font-semibold text-zinc-500">{category.count}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="promo-title" className="mx-auto max-w-7xl px-4 pb-12 sm:px-6 lg:px-8">
        <div className="overflow-hidden rounded-[2rem] bg-[#b25726] text-white shadow-xl">
          <div className="grid gap-6 px-5 py-8 sm:px-8 lg:grid-cols-[1fr_260px] lg:items-center lg:px-10">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#f7d58a]">Promo Hari Ini</p>
              <h2 id="promo-title" className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                Hemat Rp20.000 untuk paket keluarga.
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/80">
                Pesan minimal 4 mangkuk soto apa saja dan dapatkan gratis 4 sate telur puyuh.
                Berlaku untuk pengantaran sampai pukul 20.00.
              </p>
            </div>
            <div className="rounded-3xl bg-white/12 p-5 text-center">
              <p className="text-sm text-white/70">Kode promo</p>
              <p className="mt-2 text-3xl font-black text-[#f7d58a]">SOTOFAM</p>
              <button type="button" className={`${primaryButton} mt-5 w-full`}>
                Pakai Promo
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        id="menu"
        aria-labelledby="menu-title"
        className="mx-auto grid max-w-7xl gap-8 px-4 pb-12 sm:px-6 lg:grid-cols-[1fr_360px] lg:px-8 lg:pb-16"
      >
        <div>
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#b25726]">Menu Soto</p>
              <h2 id="menu-title" className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">
                Pilih kuah favoritmu
              </h2>
            </div>
            <div aria-label="Filter menu" className="flex gap-2 overflow-x-auto pb-1">
              {filters.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className="whitespace-nowrap rounded-full border border-[#ead9bd] bg-white px-4 py-2 text-sm font-semibold text-zinc-700 shadow-sm transition hover:border-[#f6b33b] hover:bg-[#fff7e8] active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f6b33b]"
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>

          {isMenuLoading ? (
            <div aria-busy="true" aria-label="Memuat menu soto" className="mt-8 grid gap-5 sm:grid-cols-2">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="overflow-hidden rounded-3xl border border-[#ecdcc1] bg-white">
                  <div className="h-44 animate-pulse bg-[#f1dfc1]" />
                  <div className="space-y-4 p-5">
                    <div className="h-4 w-24 animate-pulse rounded-full bg-zinc-200" />
                    <div className="h-6 w-2/3 animate-pulse rounded-full bg-zinc-200" />
                    <div className="h-4 w-full animate-pulse rounded-full bg-zinc-200" />
                    <div className="h-4 w-4/5 animate-pulse rounded-full bg-zinc-200" />
                    <div className="h-12 animate-pulse rounded-2xl bg-zinc-200" />
                  </div>
                </div>
              ))}
            </div>
          ) : hasMenu ? (
            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              {sotoMenus.map((menu) => (
                <ProductCard key={menu.name} product={menu} />
              ))}
            </div>
          ) : (
            <div className="mt-8 rounded-3xl border border-dashed border-[#d8c5a7] bg-white p-8 text-center">
              <p className="text-lg font-black">Menu belum tersedia</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-600">
                Coba hapus filter pencarian atau cek lagi nanti. Dapur sedang menyiapkan pilihan
                soto baru.
              </p>
              <button type="button" className={`${primaryButton} mt-6`}>
                Reset Filter
              </button>
            </div>
          )}
        </div>

        <CartDrawer items={cartItems} isLoading={isCartLoading} />
      </section>

      <section aria-labelledby="testimonial-title" className="bg-white py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#b25726]">Testimoni</p>
            <h2 id="testimonial-title" className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">
              Kata mereka setelah menyeruput kuah pertama
            </h2>
          </div>

          <div className="mt-8 grid gap-5 lg:grid-cols-3">
            {testimonials.map((testimonial) => (
              <article
                key={testimonial.name}
                className="rounded-3xl border border-[#ecdcc1] bg-[#fffaf3] p-6"
              >
                <div className="flex items-center gap-3">
                  <div
                    aria-hidden="true"
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-[#173b2f] text-sm font-black text-white"
                  >
                    {testimonial.name
                      .split(" ")
                      .map((part) => part[0])
                      .join("")}
                  </div>
                  <div>
                    <h3 className="font-black">{testimonial.name}</h3>
                    <p className="text-sm text-zinc-500">{testimonial.role}</p>
                  </div>
                </div>
                <blockquote className="mt-5 text-sm leading-7 text-zinc-700">
                  {testimonial.quote}
                </blockquote>
                <p aria-label="Rating 5 dari 5" className="mt-5 text-[#f6b33b]">
                  ★★★★★
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="order" aria-labelledby="order-title" className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="rounded-[2rem] bg-[#173b2f] px-5 py-10 text-center text-white shadow-2xl sm:px-10">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#f7d58a]">CTA Order</p>
          <h2 id="order-title" className="mx-auto mt-3 max-w-3xl text-3xl font-black tracking-tight sm:text-5xl">
            Siap pesan soto hangat untuk hari ini?
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-white/75 sm:text-base">
            Pilih menu, cek cart, lalu lanjut checkout. Dapur kami siap masak begitu pesananmu
            masuk.
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <a href="#menu" className={primaryButton}>
              Order Sekarang
            </a>
            <a
              href="#menu"
              className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/25 px-6 py-3 text-sm font-bold text-white transition hover:bg-white/10 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f6b33b]"
            >
              Lihat Semua Menu
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#ecdcc1] bg-[#fff7e8]">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.2fr_0.8fr_0.8fr] lg:px-8">
          <div>
            <a
              href="#home"
              aria-label="Kembali ke bagian utama Soto Online"
              className="inline-flex items-center gap-3 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#f6b33b]"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f6b33b] text-sm font-black text-[#173b2f]">
                SO
              </span>
              <span>
                <span className="block font-black">Soto Online</span>
                <span className="block text-sm text-zinc-500">Soto Nusantara siap antar.</span>
              </span>
            </a>
            <p className="mt-5 max-w-md text-sm leading-7 text-zinc-600">
              Buka setiap hari pukul 09.00-21.00. Cocok untuk makan sendiri, keluarga, arisan,
              sampai pesanan kantor.
            </p>
          </div>

          <address className="not-italic">
            <h2 className="font-black">Kontak</h2>
            <div className="mt-4 space-y-2 text-sm text-zinc-600">
              <p>WhatsApp: 0812-0000-2026</p>
              <p>Email: halo@sotoonline.id</p>
              <p>Jakarta Selatan</p>
            </div>
          </address>

          <div>
            <h2 className="font-black">Layanan</h2>
            <ul className="mt-4 space-y-2 text-sm text-zinc-600">
              <li>Delivery harian</li>
              <li>Catering kantor</li>
              <li>Paket keluarga</li>
            </ul>
          </div>
        </div>
      </footer>
    </main>
  )
}
