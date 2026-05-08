import { createServerClient } from "@supabase/ssr"
import type { User as SupabaseUser } from "@supabase/supabase-js"
import { cookies } from "next/headers"
import type { NextRequest } from "next/server"
import { assertSupabaseConfig, supabaseAnonKey, supabaseUrl } from "./config"

type CookieLike = {
  getAll: () => Array<{ name: string; value: string }>
  set?: (name: string, value: string, options?: unknown) => void
}

function buildServerClient(cookieStore: CookieLike) {
  assertSupabaseConfig()

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set?.(name, value, options)
          })
        } catch {
          // Server components may not allow cookie mutation.
        }
      },
    },
  })
}

function getDisplayName(user: SupabaseUser) {
  const metadata = user.user_metadata as Record<string, unknown> | undefined
  const fullName =
    typeof metadata?.full_name === "string"
      ? metadata.full_name
      : typeof metadata?.name === "string"
        ? metadata.name
        : ""

  if (fullName.trim()) {
    return fullName.trim()
  }

  return user.email?.split("@")[0] || "User"
}

function getAvatarUrl(user: SupabaseUser) {
  const metadata = user.user_metadata as Record<string, unknown> | undefined

  if (typeof metadata?.avatar_url === "string") {
    return metadata.avatar_url
  }

  if (typeof metadata?.picture === "string") {
    return metadata.picture
  }

  return null
}

export function mapSupabaseUserProfile(user: SupabaseUser) {
  return {
    name: getDisplayName(user),
    image: getAvatarUrl(user),
  }
}

export function createSupabaseServerClient() {
  const cookieStore = cookies() as unknown as CookieLike

  return buildServerClient(cookieStore)
}

export function createSupabaseRequestClient(request: NextRequest) {
  const cookieStore: CookieLike = {
    getAll: () => request.cookies.getAll(),
    set: (name, value) => {
      try {
        request.cookies.set(name, value)
      } catch {
        // The proxy runtime may ignore cookie writes here.
      }
    },
  }

  return buildServerClient(cookieStore)
}

export async function getSupabaseUser() {
  const supabase = createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return user ?? null
}

export async function getSupabaseUserFromRequest(request: NextRequest) {
  const supabase = createSupabaseRequestClient(request)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return user ?? null
}