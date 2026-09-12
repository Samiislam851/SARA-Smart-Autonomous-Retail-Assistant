import type { ProductDTO } from "@/lib/db/repositories";

/** Shared product fixture for component tests — do not hit Mongo in these tests. */
export function makeProduct(overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    _id: "507f1f77bcf86cd799439011",
    slug: "test-product",
    title: "Test Product Deluxe",
    brand: "TestBrand",
    description: "A perfectly ordinary test product.",
    categorySlug: "electronics",
    price: 1999,
    currency: "USD",
    images: [
      "/products/seed/test-product-1.webp",
      "/products/seed/test-product-2.webp",
      "/products/seed/test-product-3.webp",
    ],
    rating: 4.2,
    reviewCount: 128,
    stock: 5,
    isActive: true,
    variants: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
