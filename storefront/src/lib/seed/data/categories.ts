import type { GradientColors } from "../svg";

/**
 * How a category's products get their `variants` array.
 * - "none": never any variants (Books, Grocery).
 * - "colour": each product independently rolls whether it gets colour
 *   options at all (Electronics/Computers/Home/etc. — "colour only, or
 *   none" per the feature brief).
 * - "size-colour": every product gets BOTH a size group and a colour group
 *   (Clothing & Shoes).
 */
export type VariantPolicy = "none" | "colour" | "size-colour";

export interface ProductLineTemplate {
  /** Lowercase product-type noun, e.g. "wireless earbuds". Title-cased when composing a title. */
  noun: string;
  /** Optional descriptive adjectives that may prefix the noun in a title. */
  adjectives: string[];
  /** Integer minor units (cents). A USB cable and a 4K TV do not share a range. */
  priceRange: [number, number];
  /** Overrides the category's default variant policy for this specific line. */
  variant?: VariantPolicy;
  /** For variant "colour": probability a given product actually rolls colour options. Default 0.65. */
  colourChance?: number;
  /**
   * True when the noun is grammatically plural ("wireless earbuds", "chino
   * pants"). Description fragments are authored in the singular, so the
   * composer swaps the head determiner and verb for these — without it you
   * get "The Wavecrest wireless earbuds *is* built for...", which is the
   * single most obvious "this was generated" tell on a PDP.
   */
  plural?: boolean;
  /**
   * Which size scale a "size-colour" line draws from. Footwear takes numeric
   * US sizes; S/M/L/XL on a running shoe reads as machine-made. Default
   * "apparel".
   */
  sizeScale?: "apparel" | "footwear";
  /**
   * Overrides the shared colour palette for this line. "Forest Green" is a
   * plausible backpack and an implausible lipstick.
   */
  colours?: readonly { label: string; value: string }[];
}

export interface CategoryTemplate {
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  colors: GradientColors;
  /** Default variant policy for every line in this category, unless a line overrides it. */
  variantPolicy: VariantPolicy;
  brands: string[];
  /** Optional trailing model-style tokens, e.g. "Pro", "Mid", "2.0". */
  suffixes: string[];
  productLines: ProductLineTemplate[];
  /** Opening, feature-focused sentence templates. Use {brand} and {noun}/{Noun}. */
  fragmentsA: string[];
  /** Second sentence: benefit / use-case. */
  fragmentsB: string[];
  /** Optional third sentence: material / spec / usage detail. */
  fragmentsC: string[];
  /**
   * Overrides `CLOSING_FRAGMENTS`. The generic pool talks about warranties
   * and surviving daily use, which is nonsense on a jar of honey or a novel —
   * Grocery and Books supply their own.
   */
  closingFragments?: string[];
}

/** Colour options shared by any product that rolls a "colour" variant group. */
export const COLOUR_PALETTE: { label: string; value: string }[] = [
  { label: "Midnight Black", value: "midnight-black" },
  { label: "Slate Grey", value: "slate-grey" },
  { label: "Arctic White", value: "arctic-white" },
  { label: "Ocean Blue", value: "ocean-blue" },
  { label: "Forest Green", value: "forest-green" },
  { label: "Crimson Red", value: "crimson-red" },
  { label: "Sandstone Beige", value: "sandstone-beige" },
  { label: "Sunset Orange", value: "sunset-orange" },
];

/** Cosmetic shades — used instead of `COLOUR_PALETTE` by lipstick/nail lines. */
export const COSMETIC_SHADES: { label: string; value: string }[] = [
  { label: "Rosewood", value: "rosewood" },
  { label: "Classic Red", value: "classic-red" },
  { label: "Soft Nude", value: "soft-nude" },
  { label: "Berry Wine", value: "berry-wine" },
  { label: "Dusty Mauve", value: "dusty-mauve" },
  { label: "Coral Sand", value: "coral-sand" },
  { label: "Plum Noir", value: "plum-noir" },
  { label: "Petal Pink", value: "petal-pink" },
];

/** Apparel size scale for Clothing & Shoes. */
export const CLOTHING_SIZES: { label: string; value: string }[] = [
  { label: "Small", value: "S" },
  { label: "Medium", value: "M" },
  { label: "Large", value: "L" },
  { label: "X-Large", value: "XL" },
];

/** Footwear size scale — shoes do not come in S/M/L/XL. */
export const FOOTWEAR_SIZES: { label: string; value: string }[] = [
  { label: "US 7", value: "us-7" },
  { label: "US 8", value: "us-8" },
  { label: "US 9", value: "us-9" },
  { label: "US 10", value: "us-10" },
  { label: "US 11", value: "us-11" },
  { label: "US 12", value: "us-12" },
];

/** Generic closing sentence, appended after category-specific ones about 50% of the time. */
export const CLOSING_FRAGMENTS: string[] = [
  "Backed by a standard manufacturer warranty and NextCart's 30-day return policy.",
  "Ships in frustration-free packaging, ready to use right out of the box.",
  "A dependable pick for everyday use, with support available if you ever need it.",
  "Thousands of shoppers have already made it part of their routine.",
  "Designed to hold up to daily use without letting you down.",
  "A practical choice that balances price and quality.",
];

/** Grocery-appropriate closers — food has no warranty and does not "survive daily use". */
export const GROCERY_CLOSING_FRAGMENTS: string[] = [
  "Packed in small batches and shipped fresh.",
  "A pantry regular that rarely lasts as long as you plan for.",
  "Sold in a resealable pack, so the second half is as good as the first.",
  "Stocked year-round, so restocking is never a hunt.",
];

export const CATEGORY_TEMPLATES: CategoryTemplate[] = [
  {
    slug: "electronics",
    name: "Electronics",
    description:
      "Everyday electronics and smart gadgets for home, work, and life on the go.",
    sortOrder: 0,
    colors: { from: "#1e3a8a", to: "#6366f1" },
    variantPolicy: "colour",
    brands: ["Voltara", "Nexbeam", "Pulsegear", "Sonique", "Kryotech", "Arclight", "Wavecrest"],
    suffixes: ["Pro", "2.0", "Plus", "Mini", "Max", "SE"],
    productLines: [
      { noun: "wireless earbuds", adjectives: ["true wireless", "noise-isolating"], priceRange: [2500, 9000], plural: true },
      { noun: "bluetooth speaker", adjectives: ["portable", "waterproof"], priceRange: [2000, 12000] },
      { noun: "smart watch", adjectives: ["fitness", "always-on display"], priceRange: [6000, 25000] },
      { noun: "streaming media player", adjectives: ["4K", "HDR"], priceRange: [3000, 7000], variant: "none" },
      { noun: "noise-cancelling headphones", adjectives: ["over-ear", "studio"], priceRange: [5000, 28000], plural: true },
      { noun: "portable power bank", adjectives: ["fast-charging", "slim"], priceRange: [1500, 5500] },
      { noun: "usb-c charging cable", adjectives: ["braided", "6ft"], priceRange: [700, 1600], variant: "none" },
      { noun: "smart led light bulb 4-pack", adjectives: ["dimmable", "colour-changing"], priceRange: [1800, 4000], variant: "none" },
      { noun: "bluetooth tracker tag", adjectives: ["keychain", "compact"], priceRange: [1200, 3000] },
      { noun: "home security camera", adjectives: ["indoor", "1080p"], priceRange: [3500, 14000], variant: "none" },
    ],
    fragmentsA: [
      "This {brand} {noun} pairs a clean, minimal design with reliable everyday performance.",
      "The {brand} {noun} is built for anyone who wants dependable tech without the fuss.",
      "{brand} designed this {noun} to feel effortless from the moment you unbox it.",
    ],
    fragmentsB: [
      "A long-lasting battery and a stable wireless connection keep it ready whenever you need it.",
      "Setup takes minutes, and it works out of the box with most phones and laptops.",
      "Compact enough to toss in a bag, sturdy enough to survive daily commutes.",
    ],
    fragmentsC: [
      "The matte finish resists fingerprints, and the controls are easy to find by feel alone.",
      "Firmware updates arrive automatically, so it keeps getting better after you buy it.",
      "Included cables and a quick-start guide mean there is nothing extra to buy.",
    ],
  },
  {
    slug: "computers-accessories",
    name: "Computers & Accessories",
    description:
      "Peripherals, storage, and desk gear to round out any laptop or desktop setup.",
    sortOrder: 1,
    colors: { from: "#0f172a", to: "#334155" },
    variantPolicy: "colour",
    brands: ["Coreline", "Byteforge", "Pixeldock", "Quantera", "Nordwork", "Circuiq"],
    suffixes: ["Pro", "Elite", "2.0", "Mini", "Max"],
    productLines: [
      { noun: "wireless mouse", adjectives: ["ergonomic", "silent-click"], priceRange: [1200, 4500] },
      { noun: "mechanical keyboard", adjectives: ["tenkeyless", "backlit"], priceRange: [4500, 16000] },
      { noun: "usb-c hub 7-in-1", adjectives: ["compact", "aluminum"], priceRange: [2000, 5500], variant: "none" },
      { noun: "27-inch monitor", adjectives: ["QHD", "IPS"], priceRange: [14000, 38000], variant: "none" },
      { noun: "laptop backpack", adjectives: ["water-resistant", "padded"], priceRange: [3000, 7000] },
      { noun: "external ssd 1tb", adjectives: ["portable", "shock-resistant"], priceRange: [6000, 14000], variant: "none" },
      { noun: "1080p webcam", adjectives: ["autofocus", "low-light"], priceRange: [2200, 6000], variant: "none" },
      { noun: "aluminum laptop stand", adjectives: ["adjustable", "foldable"], priceRange: [1800, 4500] },
      { noun: "wireless charging pad", adjectives: ["fast", "slim"], priceRange: [1500, 3500] },
      { noun: "cable management kit", adjectives: ["desk", "under-desk"], priceRange: [1000, 2200], variant: "none" },
    ],
    fragmentsA: [
      "The {brand} {noun} is built to disappear into your workflow, not get in the way of it.",
      "{brand} tuned this {noun} for long work sessions, not just a quick unboxing photo.",
      "This {brand} {noun} brings a clean desk setup within easy reach.",
    ],
    fragmentsB: [
      "Plug-and-play compatibility means it works the moment it's connected, no drivers required.",
      "Built from sturdy materials that hold up to years of daily typing, clicking, or travel.",
      "A tidy footprint keeps your desk clear without giving up capability.",
    ],
    fragmentsC: [
      "Every port and control is placed for reach without awkward cable angles.",
      "A two-year limited warranty covers manufacturing defects.",
      "Compatible with Windows, macOS, and most Chromebooks out of the box.",
    ],
  },
  {
    slug: "home-kitchen",
    name: "Home & Kitchen",
    description:
      "Cookware, small appliances, and everyday essentials for a well-run kitchen and home.",
    sortOrder: 2,
    colors: { from: "#92400e", to: "#f59e0b" },
    variantPolicy: "colour",
    brands: ["Hearthstone", "Millbrook", "Copperlane", "Vessel & Co", "Kindred Home", "Northgrain"],
    suffixes: ["Pro", "Deluxe", "XL", "Classic"],
    productLines: [
      { noun: "stainless steel cookware set 10-piece", adjectives: ["induction-ready"], priceRange: [8000, 22000], variant: "none" },
      { noun: "electric kettle", adjectives: ["rapid-boil", "cordless"], priceRange: [2500, 5500] },
      { noun: "stand mixer", adjectives: ["6-quart", "tilt-head"], priceRange: [15000, 32000] },
      { noun: "nonstick frying pan", adjectives: ["10-inch", "scratch-resistant"], priceRange: [1800, 4000], variant: "none" },
      { noun: "ceramic dinnerware set 16-piece", adjectives: ["stoneware"], priceRange: [4500, 11000] },
      { noun: "memory foam pillow 2-pack", adjectives: ["cooling gel", "hypoallergenic"], priceRange: [3000, 6000], variant: "none", plural: true },
      { noun: "blackout curtain pair", adjectives: ["thermal", "room-darkening"], priceRange: [2500, 5500] },
      { noun: "digital kitchen scale", adjectives: ["compact", "precision"], priceRange: [1200, 2800], variant: "none" },
      { noun: "air fryer", adjectives: ["5.5-quart", "digital"], priceRange: [6000, 15000] },
      { noun: "bamboo cutting board set", adjectives: ["3-piece"], priceRange: [2000, 4000], variant: "none" },
    ],
    fragmentsA: [
      "The {brand} {noun} is made for cooks who use their kitchen every single day.",
      "{brand} designed this {noun} to earn a permanent spot on your counter.",
      "This {brand} {noun} balances everyday practicality with a look that fits any kitchen.",
    ],
    fragmentsB: [
      "It cleans up easily after busy weeknight dinners and holiday cooking alike.",
      "Even heat distribution and sturdy construction mean consistent results every time.",
      "Thoughtful details, like a comfortable grip and clear markings, make it easy to love.",
    ],
    fragmentsC: [
      "Dishwasher-safe parts make cleanup quick, even after a full weekend of cooking.",
      "A one-year warranty covers manufacturing defects under normal home use.",
      "Compact storage dimensions mean it won't take over your cabinets.",
    ],
  },
  {
    slug: "books",
    name: "Books",
    description:
      "Fiction, non-fiction, and reference titles across genres, from quiet reads to page-turners.",
    sortOrder: 3,
    colors: { from: "#4c1d95", to: "#7c3aed" },
    variantPolicy: "none",
    brands: [],
    suffixes: [],
    // Books are generated with a bespoke title/author composer (see generate.ts),
    // so `noun` here is a genre label rather than a product noun, and
    // adjectives/priceRange are still used directly.
    productLines: [
      { noun: "novel", adjectives: [], priceRange: [900, 1800] },
      { noun: "cookbook", adjectives: [], priceRange: [1500, 3000] },
      { noun: "self-help and business", adjectives: [], priceRange: [1200, 2400] },
      { noun: "children's picture book", adjectives: [], priceRange: [700, 1400] },
      { noun: "biography and memoir", adjectives: [], priceRange: [1400, 2600] },
      { noun: "field guide and reference", adjectives: [], priceRange: [1600, 3200] },
      { noun: "graphic novel", adjectives: [], priceRange: [1200, 2200] },
      { noun: "poetry collection", adjectives: [], priceRange: [1000, 1800] },
      { noun: "travel guide", adjectives: [], priceRange: [1400, 2400] },
      { noun: "history", adjectives: [], priceRange: [1600, 2800] },
    ],
    fragmentsA: [],
    fragmentsB: [],
    fragmentsC: [],
  },
  {
    slug: "clothing-shoes",
    name: "Clothing & Shoes",
    description:
      "Everyday apparel and footwear, from running shoes to weekend layers, in sizes and colours.",
    sortOrder: 4,
    colors: { from: "#be123c", to: "#fb7185" },
    variantPolicy: "size-colour",
    brands: ["Aurora", "Summit Trail", "Northfield", "Driftwood", "Cascade & Co", "Ridgeline"],
    suffixes: ["Mid", "Low", "High", "2.0", "Pro", "Elite", "SE"],
    productLines: [
      { noun: "runner", adjectives: ["lightweight", "breathable"], priceRange: [5500, 14000], sizeScale: "footwear" },
      { noun: "trailblazer boot", adjectives: ["waterproof", "insulated"], priceRange: [7000, 16000], sizeScale: "footwear" },
      { noun: "classic tee", adjectives: ["organic cotton", "everyday"], priceRange: [1500, 3000] },
      { noun: "trucker jacket", adjectives: ["denim", "stonewash"], priceRange: [6000, 12000] },
      { noun: "crewneck sweater", adjectives: ["merino wool", "ribbed"], priceRange: [4500, 9000] },
      { noun: "flex leggings", adjectives: ["high-waist", "four-way stretch"], priceRange: [3000, 6000], plural: true },
      { noun: "puffer parka", adjectives: ["insulated", "water-resistant"], priceRange: [7000, 16000] },
      { noun: "court sneaker", adjectives: ["canvas", "low-top"], priceRange: [4000, 8000], sizeScale: "footwear" },
      { noun: "flannel shirt", adjectives: ["brushed cotton", "plaid"], priceRange: [3000, 5500] },
      { noun: "chino pants", adjectives: ["slim-fit", "stretch"], priceRange: [3500, 6500], plural: true },
    ],
    fragmentsA: [
      "The {brand} {noun} is cut for everyday wear, from morning errands to evening plans.",
      "{brand} built this {noun} to move with you, not against you.",
      "This {brand} {noun} pairs comfort with a look that works well beyond one season.",
    ],
    fragmentsB: [
      "A tailored fit and durable stitching keep it looking sharp wash after wash.",
      "Breathable fabric keeps you comfortable whether you're on your feet all day or just relaxing.",
      "Designed alongside real feedback from people who wear it every day.",
    ],
    fragmentsC: [
      "True to size for most shoppers; sizing details are on the product size chart.",
      "Machine washable and colourfast, so it keeps its shape and shade wash after wash.",
      "Available in multiple sizes and colours to match how you actually dress.",
    ],
  },
  {
    slug: "sports-outdoors",
    name: "Sports & Outdoors",
    description:
      "Gear for the gym, the trail, and the campsite, built to keep up with an active routine.",
    sortOrder: 5,
    colors: { from: "#14532d", to: "#22c55e" },
    variantPolicy: "colour",
    brands: ["Trailforge", "Summit Peak", "Altitude Co", "Rivergrade", "Pinecrest", "Stridewell"],
    suffixes: ["Pro", "Elite", "2.0", "XL"],
    productLines: [
      { noun: "yoga mat", adjectives: ["non-slip", "extra-thick"], priceRange: [1800, 4500] },
      { noun: "adjustable dumbbell set", adjectives: ["space-saving"], priceRange: [6000, 18000], variant: "none" },
      { noun: "camping tent 2-person", adjectives: ["3-season", "quick-pitch"], priceRange: [7000, 16000] },
      { noun: "insulated water bottle", adjectives: ["32oz", "double-wall"], priceRange: [1500, 3200] },
      { noun: "resistance band set", adjectives: ["5-level"], priceRange: [1200, 2800] },
      { noun: "hiking backpack 30l", adjectives: ["ventilated", "trail-ready"], priceRange: [4500, 11000] },
      { noun: "bicycle helmet", adjectives: ["ventilated", "adjustable-fit"], priceRange: [3000, 7000] },
      { noun: "fishing rod and reel combo", adjectives: ["travel"], priceRange: [3500, 9000], variant: "none" },
      { noun: "sleeping bag 3-season", adjectives: ["mummy-style", "packable"], priceRange: [4000, 9500] },
      { noun: "foam roller", adjectives: ["high-density"], priceRange: [1400, 3000], variant: "none" },
    ],
    fragmentsA: [
      "The {brand} {noun} is built for regular use, not just a New Year's resolution.",
      "{brand} designed this {noun} to keep up on the trail, in the gym, or in the backyard.",
      "This {brand} {noun} is made to handle sweat, weather, and repeated use without complaint.",
    ],
    fragmentsB: [
      "Durable materials and reinforced stitching mean it can take a beating and keep going.",
      "Lightweight enough to pack for a trip, tough enough to use every week.",
      "A grippy, practical design keeps the focus on your workout or your hike, not the gear.",
    ],
    fragmentsC: [
      "Easy to clean after a sweaty session or a muddy trail.",
      "Compact when packed down, so it earns its place in your gear closet.",
      "Backed by a manufacturer's limited warranty against defects.",
    ],
  },
  {
    slug: "beauty-personal-care",
    name: "Beauty & Personal Care",
    description:
      "Skincare, haircare, and grooming essentials for a simple daily routine.",
    sortOrder: 6,
    colors: { from: "#9d174d", to: "#f472b6" },
    variantPolicy: "colour",
    brands: ["Lumen & Co", "Velvet Bloom", "Pure Meridian", "Glowfield", "Clearwater Beauty", "Marbleleaf"],
    suffixes: ["Deluxe", "Mini", "Pro"],
    productLines: [
      { noun: "matte liquid lipstick", adjectives: ["long-wear"], priceRange: [800, 1800], colours: COSMETIC_SHADES },
      { noun: "vitamin c serum", adjectives: ["brightening"], priceRange: [1600, 3400], variant: "none" },
      { noun: "electric toothbrush", adjectives: ["rechargeable", "sonic"], priceRange: [2500, 7000] },
      { noun: "ionic hair dryer", adjectives: ["fast-drying"], priceRange: [2200, 6000], variant: "none" },
      { noun: "facial cleansing brush", adjectives: ["silicone"], priceRange: [1800, 4000] },
      { noun: "daily moisturizer spf 30", adjectives: ["lightweight"], priceRange: [1400, 2800], variant: "none" },
      { noun: "eau de parfum", adjectives: [], priceRange: [2800, 6500], variant: "none" },
      { noun: "beard trimmer kit", adjectives: ["cordless"], priceRange: [2000, 4500] },
      { noun: "bath bomb gift set", adjectives: ["6-piece"], priceRange: [1200, 2500], variant: "none" },
      { noun: "nail polish set 6-piece", adjectives: [], priceRange: [1000, 2000], colours: COSMETIC_SHADES },
    ],
    fragmentsA: [
      "The {brand} {noun} fits easily into a daily routine without adding extra steps.",
      "{brand} formulated this {noun} for everyday use, not just special occasions.",
      "This {brand} {noun} is a small upgrade that makes a noticeable daily difference.",
    ],
    fragmentsB: [
      "A gentle, dermatologist-tested formula suits most skin types.",
      "Compact enough for a bathroom shelf or a weekend travel bag.",
      "Consistent results with regular use, without a complicated routine.",
    ],
    fragmentsC: [
      "Free from parabens and tested to be gentle on sensitive skin.",
      "A little goes a long way, so one order lasts for weeks.",
      "Comes in recyclable packaging designed to minimize waste.",
    ],
  },
  {
    slug: "toys-games",
    name: "Toys & Games",
    description:
      "Toys, puzzles, and games for kids and families, from quiet afternoons to game night.",
    sortOrder: 7,
    colors: { from: "#0e7490", to: "#22d3ee" },
    variantPolicy: "colour",
    brands: ["Funhouse Kids", "Brightbrick", "Playnest", "Wondercraft", "Tinker Tales", "Jollywood"],
    suffixes: ["Deluxe", "XL", "2.0"],
    productLines: [
      { noun: "building block set 500-piece", adjectives: ["stackable"], priceRange: [2500, 5500], variant: "none" },
      { noun: "remote control car", adjectives: ["high-speed"], priceRange: [3000, 7000] },
      { noun: "strategy board game", adjectives: ["family"], priceRange: [2000, 4500], variant: "none" },
      { noun: "plush stuffed animal", adjectives: ["oversized", "soft"], priceRange: [1200, 2800] },
      { noun: "puzzle 1000-piece", adjectives: ["jigsaw"], priceRange: [1400, 2400], variant: "none" },
      { noun: "kids' art supply kit", adjectives: ["washable"], priceRange: [1500, 3000], variant: "none" },
      { noun: "action figure", adjectives: ["poseable"], priceRange: [1000, 2500] },
      { noun: "stem robot building kit", adjectives: ["beginner-friendly"], priceRange: [3500, 8000], variant: "none" },
      { noun: "party card game", adjectives: ["quick-play"], priceRange: [1000, 2000], variant: "none" },
      { noun: "ride-on toy car", adjectives: ["battery-powered"], priceRange: [6000, 14000] },
    ],
    fragmentsA: [
      "The {brand} {noun} is made to survive real playtime, not just sit on a shelf.",
      "{brand} designed this {noun} to hold a kid's attention well past the first afternoon.",
      "This {brand} {noun} turns spare time into hands-on play.",
    ],
    fragmentsB: [
      "Durable, kid-tested materials hold up to daily play and the occasional drop.",
      "Simple enough for a quick start, with enough depth to stay interesting.",
      "A favourite for family game nights and rainy afternoons alike.",
    ],
    fragmentsC: [
      "Made from non-toxic materials and tested to standard safety guidelines.",
      "Easy for kids to pick up and understand without an adult reading a manual aloud.",
      "Compact storage means it's easy to tidy away after playtime.",
    ],
  },
  {
    slug: "grocery",
    name: "Grocery",
    description:
      "Pantry staples and everyday groceries, from coffee and honey to pasta and snacks.",
    sortOrder: 8,
    colors: { from: "#365314", to: "#84cc16" },
    variantPolicy: "none",
    brands: ["Harvest & Sun", "Golden Field", "Pure Origin", "Meadowbrook", "Northgrain Pantry", "Wildroot"],
    suffixes: [],
    productLines: [
      { noun: "organic coffee beans 12oz", adjectives: ["single-origin", "medium-roast"], priceRange: [900, 1600], plural: true },
      { noun: "extra virgin olive oil 500ml", adjectives: ["cold-pressed"], priceRange: [1000, 2200] },
      { noun: "raw honey 16oz", adjectives: ["unfiltered"], priceRange: [800, 1600] },
      { noun: "almond butter 16oz", adjectives: ["stone-ground", "unsalted"], priceRange: [900, 1500] },
      { noun: "green tea bags 100-count", adjectives: ["organic"], priceRange: [700, 1400], plural: true },
      { noun: "trail mix 2lb", adjectives: ["unsalted", "no sugar added"], priceRange: [1000, 1800] },
      { noun: "dry pasta 16oz", adjectives: ["durum wheat"], priceRange: [200, 500] },
      { noun: "dark chocolate bar multi-pack", adjectives: ["70% cacao"], priceRange: [800, 1600] },
      { noun: "protein powder 2lb", adjectives: ["whey", "unflavoured"], priceRange: [2200, 4500] },
      { noun: "quinoa 32oz", adjectives: ["organic", "tri-colour"], priceRange: [800, 1400] },
    ],
    fragmentsA: [
      "This {brand} {noun} is a pantry staple sourced with everyday cooking in mind.",
      "{brand} keeps this {noun} simple: a short ingredient list and a taste that holds up.",
      "This {brand} {noun} is stocked for cooks who reach for it week after week.",
    ],
    fragmentsB: [
      "No artificial additives, just straightforward ingredients you can recognize.",
      "Consistent quality batch after batch, whether you're cooking for one or the whole family.",
      "Resealable packaging keeps it fresh long after the first use.",
    ],
    fragmentsC: [
      "Sourced from growers who meet NextCart's everyday quality standards.",
      "Best stored in a cool, dry pantry away from direct sunlight.",
      "A reliable choice for meal prep, baking, or a quick weeknight dinner.",
    ],
    closingFragments: GROCERY_CLOSING_FRAGMENTS,
  },
  {
    slug: "automotive",
    name: "Automotive",
    description:
      "Car care, accessories, and roadside essentials for drivers who maintain their own vehicle.",
    sortOrder: 9,
    colors: { from: "#1f2937", to: "#ef4444" },
    variantPolicy: "colour",
    brands: ["Ironclad", "Roadgrip", "Driftline", "Torquewell", "Autopeak", "Trailhitch"],
    suffixes: ["Pro", "XL", "Max"],
    productLines: [
      { noun: "car phone mount", adjectives: ["magnetic", "dashboard"], priceRange: [1200, 2800], variant: "none" },
      { noun: "microfiber detailing towels 12-pack", adjectives: ["lint-free"], priceRange: [1000, 2000], variant: "none", plural: true },
      { noun: "portable tire inflator", adjectives: ["digital", "12v"], priceRange: [3000, 6500], variant: "none" },
      { noun: "1080p dash cam", adjectives: ["night-vision", "loop-recording"], priceRange: [3500, 9000], variant: "none" },
      { noun: "all-weather floor mats", adjectives: ["heavy-duty"], priceRange: [3500, 7500], variant: "none", plural: true },
      { noun: "handheld car vacuum", adjectives: ["cordless"], priceRange: [2500, 5500] },
      { noun: "jump starter power pack", adjectives: ["12v", "portable"], priceRange: [4500, 11000] },
      { noun: "car seat cover pair", adjectives: ["universal-fit"], priceRange: [2500, 5500] },
      { noun: "windshield sun shade", adjectives: ["foldable", "reflective"], priceRange: [1200, 2400], variant: "none" },
      { noun: "ceramic car wax kit", adjectives: ["long-lasting"], priceRange: [1800, 4000], variant: "none" },
    ],
    fragmentsA: [
      "The {brand} {noun} is built for drivers who maintain their own vehicle.",
      "{brand} designed this {noun} to earn a permanent spot in the trunk or glovebox.",
      "This {brand} {noun} handles the small jobs that keep a car running well.",
    ],
    fragmentsB: [
      "Durable materials hold up to temperature swings and daily use.",
      "Quick to install and easy to use without a trip to the shop.",
      "A practical upgrade that pays for itself the first time you need it.",
    ],
    fragmentsC: [
      "Fits most makes and models; check dimensions against your vehicle before ordering.",
      "Backed by a manufacturer's limited warranty against defects.",
      "Compact enough to store in a trunk organizer or glovebox.",
    ],
  },
];
