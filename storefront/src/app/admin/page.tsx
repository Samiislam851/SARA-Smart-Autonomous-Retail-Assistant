import { redirect } from "next/navigation";

/** `/admin` has nothing of its own to show — REQUIREMENTS: "`/admin` redirects to `/admin/products`". */
export default function AdminIndexPage(): never {
  redirect("/admin/products");
}
