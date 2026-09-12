import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductById, listCategories } from "@/lib/db/repositories";
import { ProductForm } from "@/components/admin/ProductForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const product = await getProductById(id);
  return {
    title: product ? `Edit ${product.title} — Admin — NextCart` : "Edit product — Admin — NextCart",
  };
}

/**
 * Loads via `getProductById` (feature 3's verifier added it specifically
 * for this route — no `isActive` filter, so a deactivated product's own
 * edit page still loads, matching the admin list showing inactive products
 * plainly).
 */
export default async function EditProductPage({ params }: PageProps) {
  const { id } = await params;
  const [product, categories] = await Promise.all([getProductById(id), listCategories()]);
  if (!product) notFound();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900">Edit product</h1>
      <ProductForm mode="edit" product={product} categories={categories} />
    </div>
  );
}
