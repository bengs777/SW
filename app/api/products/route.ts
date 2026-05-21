import { NextRequest, NextResponse } from "next/server"
import { requireAdminActorResponse } from "@/lib/admin"
import { getDatabaseRuntimeDiagnostic } from "@/lib/db/client"
import { ProductService, CreateProductSchema, UpdateProductSchema } from "@/lib/services/product.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function jsonError(error: unknown, fallback: string, status = 500) {
  const database = getDatabaseRuntimeDiagnostic()
  if (!database.ok) {
    return NextResponse.json(
      { error: database.message, diagnostic: database },
      { status: 503 }
    )
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status }
  )
}

export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get("status")
    const limit = Number(request.nextUrl.searchParams.get("limit") || 50)
    const products = await ProductService.listProducts({ status, limit })
    return NextResponse.json({ products, total: products.length })
  } catch (error) {
    return jsonError(error, "Failed to list products")
  }
}

export async function POST(request: NextRequest) {
  const actorResult = await requireAdminActorResponse()
  if ("error" in actorResult) return actorResult.error

  try {
    const body = await request.json().catch(() => null)
    const parsed = CreateProductSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid product payload", issues: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const product = await ProductService.createProduct(parsed.data)
    return NextResponse.json({ product }, { status: 201 })
  } catch (error) {
    return jsonError(error, "Failed to create product")
  }
}

export async function PATCH(request: NextRequest) {
  const actorResult = await requireAdminActorResponse()
  if ("error" in actorResult) return actorResult.error

  try {
    const body = await request.json().catch(() => null) as { id?: unknown; data?: unknown } | null
    const id = typeof body?.id === "string" ? body.id : ""
    const parsed = UpdateProductSchema.safeParse(body?.data)
    if (!id || !parsed.success) {
      return NextResponse.json(
        { error: "Invalid product update payload", issues: parsed.success ? undefined : parsed.error.flatten() },
        { status: 400 }
      )
    }

    const product = await ProductService.updateProduct(id, parsed.data)
    return NextResponse.json({ product })
  } catch (error) {
    return jsonError(error, "Failed to update product")
  }
}

export async function DELETE(request: NextRequest) {
  const actorResult = await requireAdminActorResponse()
  if ("error" in actorResult) return actorResult.error

  try {
    const id = request.nextUrl.searchParams.get("id") || ""
    if (!id) {
      return NextResponse.json({ error: "Product id is required" }, { status: 400 })
    }

    const product = await ProductService.deleteProduct(id)
    return NextResponse.json({ product })
  } catch (error) {
    return jsonError(error, "Failed to delete product")
  }
}
