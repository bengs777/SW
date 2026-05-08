const trimEnv = (value: string | undefined) => value?.trim() ?? ""

export const supabaseUrl = trimEnv(process.env.NEXT_PUBLIC_SUPABASE_URL)
export const supabaseAnonKey = trimEnv(
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

export function assertSupabaseConfig() {
  const missing: string[] = []

  if (!supabaseUrl) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL")
  }

  if (!supabaseAnonKey) {
    missing.push(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY"
    )
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required Supabase environment variables: ${missing.join(", ")}`
    )
  }
}