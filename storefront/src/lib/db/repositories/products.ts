import type { Document, Filter, Sort, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import {
  productInputSchema,
  productSchema,
  type Product,
  type ProductInput,
} from "@/lib/schemas";
import {
  PAGE_SIZE,
  getReadyDb,
  isDuplicateKeyError,
  normalizePage,
  skipFor,
  totalPagesFor,
  tryToObjectId,
  type PaginatedResult,
} from "./shared";

export type ProductDTO = Omit<Product, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

function toProductDTO(product: Product): ProductDTO {
  const { createdAt, updatedAt, ...rest } = product;
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

/** Converts a raw Mongo document to the validated, JSON-safe `ProductDTO`. Validates on read, not just on write — seeded data can drift. */
function mapProductDoc(doc: WithId<Document>): ProductDTO {
  const { _id, ...rest } = doc;
  const product = productSchema.parse({ _id: _id.toString(), ...rest });
  return toProductDTO(product);
}

export type ProductSortOption =
  | "relevance"
  | "price-asc"
  | "price-desc"
  | "rating"
  | "newest";

/**
 * `_id` is appended to every sort as a tiebreaker so pagination is stable:
 * without it, ties on price/rating/createdAt can reorder between page 1 and
 * page 2 of the same query and either duplicate or skip a product.
 *
 * `relevance` only means anything when a `$text` query is actually present
 * (the search results are ranked by `$meta: "textScore"`). On the PLP there
 * is no text query to rank against, so `relevance` there explicitly falls
 * back to `newest` — the fallback is a deliberate choice, not an oversight.
 */
function resolveSort(
  sort: ProductSortOption | undefined,
  isTextSearch: boolean
): Sort {
  const effective = sort ?? (isTextSearch ? "relevance" : "newest");
  switch (effective) {
    case "relevance":
      return isTextSearch
        ? { score: { $meta: "textScore" } }
        : { createdAt: -1, _id: -1 };
    case "price-asc":
      return { price: 1, _id: 1 };
    case "price-desc":
      return { price: -1, _id: 1 };
    case "rating":
      return { rating: -1, reviewCount: -1, _id: 1 };
    case "newest":
      return { createdAt: -1, _id: -1 };
  }
}

export async function getProductBySlug(slug: string): Promise<ProductDTO | null> {
  const db = await getReadyDb();
  const doc = await db.collection("products").findOne({ slug, isActive: true });
  return doc ? mapProductDoc(doc) : null;
}

/**
 * Admin lookup by `_id` — active OR inactive, unlike `getProductBySlug`. The
 * admin edit route is `/admin/products/[id]/edit` (BUILD-DECISIONS.md §4):
 * it needs to load a product by its Mongo id to prefill the form, including
 * a product the admin has deactivated, which `getProductBySlug` can never
 * return since it always filters `isActive: true`. Returns null for a
 * malformed id instead of throwing, matching `getUserById`'s convention.
 */
export async function getProductById(id: string): Promise<ProductDTO | null> {
  const objectId = tryToObjectId(id);
  if (!objectId) return null;
  const db = await getReadyDb();
  const doc = await db.collection("products").findOne({ _id: objectId });
  return doc ? mapProductDoc(doc) : null;
}

export interface ListProductsOptions {
  page?: number;
  sort?: ProductSortOption;
}

/** Storefront category listing (PLP). Active products only — §HARD REQUIREMENTS 4. 24 per page. */
export async function listProductsByCategory(
  categorySlug: string,
  options: ListProductsOptions = {}
): Promise<PaginatedResult<ProductDTO>> {
  const db = await getReadyDb();
  const page = normalizePage(options.page);
  const filter: Filter<Document> = { categorySlug, isActive: true };
  const collection = db.collection("products");

  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection
      .find(filter)
      .sort(resolveSort(options.sort, false))
      .skip(skipFor(page))
      .limit(PAGE_SIZE)
      .toArray(),
  ]);

  return {
    items: docs.map(mapProductDoc),
    total,
    page,
    totalPages: totalPagesFor(total),
  };
}

/**
 * `$text` search over the weighted title/brand/description index (§2/§11.10).
 * An empty/whitespace-only query short-circuits before touching Mongo: a
 * bare `$text: { $search: "" }` is a query-shape error, not a zero-result
 * search, so it must never reach the driver.
 */
export async function searchProducts(
  query: string,
  options: ListProductsOptions = {}
): Promise<PaginatedResult<ProductDTO>> {
  const page = normalizePage(options.page);
  const trimmed = query.trim();
  if (!trimmed) {
    return { items: [], total: 0, page, totalPages: 0 };
  }

  const db = await getReadyDb();
  const filter: Filter<Document> = {
    $text: { $search: trimmed },
    isActive: true,
  };
  const sort = resolveSort(options.sort, true);
  // isTextSearch is always true here, so resolveSort's "relevance" branch is
  // exactly when it sorts by { $meta: "textScore" } and needs that field
  // projected. Computed from the input rather than introspected off `sort`
  // (a mongodb `Sort` union doesn't narrow to something with a `.score`).
  const useScoreProjection = options.sort === undefined || options.sort === "relevance";
  const collection = db.collection("products");

  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection
      .find(
        filter,
        useScoreProjection
          ? { projection: { score: { $meta: "textScore" } } }
          : undefined
      )
      .sort(sort)
      .skip(skipFor(page))
      .limit(PAGE_SIZE)
      .toArray(),
  ]);

  return {
    items: docs.map(mapProductDoc),
    total,
    page,
    totalPages: totalPagesFor(total),
  };
}

/** Same-category products, excluding the product itself. Active only. */
export async function getRelatedProducts(
  product: Pick<ProductDTO, "slug" | "categorySlug">,
  limit: number
): Promise<ProductDTO[]> {
  const db = await getReadyDb();
  const docs = await db
    .collection("products")
    .find({
      categorySlug: product.categorySlug,
      isActive: true,
      slug: { $ne: product.slug },
    })
    .sort({ rating: -1, reviewCount: -1, _id: 1 })
    .limit(Math.max(0, Math.floor(limit)))
    .toArray();
  return docs.map(mapProductDoc);
}

export interface AdminProductListOptions {
  query?: string;
  page?: number;
  /** Defaults to false: admin reads default to active-only too, but may opt into seeing inactive products. */
  includeInactive?: boolean;
}

/** Admin product list — may include inactive products; §HARD REQUIREMENTS 4. */
export async function listProductsForAdmin(
  options: AdminProductListOptions = {}
): Promise<PaginatedResult<ProductDTO>> {
  const db = await getReadyDb();
  const page = normalizePage(options.page);
  const trimmed = options.query?.trim();

  const filter: Filter<Document> = {};
  if (!options.includeInactive) filter.isActive = true;
  if (trimmed) filter.$text = { $search: trimmed };

  const collection = db.collection("products");
  const sort: Sort = trimmed
    ? { score: { $meta: "textScore" } }
    : { createdAt: -1, _id: -1 };

  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection
      .find(
        filter,
        trimmed ? { projection: { score: { $meta: "textScore" } } } : undefined
      )
      .sort(sort)
      .skip(skipFor(page))
      .limit(PAGE_SIZE)
      .toArray(),
  ]);

  return {
    items: docs.map(mapProductDoc),
    total,
    page,
    totalPages: totalPagesFor(total),
  };
}

function duplicateSlugError(slug: string): Error {
  return new Error(`A product with slug "${slug}" already exists`);
}

export async function createProduct(input: ProductInput): Promise<ProductDTO> {
  const parsed = productInputSchema.parse(input);
  const db = await getReadyDb();
  const now = new Date();
  const _id = new ObjectId();
  const validated = productSchema.parse({
    _id: _id.toString(),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await db.collection("products").insertOne({ ...validated, _id });
  } catch (error) {
    if (isDuplicateKeyError(error)) throw duplicateSlugError(validated.slug);
    throw error;
  }

  return toProductDTO(validated);
}

/** Full replace of every admin-editable field (§11.7: one input schema for both create and edit). */
export async function updateProduct(
  id: string,
  input: ProductInput
): Promise<ProductDTO | null> {
  const parsed = productInputSchema.parse(input);
  const objectId = tryToObjectId(id);
  if (!objectId) return null;

  const db = await getReadyDb();
  try {
    const result = await db.collection("products").findOneAndUpdate(
      { _id: objectId },
      { $set: { ...parsed, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    return result ? mapProductDoc(result) : null;
  } catch (error) {
    if (isDuplicateKeyError(error)) throw duplicateSlugError(parsed.slug);
    throw error;
  }
}

export async function setProductActive(
  id: string,
  isActive: boolean
): Promise<ProductDTO | null> {
  const objectId = tryToObjectId(id);
  if (!objectId) return null;

  const db = await getReadyDb();
  const result = await db.collection("products").findOneAndUpdate(
    { _id: objectId },
    { $set: { isActive, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return result ? mapProductDoc(result) : null;
}
