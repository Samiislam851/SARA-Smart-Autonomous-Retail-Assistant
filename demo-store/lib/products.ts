// Product catalog. Small and static on purpose — a teammate may replace this
// with a real backend. Slugs match the server fixtures in
// server/sessions/*.json (happy-browsing.json references all four).

export type Product = {
  slug: string;
  name: string;
  price: number;
  desc: string;
  sizes?: string[];
  category: string;
  tags: string[];
  /** Slugs of other products to surface in the "Similar pieces" strip. */
  similar: string[];
};

export const PRODUCTS: Product[] = [
  {
    slug: "khadi-field-jacket",
    name: "Khadi Field Jacket",
    price: 3450,
    desc:
      "Handloom khadi from Kumarkhali, unlined, with two patch pockets and horn " +
      "buttons. Runs slightly narrow through the shoulder.",
    sizes: ["S", "M", "L", "XL"],
    category: "outerwear",
    tags: ["handloom", "outerwear"],
    similar: ["nakshi-kantha-scarf"],
  },
  {
    slug: "jamdani-saree-classic",
    name: "Jamdani Saree — Classic",
    price: 1950,
    desc:
      "Hand-woven jamdani from Rupganj, cotton with a fine motif border. " +
      "One size, comes with an unstitched blouse piece.",
    category: "saree",
    tags: ["handloom"],
    similar: ["nakshi-kantha-scarf"],
  },
  {
    slug: "nakshi-kantha-scarf",
    name: "Nakshi Kantha Scarf",
    price: 850,
    desc:
      "Hand-stitched running embroidery on recycled cotton layers, made by a " +
      "women's cooperative in Jessore. Each piece is slightly one-of-a-kind.",
    category: "scarf",
    tags: ["handloom", "outerwear"],
    similar: ["khadi-field-jacket", "jamdani-saree-classic"],
  },
  {
    slug: "leather-mojari-sandals",
    name: "Leather Mojari Sandals",
    price: 1450,
    desc:
      "Vegetable-tanned leather mojaris with hand-tooled stitching. Break in " +
      "over the first week; runs true to size.",
    sizes: ["38", "40", "42", "44"],
    category: "footwear",
    tags: ["footwear"],
    similar: [],
  },
];

export function getProduct(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}
