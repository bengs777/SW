import { NextResponse } from "next/server"

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "This AI route is disabled. Use /api/generate with Swift AI.",
      files: [],
    },
    { status: 410 }
  )
}
