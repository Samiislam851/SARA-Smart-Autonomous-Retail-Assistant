/**
 * `npm run seed` — populates the local Docker MongoDB with 10 categories,
 * 300 products, and a handful of users, generates their placeholder images,
 * and ensures every index the storefront depends on.
 *
 * Idempotent: every document's `_id` is derived deterministically from its
 * natural key (slug/email — see `lib/seed/ids.ts`), so re-running upserts in
 * place instead of inserting duplicates. Images already on disk are left
 * alone unless `--force` is passed.
 *
 * Run with `npm run seed` (or `npm run seed -- --force` to regenerate every
 * image). Requires `docker compose up -d` (MONGODB_URI in `.env.local`).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ObjectId, type Collection } from "mongodb";
import { closeMongoClient, getDb } from "@/lib/db/client";
import { ensureIndexes } from "@/lib/db/indexes";
import {
  categorySchema,
  productSchema,
  userSchema,
  type Category,
  type Product,
  type User,
} from "@/lib/schemas";
import { generateCategories, generateProducts, generateUsers } from "@/lib/seed/generate";
import { writeCategoryImages, writeProductImages } from "@/lib/seed/images";

/**
 * This script runs standalone via `tsx`, outside the Next.js server runtime
 * that normally loads `.env.local` for us (see vitest.config.mts's comment
 * on the same gap for tests). A tiny hand-rolled parser is enough — no need
 * for a new dependency just to read `KEY=VALUE` lines.
 */
function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * Re-validates every generated document immediately before it is written —
 * `generate.ts` already validates while building each one, but this is the
 * explicit write-boundary check: fail loudly, with the offending index and
 * natural key named, on the first invalid document instead of inserting it.
 */
function validateOrThrow<T>(
  schema: { parse: (value: unknown) => T },
  items: readonly unknown[],
  label: string,
  keyOf: (value: unknown) => string
): T[] {
  return items.map((item, index) => {
    try {
      return schema.parse(item);
    } catch (error) {
      console.error(`\nSeed validation failed for ${label} #${index} (${keyOf(item)}):`);
      console.error(error);
      process.exit(1);
    }
  });
}

/** The app-shape document uses a hex-string `_id` (see schemas/common.ts); Mongo stores a real `ObjectId`. */
function toMongoDoc<T extends { _id: string }>(doc: T): Omit<T, "_id"> & { _id: ObjectId } {
  const { _id, ...rest } = doc;
  return { _id: new ObjectId(_id), ...rest } as Omit<T, "_id"> & { _id: ObjectId };
}

async function upsertAll<T extends { _id: string }>(
  collection: Collection,
  docs: readonly T[]
): Promise<void> {
  if (docs.length === 0) return;
  await collection.bulkWrite(
    docs.map((doc) => {
      const mongoDoc = toMongoDoc(doc);
      return {
        replaceOne: {
          filter: { _id: mongoDoc._id },
          replacement: mongoDoc,
          upsert: true,
        },
      };
    })
  );
}

async function main(): Promise<void> {
  const start = Date.now();
  loadEnvLocal();
  const force = process.argv.includes("--force");

  console.log(`NextCart seed starting${force ? " (--force: regenerating all images)" : ""}...`);

  const db = await getDb();
  await ensureIndexes(db);

  const categories = validateOrThrow(categorySchema, generateCategories(), "category", (c) => (c as Category).slug);
  const products = validateOrThrow(productSchema, generateProducts(categories), "product", (p) => (p as Product).slug);
  const users = validateOrThrow(userSchema, generateUsers(), "user", (u) => (u as User).email);

  await upsertAll(db.collection("categories"), categories);
  await upsertAll(db.collection("products"), products);
  await upsertAll(db.collection("users"), users);

  const [categoryImages, productImages] = await Promise.all([
    writeCategoryImages(categories, { force }),
    writeProductImages(products, { force }),
  ]);

  const [categoryCount, productCount, userCount] = await Promise.all([
    db.collection("categories").countDocuments(),
    db.collection("products").countDocuments(),
    db.collection("users").countDocuments(),
  ]);

  const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(1);

  console.log("\nNextCart seed complete");
  console.log("-----------------------");
  console.log(`Categories:     ${categoryCount} (expected 10)`);
  console.log(`Products:       ${productCount} (expected 300, 30/category)`);
  console.log(`Users:          ${userCount}`);
  console.log(
    `Images written: ${categoryImages.written + productImages.written} ` +
      `(skipped ${categoryImages.skipped + productImages.skipped} already on disk)`
  );
  console.log(`Elapsed:        ${elapsedSeconds}s`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongoClient();
  });
