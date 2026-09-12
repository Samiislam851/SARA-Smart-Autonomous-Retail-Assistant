import type { Metadata } from "next";
import { listCategories } from "@/lib/db/repositories";
import { ProductForm } from "@/components/admin/ProductForm";

export const metadata: Metadata = { title: "New product — Admin — NextCart" };

export default async function NewProductPage() {
  const categories = await listCategories();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900">New product</h1>
      <ProductForm mode="create" categories={categories} />
    </div>
  );
}
