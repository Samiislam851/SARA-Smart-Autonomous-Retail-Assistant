import Image from "next/image";
import Link from "next/link";
import type { CategoryDTO } from "@/lib/db/repositories";

export function CategoryTile({ category }: { category: CategoryDTO }) {
  return (
    <Link
      href={`/c/${category.slug}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white transition hover:border-slate-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
    >
      <div className="relative aspect-square w-full overflow-hidden bg-slate-100">
        <Image
          src={category.imagePath}
          alt=""
          fill
          sizes="(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 180px"
          className="object-cover transition group-hover:scale-105"
        />
      </div>
      <div className="p-3">
        <h3 className="text-sm font-semibold text-slate-800 group-hover:text-blue-700">
          {category.name}
        </h3>
      </div>
    </Link>
  );
}
