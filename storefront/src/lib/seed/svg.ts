/**
 * Deterministic placeholder-image generation.
 *
 * We compose an SVG (category-tinted gradient, wrapped title, a subtle
 * index marker for multi-image galleries) and hand it to `sharp` to
 * rasterize into a real webp file. We do NOT ship the `.svg` on disk: the
 * locked `imagePathSchema` (src/lib/schemas/common.ts) explicitly rejects
 * `.svg` as a non-image extension — see product.test.ts's "a non-image
 * extension" case, which predates this feature and must keep passing. SVG
 * is only ever an intermediate string here, which is also why `buildSvg`
 * is exported and unit-tested directly for well-formed escaping.
 */

/** Escapes the five XML predefined entities. Order matters: `&` first. */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Greedy word-wrap by character count. There's no real font metrics
 * available at generation time, so this is a deliberately simple heuristic
 * tuned by eye against the font size used in `buildProductSvg` — good
 * enough for a placeholder image, not a typesetting engine.
 */
export function wrapText(text: string, maxCharsPerLine: number, maxLines = 4): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length === maxLines - 1 && current.length > maxCharsPerLine) {
      break;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines);
    const last = truncated[maxLines - 1] ?? "";
    truncated[maxLines - 1] = last.replace(/\s*$/, "") + "…";
    return truncated;
  }
  return lines;
}

export interface GradientColors {
  from: string;
  to: string;
}

const WIDTH = 640;
const HEIGHT = 640;

function gradientDefs(id: string, colors: GradientColors): string {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${colors.from}"/><stop offset="100%" stop-color="${colors.to}"/></linearGradient>`;
}

function titleBlock(title: string, centerY: number): string {
  const lines = wrapText(title, 18, 4);
  const fontSize = 40;
  const lineHeight = fontSize * 1.2;
  const firstDy = -((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((line, i) => {
      const dy = i === 0 ? firstDy : lineHeight;
      return `<tspan x="${WIDTH / 2}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");
  return `<text x="${WIDTH / 2}" y="${centerY}" font-family="Verdana, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle">${tspans}</text>`;
}

/**
 * One product gallery image. `index`/`total` render as a small "1/3"-style
 * badge in the corner so the three images in a PDP gallery are visibly
 * distinct without looking like a broken/missing-image placeholder.
 */
export function buildProductSvg(params: {
  title: string;
  index: number;
  total: number;
  colors: GradientColors;
}): string {
  const { title, index, total, colors } = params;
  const gradientId = "g";
  const badgeCx = WIDTH - 52;
  const badgeCy = HEIGHT - 52;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs>${gradientDefs(gradientId, colors)}</defs><rect width="${WIDTH}" height="${HEIGHT}" fill="url(#${gradientId})"/><rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>${titleBlock(title, HEIGHT / 2)}<circle cx="${badgeCx}" cy="${badgeCy}" r="30" fill="rgba(0,0,0,0.38)"/><text x="${badgeCx}" y="${badgeCy + 7}" font-family="Verdana, Arial, sans-serif" font-size="22" font-weight="600" fill="#ffffff" text-anchor="middle">${index}/${total}</text></svg>`;
}

/** One category banner image — same visual language, no index badge. */
export function buildCategorySvg(params: { name: string; colors: GradientColors }): string {
  const { name, colors } = params;
  const gradientId = "g";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs>${gradientDefs(gradientId, colors)}</defs><rect width="${WIDTH}" height="${HEIGHT}" fill="url(#${gradientId})"/><rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>${titleBlock(name, HEIGHT / 2)}</svg>`;
}

export const SVG_IMAGE_SIZE = { width: WIDTH, height: HEIGHT };
