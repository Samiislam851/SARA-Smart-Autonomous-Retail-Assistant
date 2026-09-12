import {
  categorySchema,
  DEFAULT_CURRENCY,
  productSchema,
  userSchema,
  type Category,
  type Product,
  type ProductVariant,
  type User,
  type VariantType,
} from "@/lib/schemas";
import {
  AUTHOR_FIRST_NAMES,
  AUTHOR_LAST_NAMES,
  BOOK_CLOSING_FRAGMENTS,
  BOOK_GENRE_SENTENCES,
  BOOK_GENRES,
  type BookGenreConfig,
} from "./data/books";
import {
  CATEGORY_TEMPLATES,
  CLOSING_FRAGMENTS,
  CLOTHING_SIZES,
  COLOUR_PALETTE,
  FOOTWEAR_SIZES,
  type CategoryTemplate,
  type ProductLineTemplate,
  type VariantPolicy,
} from "./data/categories";
import { deterministicHexId } from "./ids";
import { SeededRng } from "./rng";

/**
 * `generateProducts()` seeds its own `SeededRng` from this fixed constant
 * rather than sharing a mutable instance with anything else. That is what
 * makes it independently deterministic: calling it twice, in any order
 * relative to `generateCategories()` / `generateUsers()`, always replays the
 * exact same sequence of draws. Categories and users are hand-authored lists
 * (no randomness), so they need no seed of their own.
 */
const PRODUCT_SEED = 2000;

const PRODUCTS_PER_CATEGORY = 30;
const IMAGES_PER_PRODUCT = 3;
const SEED_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/**
 * Casing fixups applied after generic title-casing, for units/acronyms that
 * title-case mangles. Every entry here exists because a real generated title
 * read wrong without it — "External Ssd 1tb", "Hiking Backpack 30l",
 * "Fishing Rod And Reel Combo", "Eau De Parfum".
 */
const WORD_FIXUPS: [RegExp, string][] = [
  [/\bUsb-c\b/gi, "USB-C"],
  [/\bUsb\b/gi, "USB"],
  [/\bSpf\b/gi, "SPF"],
  [/\b4k\b/gi, "4K"],
  [/\bHdr\b/gi, "HDR"],
  [/\bStem\b/gi, "STEM"],
  [/\bQhd\b/gi, "QHD"],
  [/\bIps\b/gi, "IPS"],
  [/\bSsd\b/gi, "SSD"],
  [/\bHdd\b/gi, "HDD"],
  [/(\d)\s?tb\b/gi, "$1TB"],
  [/(\d)\s?gb\b/gi, "$1GB"],
  [/(\d)\s?l\b/g, "$1L"],
  [/(\d)v\b/gi, "$1V"],
  [/\bLed\b/gi, "LED"],
];

/**
 * Words that stay lowercase inside a title unless they lead it — "Fishing Rod
 * and Reel Combo", "USB-C Hub 7-in-1", "Eau de Parfum". Title-casing every
 * token is the single most visible generated-text tell after grammar.
 */
const TITLE_MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "de", "for", "in", "nor", "of",
  "on", "or", "per", "the", "to", "vs", "with",
]);

function applyWordFixups(text: string): string {
  return WORD_FIXUPS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/**
 * Title-cases a lowercase, possibly hyphen/space-separated phrase. Every
 * word/hyphen-segment is capitalized *except* one from `TITLE_MINOR_WORDS`
 * that isn't the very first token of the phrase — so "fishing rod and reel
 * combo" reads "Fishing Rod and Reel Combo", not "... And Reel ...", and
 * "usb-c hub 7-in-1" keeps its "in" lowercase.
 */
export function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word, wordIndex) =>
      word
        .split("-")
        .map((part, partIndex) => {
          if (!part.length) return part;
          const isLeading = wordIndex === 0 && partIndex === 0;
          if (!isLeading && TITLE_MINOR_WORDS.has(part.toLowerCase())) {
            return part.toLowerCase();
          }
          return part[0]!.toUpperCase() + part.slice(1);
        })
        .join("-")
    )
    .join(" ");
}

/** Lowercase, hyphenated slug from arbitrary title text — matches `slugSchema`. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Appends `-2`, `-3`, ... until the slug is not already in `used`, then reserves it. */
function uniqueSlug(base: string, used: Set<string>): string {
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

const TITLE_FINGERPRINT_STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "in", "on", "for", "to", "with", "from", "at", "by",
]);

/**
 * Order-independent bag-of-words key for a title, used to catch
 * near-duplicates that a plain string/slug comparison misses — e.g. the
 * poetry genre's `{Word1} and {Word2}` template independently drew "Moonlight
 * and Dust" for one book and "Dust and Moonlight" for another: different
 * strings, different slugs, but the exact same title to a shopper. A
 * fixed-order title (brand, then adjective, then noun, then suffix — see
 * `composeProductTitle`) can never collide on a fingerprint without also
 * colliding on the exact string, so this is a strict superset of exact-title
 * dedup, not a separate, riskier check.
 */
export function titleFingerprint(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !TITLE_FINGERPRINT_STOPWORDS.has(word))
    .sort()
    .join(" ");
}

/**
 * Retries `makeTitle()` (which must consume `rng`, so every retry is still
 * deterministic) until it returns a title whose fingerprint hasn't been used
 * yet in this run, then reserves that fingerprint. 30 attempts is generous
 * for the actual collision rate (a handful of titles in 300, mostly a
 * no-adjective/no-suffix line drawing the same brand twice) — exhausting it
 * indicates a genuinely too-small word pool for a line, which should fail
 * loudly rather than silently ship a duplicate.
 */
function generateUniqueTitle(
  makeTitle: () => string,
  usedFingerprints: Set<string>,
  context: string
): string {
  const maxAttempts = 30;
  let title = makeTitle();
  for (let attempt = 1; attempt < maxAttempts && usedFingerprints.has(titleFingerprint(title)); attempt++) {
    title = makeTitle();
  }
  const fingerprint = titleFingerprint(title);
  if (usedFingerprints.has(fingerprint)) {
    throw new Error(
      `generateProducts: could not produce a unique title for ${context} after ${maxAttempts} attempts (last try: "${title}")`
    );
  }
  usedFingerprints.add(fingerprint);
  return title;
}

function interpolate(template: string, brand: string, noun: string): string {
  return template
    .replaceAll("{brand}", brand)
    .replaceAll("{Noun}", titleCase(noun))
    .replaceAll("{noun}", noun);
}

function composeProductTitle(
  rng: SeededRng,
  brand: string,
  line: ProductLineTemplate,
  suffixes: readonly string[]
): string {
  const words: string[] = [brand];
  // Drop any adjective that shares a word with the noun — e.g. "true
  // wireless" in front of "wireless earbuds" reads "True Wireless Wireless
  // Earbuds", a doubled word that is an instant "machine-generated" tell.
  const nounWords = new Set(line.noun.toLowerCase().split(/\s+/));
  const eligibleAdjectives = line.adjectives.filter(
    (adj) => !adj.toLowerCase().split(/\s+/).some((word) => nounWords.has(word))
  );
  if (eligibleAdjectives.length > 0 && rng.chance(0.55)) {
    words.push(titleCase(rng.pick(eligibleAdjectives)));
  }
  words.push(titleCase(line.noun));
  if (suffixes.length > 0 && rng.chance(0.45)) {
    words.push(rng.pick(suffixes));
  }
  return applyWordFixups(words.join(" "));
}

/**
 * One `fragmentsA` template (electronics' 3rd option) has a trailing pronoun
 * the generic regex below can't reach: "...from the moment you unbox it."
 * Hand-corrected the same way `PLURAL_SENTENCE_OVERRIDES` covers fragmentsB/C.
 */
const PLURAL_TEMPLATE_OVERRIDES: Record<string, string> = {
  "{brand} designed this {noun} to feel effortless from the moment you unbox it.":
    "{brand} designed these {noun} to feel effortless from the moment you unbox them.",
};

/**
 * Agrees a `fragmentsA` template for a plural noun — both the head
 * determiner and the verb. Every template opens either "The {brand} {noun}
 * <verb> ..." (where "The" needs no change), "This {brand} {noun} <verb>
 * ..." (where "This" -> "These"), or "{brand} <verb> this {noun} ..." (where
 * the object "this" -> "these"; the verb there is governed by `{brand}`, a
 * singular company name, so it never needs to change). Without this you get
 * "The Wavecrest wireless earbuds *is* built for..." — the single most
 * obvious "this was generated" tell on a PDP.
 */
function agreeTemplateForPlural(template: string): string {
  const override = PLURAL_TEMPLATE_OVERRIDES[template];
  if (override) return override;

  return template
    .replace(/\bThis\b(?=\s+(?:\{brand\}\s+)?\{noun\})/, "These")
    .replace(/\bthis\b(?=\s+\{noun\})/, "these")
    .replace(/(\{Noun\}|\{noun\}) (\S+)/, (_match, nounToken: string, verb: string) => {
      if (/^is$/i.test(verb)) return `${nounToken} ${verb[0] === "I" ? "Are" : "are"}`;
      if (/^has$/i.test(verb)) return `${nounToken} ${verb[0] === "H" ? "Have" : "have"}`;
      if (/s$/i.test(verb)) return `${nounToken} ${verb.slice(0, -1)}`;
      return `${nounToken} ${verb}`;
    });
}

/**
 * `fragmentsB`/`fragmentsC`/`CLOSING_FRAGMENTS` are generic, hand-authored
 * sentences that refer back to the product with "it"/"its" rather than
 * repeating `{noun}`. `agreeTemplateForPlural` can't reach those (there's no
 * `{noun}` token to anchor on), so plural-noun lines swap in a hand-checked
 * "they"/"them" rewrite of the specific sentences that actually need it.
 * Every other fragment in the shared pools has no product-referring pronoun
 * and is safe to reuse unchanged for a plural line.
 */
const PLURAL_SENTENCE_OVERRIDES: Record<string, string> = {
  "A long-lasting battery and a stable wireless connection keep it ready whenever you need it.":
    "A long-lasting battery and a stable wireless connection keep them ready whenever you need them.",
  "Setup takes minutes, and it works out of the box with most phones and laptops.":
    "Setup takes minutes, and they work out of the box with most phones and laptops.",
  "Firmware updates arrive automatically, so it keeps getting better after you buy it.":
    "Firmware updates arrive automatically, so they keep getting better after you buy them.",
  "It cleans up easily after busy weeknight dinners and holiday cooking alike.":
    "They clean up easily after busy weeknight dinners and holiday cooking alike.",
  "Compact storage dimensions mean it won't take over your cabinets.":
    "Compact storage dimensions mean they won't take over your cabinets.",
  "A tailored fit and durable stitching keep it looking sharp wash after wash.":
    "A tailored fit and durable stitching keep them looking sharp wash after wash.",
  "Designed alongside real feedback from people who wear it every day.":
    "Designed alongside real feedback from people who wear them every day.",
  "Machine washable and colourfast, so it keeps its shape and shade wash after wash.":
    "Machine washable and colourfast, so they keep their shape and shade wash after wash.",
  "Resealable packaging keeps it fresh long after the first use.":
    "Resealable packaging keeps them fresh long after the first use.",
  "A dependable pick for everyday use, with support available if you ever need it.":
    "A dependable pick for everyday use, with support available if you ever need them.",
  "Thousands of shoppers have already made it part of their routine.":
    "Thousands of shoppers have already made them part of their routine.",
};

function agreeSentenceForPlural(sentence: string): string {
  return PLURAL_SENTENCE_OVERRIDES[sentence] ?? sentence;
}

function composeDescription(
  rng: SeededRng,
  cat: CategoryTemplate,
  brand: string,
  noun: string,
  plural: boolean
): string {
  const fragmentA = plural ? agreeTemplateForPlural(rng.pick(cat.fragmentsA)) : rng.pick(cat.fragmentsA);
  const fragmentB = plural ? agreeSentenceForPlural(rng.pick(cat.fragmentsB)) : rng.pick(cat.fragmentsB);
  const sentences: string[] = [interpolate(fragmentA, brand, noun), interpolate(fragmentB, brand, noun)];
  if (cat.fragmentsC.length > 0 && rng.chance(0.7)) {
    const fragmentC = plural ? agreeSentenceForPlural(rng.pick(cat.fragmentsC)) : rng.pick(cat.fragmentsC);
    sentences.push(interpolate(fragmentC, brand, noun));
  }
  if (rng.chance(0.5)) {
    const closingPool = cat.closingFragments ?? CLOSING_FRAGMENTS;
    const closing = plural ? agreeSentenceForPlural(rng.pick(closingPool)) : rng.pick(closingPool);
    sentences.push(closing);
  }
  return applyWordFixups(sentences.join(" "));
}

/** Resolves `{Token}` placeholders against per-genre word pools, avoiding an obviously repeated word (e.g. "Salt and Salt"). */
function resolveBookTemplate(rng: SeededRng, template: string, tokens: Record<string, string[]>): string {
  const used = new Set<string>();
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const pool = tokens[key];
    if (!pool || pool.length === 0) {
      throw new Error(`Unknown or empty book title token "{${key}}"`);
    }
    let value = rng.pick(pool);
    if (used.has(value) && pool.length > 1) {
      value = rng.pick(pool.filter((candidate) => candidate !== value));
    }
    used.add(value);
    return value;
  });
}

function buildBookDescription(rng: SeededRng, config: BookGenreConfig): string {
  const pool = config.descriptionFragments;
  const first = rng.pick(pool);
  const sentences = [first];
  if (rng.chance(0.65)) {
    const remaining = pool.filter((f) => f !== first);
    if (remaining.length > 0) sentences.push(rng.pick(remaining));
  }
  if (rng.chance(0.4)) {
    // Books get their own closers — the generic pool talks about warranties
    // and surviving daily use, which reads as absurd under a novel.
    sentences.push(rng.pick(BOOK_CLOSING_FRAGMENTS));
  }
  // Evocative titles like "The Weeknight Kitchen" never contain the genre
  // word itself — always naming it here is what makes a plain-language
  // `$text` search like "cookbook" or "novel" find these products at all.
  // Drawn from a pool of frames, not one fixed sentence, so 30 books do not
  // all end on an identical line.
  sentences.push(rng.pick(BOOK_GENRE_SENTENCES).replace("{label}", config.searchLabel));
  return sentences.join(" ");
}

function priceEndingIn99(rng: SeededRng, min: number, max: number): number {
  const minDollars = Math.ceil(min / 100);
  const maxDollars = Math.floor(max / 100);
  if (minDollars > maxDollars) {
    // Range narrower than $1 (shouldn't happen with our data, but stay safe).
    return rng.int(min, max);
  }
  const dollars = rng.int(minDollars, maxDollars);
  const price = dollars * 100 - 1;
  return Math.max(min, Math.min(max, price));
}

function ratingFor(rng: SeededRng): number {
  return rng.float1(3.2, 4.9);
}

/** Review counts skew low with an occasional bestseller, nudged up by rating. */
function reviewCountFor(rng: SeededRng, rating: number): number {
  const popularity = rng.next() ** 1.5;
  const ratingBoost = 0.5 + (rating - 3.2) / 1.7; // ~0.5..1.5
  return Math.min(50_000, Math.round(popularity * 4000 * ratingBoost));
}

/** Mostly healthy stock, a slice out of stock, a slice running low. */
function stockFor(rng: SeededRng): number {
  const roll = rng.next();
  if (roll < 0.06) return 0;
  if (roll < 0.16) return rng.int(1, 5);
  return rng.int(6, 500);
}

function isActiveFor(rng: SeededRng): boolean {
  return rng.chance(0.95);
}

function buildVariants(
  rng: SeededRng,
  policy: VariantPolicy,
  colourChance = 0.65,
  sizeScale: "apparel" | "footwear" = "apparel",
  palette: readonly { label: string; value: string }[] = COLOUR_PALETTE
): ProductVariant[] {
  const colourGroup = (): ProductVariant[] =>
    rng
      .shuffle(palette)
      .slice(0, rng.int(2, 4))
      .map((c) => ({ type: "colour" as VariantType, label: c.label, value: c.value, available: rng.chance(0.85) }));

  if (policy === "none") return [];

  if (policy === "size-colour") {
    // Footwear takes numeric US sizes; S/M/L/XL on a running shoe reads as
    // machine-made (categories.ts's `sizeScale` doc comment).
    const sizePool = sizeScale === "footwear" ? FOOTWEAR_SIZES : CLOTHING_SIZES;
    const sizes: ProductVariant[] = sizePool.map((s) => ({
      type: "size" as VariantType,
      label: s.label,
      value: s.value,
      available: rng.chance(0.85),
    }));
    return [...sizes, ...colourGroup()];
  }

  // policy === "colour": each product independently rolls whether it gets colour options at all.
  return rng.chance(colourChance) ? colourGroup() : [];
}

export function generateCategories(): Category[] {
  return CATEGORY_TEMPLATES.map((cat) =>
    categorySchema.parse({
      _id: deterministicHexId("category", cat.slug),
      slug: cat.slug,
      name: cat.name,
      description: cat.description,
      imagePath: `/products/seed/${cat.slug}.webp`,
      sortOrder: cat.sortOrder,
    })
  );
}

export function generateProducts(categories: Category[]): Product[] {
  const rng = new SeededRng(PRODUCT_SEED);
  const usedSlugs = new Set<string>();
  const usedTitleFingerprints = new Set<string>();
  const products: Product[] = [];

  for (const catTemplate of CATEGORY_TEMPLATES) {
    const category = categories.find((c) => c.slug === catTemplate.slug);
    if (!category) {
      throw new Error(`generateProducts: no category generated for template "${catTemplate.slug}"`);
    }
    const lineCount = catTemplate.productLines.length;

    for (let i = 0; i < PRODUCTS_PER_CATEGORY; i++) {
      const line = catTemplate.productLines[i % lineCount]!;
      const isBooks = catTemplate.slug === "books";

      let title: string;
      let brand: string;
      let description: string;

      if (isBooks) {
        const genreConfig = BOOK_GENRES[line.noun];
        if (!genreConfig) {
          throw new Error(`generateProducts: no book genre config for "${line.noun}"`);
        }
        title = generateUniqueTitle(
          () => resolveBookTemplate(rng, rng.pick(genreConfig.titleTemplates), genreConfig.tokens),
          usedTitleFingerprints,
          `book "${line.noun}" #${i}`
        );
        brand = `${rng.pick(AUTHOR_FIRST_NAMES)} ${rng.pick(AUTHOR_LAST_NAMES)}`;
        description = buildBookDescription(rng, genreConfig);
      } else {
        brand = rng.pick(catTemplate.brands);
        title = generateUniqueTitle(
          () => composeProductTitle(rng, brand, line, catTemplate.suffixes),
          usedTitleFingerprints,
          `product "${line.noun}" #${i}`
        );
        description = composeDescription(rng, catTemplate, brand, line.noun, line.plural ?? false);
      }

      const slug = uniqueSlug(slugify(title), usedSlugs);
      const price = priceEndingIn99(rng, line.priceRange[0], line.priceRange[1]);
      const rating = ratingFor(rng);
      const policy = line.variant ?? catTemplate.variantPolicy;
      const createdAt = new Date(SEED_EPOCH.getTime() + products.length * 86_400_000);

      const images = Array.from(
        { length: IMAGES_PER_PRODUCT },
        (_, idx) => `/products/seed/${slug}-${idx + 1}.webp`
      );

      products.push(
        productSchema.parse({
          _id: deterministicHexId("product", slug),
          slug,
          title,
          brand,
          description,
          categorySlug: category.slug,
          price,
          currency: DEFAULT_CURRENCY,
          images,
          rating,
          reviewCount: reviewCountFor(rng, rating),
          stock: stockFor(rng),
          isActive: isActiveFor(rng),
          variants: buildVariants(rng, policy, line.colourChance, line.sizeScale, line.colours),
          createdAt,
          updatedAt: createdAt,
        })
      );
    }
  }

  return products;
}

interface SeedUserDraft {
  name: string;
  email: string;
  role: "customer" | "admin";
}

/**
 * Hand-authored rather than generated: users are few, and a mock-login list
 * (BUILD-DECISIONS.md §5 — no passwords) reads best as real-looking names a
 * demo presenter can pick by eye. One admin is required by the feature brief.
 */
const SEED_USERS: SeedUserDraft[] = [
  { name: "Alex Rivera", email: "admin@nextcart.test", role: "admin" },
  { name: "Priya Chandran", email: "priya.chandran@example.com", role: "customer" },
  { name: "Marcus Webb", email: "marcus.webb@example.com", role: "customer" },
  { name: "Sofia Alvarez", email: "sofia.alvarez@example.com", role: "customer" },
  { name: "Daniel Osei", email: "daniel.osei@example.com", role: "customer" },
  { name: "Hannah Kim", email: "hannah.kim@example.com", role: "customer" },
];

export function generateUsers(): User[] {
  return SEED_USERS.map((u) =>
    userSchema.parse({
      _id: deterministicHexId("user", u.email),
      name: u.name,
      email: u.email,
      role: u.role,
    })
  );
}

export { PRODUCT_SEED };
