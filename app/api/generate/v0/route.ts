import { NextResponse } from "next/server"

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "This AI route is disabled. Use /api/generate, which is locked to OpenRouter and deepseek/deepseek-v4-flash.",
      files: [],
    },
    { status: 410 }
  )
}
