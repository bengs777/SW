import { db } from "@/lib/db/client"
import { products } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"
import { z } from "zod"
import { withDatabaseWriteRetry } from "@/lib/db/errors"
import { log } from "@/lib/logging"

export const ProductStatusSchema = z.enum(["draft", "ready", "featured", "archived"])

export const CreateProductSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000),
  area: z.string().trim().min(1).max(160).default("Online"),
  price: z.number().int().nonnegative(),
  status: ProductStatusSchema.default("draft"),
  ownerId: z.string().trim().min(1).nullable().optional(),
})

export const UpdateProductSchema = CreateProductSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one product field is required"
)

export type CreateProductInput = z.infer<typeof CreateProductSchema>
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>

function classifyDatabaseError(error: unknown) {
  return {
    code: "UNKNOWN_DB_ERROR",
    message: error instanceof Error ? error.message : String(error),
    meta: null,
  }
}

function logProductDbFailure(operation: string, error: unknown) {
  log("error", "product_crud_failed", {
    operation,
    database: classifyDatabaseError(error),
  })
}

export class ProductService {
  static async listProducts(input: { status?: string | null; limit?: number } = {}) {
    try {
      const limit = Math.min(Math.max(input.limit || 50, 1), 100)
      const status = input.status ? ProductStatusSchema.safeParse(input.status) : null

      const query = db.select().from(products)
        .orderBy(desc(products.createdAt))
        .limit(limit)

      if (status?.success) {
        return query.where(eq(products.status, status.data))
      }

      return query
    } catch (error) {
      logProductDbFailure("listProducts", error)
      throw error
    }
  }

  static async createProduct(input: CreateProductInput) {
    const parsed = CreateProductSchema.parse(input)
    try {
      return await withDatabaseWriteRetry(() =>
        db.insert(products).values({ id: crypto.randomUUID(), ...parsed }).returning()
      )
    } catch (error) {
      logProductDbFailure("createProduct", error)
      throw error
    }
  }

  static async updateProduct(id: string, input: UpdateProductInput) {
    const productId = z.string().trim().min(1).parse(id)
    const parsed = UpdateProductSchema.parse(input)
    try {
      return await withDatabaseWriteRetry(() =>
        db.update(products)
          .set(parsed)
          .where(eq(products.id, productId))
          .returning()
      )
    } catch (error) {
      logProductDbFailure("updateProduct", error)
      throw error
    }
  }

  static async deleteProduct(id: string) {
    const productId = z.string().trim().min(1).parse(id)
    try {
      return await withDatabaseWriteRetry(() =>
        db.delete(products)
          .where(eq(products.id, productId))
          .returning()
      )
    } catch (error) {
      logProductDbFailure("deleteProduct", error)
      throw error
    }
  }
}
