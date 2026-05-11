import { NextResponse } from "next/server"

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "This AI route is disabled. Use /api/generate with DeepSeek V4 Flash.",
      files: [],
    },
    { status: 410 }
  )
}
