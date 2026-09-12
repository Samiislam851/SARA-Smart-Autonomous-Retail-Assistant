import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateCategories, generateProducts } from "./generate";
import { writeCategoryImages, writeProductImages } from "./images";

/**
 * These assume `npm run seed` has been run at least once (BUILD-DECISIONS
 * §8: seed images are generated and committed, not produced at test time).
 * The functional "skip when present" assertions below exercise the real
 * `images.ts` code path rather than only checking file presence.
 */

const SEED_DIR = path.join(process.cwd(), "public", "products", "seed");
const WEBP_MAGIC = Buffer.from("RIFF", "ascii");

function isValidWebp(filePath: string): boolean {
  const buf = readFileSync(filePath);
  return buf.subarray(0, 4).equals(WEBP_MAGIC) && buf.subarray(8, 12).toString("ascii") === "WEBP";
}

describe("seed images on disk", () => {
  const categories = generateCategories();
  const products = generateProducts(categories);

  it("has a category image on disk for every category, and it's a real webp", () => {
    for (const category of categories) {
      const filePath = path.join(SEED_DIR, path.basename(category.imagePath));
      expect(existsSync(filePath)).toBe(true);
      expect(isValidWebp(filePath)).toBe(true);
    }
  });

  it("has all 3 gallery images on disk for a sample of products, each a real webp", () => {
    const sample = [products[0]!, products[100]!, products[299]!];
    for (const product of sample) {
      expect(product.images).toHaveLength(3);
      for (const imagePath of product.images) {
        const filePath = path.join(SEED_DIR, path.basename(imagePath));
        expect(existsSync(filePath)).toBe(true);
        expect(isValidWebp(filePath)).toBe(true);
      }
    }
  });

  it("writeProductImages / writeCategoryImages skip existing files by default", async () => {
    const categorySummary = await writeCategoryImages(categories);
    expect(categorySummary.written).toBe(0);
    expect(categorySummary.skipped).toBe(categories.length);

    const sample = products.slice(0, 5);
    const productSummary = await writeProductImages(sample);
    expect(productSummary.written).toBe(0);
    expect(productSummary.skipped).toBe(sample.length * 3);
  }, 20000);
});
