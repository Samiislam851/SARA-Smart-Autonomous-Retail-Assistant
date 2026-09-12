import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Category, Product } from "@/lib/schemas";
import { CATEGORY_TEMPLATES } from "./data/categories";
import { buildCategorySvg, buildProductSvg, type GradientColors } from "./svg";

/**
 * Placeholder images are generated as SVG (see `svg.ts` for why) and then
 * rasterized to `.webp` — the only step that touches disk, and the reason
 * this file, unlike the rest of `lib/seed/`, is not covered by a
 * determinism test: image *bytes* depend on the `sharp`/libvips build, only
 * their *content* (what `buildProductSvg`/`buildCategorySvg` emit) is
 * asserted deterministic.
 */

const SEED_IMAGE_DIR = path.join(process.cwd(), "public", "products", "seed");
const FALLBACK_COLORS: GradientColors = { from: "#334155", to: "#64748b" };

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function colorsFor(categorySlug: string): GradientColors {
  return CATEGORY_TEMPLATES.find((t) => t.slug === categorySlug)?.colors ?? FALLBACK_COLORS;
}

async function renderWebp(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
}

/** Runs `fn` over `items` with bounded concurrency — plain rasterization is CPU-bound, unbounded parallelism buys nothing. */
async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
}

export interface ImageWriteSummary {
  written: number;
  skipped: number;
}

export interface WriteImageOptions {
  /** Regenerate even if the file already exists. Default false. */
  force?: boolean;
  concurrency?: number;
}

export async function writeCategoryImages(
  categories: Category[],
  opts: WriteImageOptions = {}
): Promise<ImageWriteSummary> {
  await mkdir(SEED_IMAGE_DIR, { recursive: true });
  let written = 0;
  let skipped = 0;

  await mapWithConcurrency(categories, opts.concurrency ?? 8, async (cat) => {
    const filePath = path.join(SEED_IMAGE_DIR, `${cat.slug}.webp`);
    if (!opts.force && (await fileExists(filePath))) {
      skipped += 1;
      return;
    }
    const svg = buildCategorySvg({ name: cat.name, colors: colorsFor(cat.slug) });
    await writeFile(filePath, await renderWebp(svg));
    written += 1;
  });

  return { written, skipped };
}

export async function writeProductImages(
  products: Product[],
  opts: WriteImageOptions = {}
): Promise<ImageWriteSummary> {
  await mkdir(SEED_IMAGE_DIR, { recursive: true });
  let written = 0;
  let skipped = 0;

  const jobs: { product: Product; index: number }[] = [];
  for (const product of products) {
    for (let i = 0; i < product.images.length; i++) {
      jobs.push({ product, index: i });
    }
  }

  await mapWithConcurrency(jobs, opts.concurrency ?? 8, async ({ product, index }) => {
    const filePath = path.join(SEED_IMAGE_DIR, `${product.slug}-${index + 1}.webp`);
    if (!opts.force && (await fileExists(filePath))) {
      skipped += 1;
      return;
    }
    const svg = buildProductSvg({
      title: product.title,
      index: index + 1,
      total: product.images.length,
      colors: colorsFor(product.categorySlug),
    });
    await writeFile(filePath, await renderWebp(svg));
    written += 1;
  });

  return { written, skipped };
}
