"use client"

import { createBrowserClient } from "@supabase/ssr"
import { assertSupabaseConfig, supabaseAnonKey, supabaseUrl } from "./config"

export function createSupabaseBrowserClient() {
  assertSupabaseConfig()

  return createBrowserClient(supabaseUrl, supabaseAnonKey)
}