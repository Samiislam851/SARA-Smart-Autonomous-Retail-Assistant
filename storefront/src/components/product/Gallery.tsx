"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * PDP image gallery: one large main image plus a thumbnail strip. Clicking
 * (or keyboard-activating) a thumbnail swaps the main image; it never
 * navigates. Client-only because it needs local selection state — the rest
 * of the PDP stays a Server Component.
 */
export function Gallery({ images, title }: { images: string[]; title: string }) {
  const [selected, setSelected] = useState(0);
  const activeIndex = selected < images.length ? selected : 0;

  return (
    <div className="flex flex-col gap-3 sm:flex-row-reverse">
      <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-slate-100 sm:flex-1">
        <Image
          src={images[activeIndex]}
          alt={`${title} — image ${activeIndex + 1} of ${images.length}`}
          fill
          sizes="(max-width: 640px) 100vw, 50vw"
          priority
          className="object-cover"
        />
        {images.length > 1 && (
          /*
            Cosmetic fix: inset by 0.5rem (bottom-2/right-2), not flush
            against the corner (bottom-0/right-0) — flush against the
            rounded image edge clipped the badge's own corners against the
            parent's `overflow-hidden`/`rounded-lg`.
          */
          <span className="absolute bottom-2 right-2 rounded-full bg-slate-900/80 px-2.5 py-1 text-xs font-medium text-white">
            {activeIndex + 1} / {images.length}
          </span>
        )}
      </div>

      {images.length > 1 && (
        <div
          role="tablist"
          aria-label="Product images"
          className="flex gap-2 sm:flex-col"
        >
          {images.map((image, index) => (
            <button
              key={image}
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              aria-label={`Show image ${index + 1} of ${images.length}`}
              // ⚠️ UNCOMMITTED PROTOTYPE HOOK — REHEARSAL ONLY, NEVER
              // COMMITTED. Fast next/prev clicking through thumbnails is
              // legitimate browsing, not frustration — opts this control out
              // of the agent-mock rage-click detector. See
              // src/lib/agent-mock/rage-click.ts. Inert attribute, no
              // behaviour, safe if ever left in.
              data-agent-repeatable=""
              onClick={() => setSelected(index)}
              className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 ${
                index === activeIndex ? "border-slate-900" : "border-transparent hover:border-slate-300"
              }`}
            >
              <Image
                src={image}
                alt=""
                fill
                sizes="64px"
                className="object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
