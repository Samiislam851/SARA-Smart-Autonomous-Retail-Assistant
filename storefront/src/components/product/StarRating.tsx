/**
 * Read-only star rating display: five stars filled proportionally to
 * `rating` (0-5), plus the numeric rating and review count. Stars are
 * decorative (`aria-hidden`); the real information is in the visually
 * present text and a single `aria-label` on the wrapper for assistive tech.
 */
export function StarRating({
  rating,
  reviewCount,
  size = "sm",
}: {
  rating: number;
  reviewCount: number;
  size?: "sm" | "md";
}) {
  const rounded = Math.round(rating * 2) / 2; // nearest half star
  const starClass = size === "md" ? "text-base" : "text-sm";

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`Rated ${rating.toFixed(1)} out of 5 stars, ${reviewCount.toLocaleString()} review${
        reviewCount === 1 ? "" : "s"
      }`}
    >
      <span className={`flex text-amber-500 ${starClass}`} aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => {
          const fill = Math.min(Math.max(rounded - i, 0), 1);
          return (
            <span key={i} className="relative inline-block">
              <span className="text-slate-300">★</span>
              {fill > 0 && (
                <span
                  className="absolute inset-0 overflow-hidden"
                  style={{ width: `${fill * 100}%` }}
                >
                  ★
                </span>
              )}
            </span>
          );
        })}
      </span>
      <span className="text-xs text-slate-600">
        {rating.toFixed(1)}
        <span className="ml-1 text-blue-700">({reviewCount.toLocaleString()})</span>
      </span>
    </div>
  );
}
