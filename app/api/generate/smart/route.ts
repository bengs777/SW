import { NextResponse } from "next/server"

export const runtime = "nodejs"

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "This AI route is disabled. Use /api/generate with Swift 1, Swift 2, or Swift 3.",
      files: [],
    },
    { status: 410 }
  )
}
