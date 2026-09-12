import type { Document, WithId } from "mongodb";
import { categorySchema, type Category } from "@/lib/schemas";
import { getReadyDb } from "./shared";

/** Categories have no `Date` fields, so the DTO is exactly the validated schema type. */
export type CategoryDTO = Category;

function mapCategoryDoc(doc: WithId<Document>): CategoryDTO {
  const { _id, ...rest } = doc;
  return categorySchema.parse({ _id: _id.toString(), ...rest });
}

/** All categories, sorted by `sortOrder` (nav/home rail order), `_id` as a stable tiebreaker. */
export async function listCategories(): Promise<CategoryDTO[]> {
  const db = await getReadyDb();
  const docs = await db
    .collection("categories")
    .find({})
    .sort({ sortOrder: 1, _id: 1 })
    .toArray();
  return docs.map(mapCategoryDoc);
}

export async function getCategoryBySlug(slug: string): Promise<CategoryDTO | null> {
  const db = await getReadyDb();
  const doc = await db.collection("categories").findOne({ slug });
  return doc ? mapCategoryDoc(doc) : null;
}
