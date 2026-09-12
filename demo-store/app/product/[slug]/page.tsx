import { notFound } from "next/navigation";
import ProductClient from "@/components/ProductClient";
import { getProduct } from "@/lib/products";

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = getProduct(slug);
  if (!product) notFound();
  return <ProductClient product={product} />;
}
