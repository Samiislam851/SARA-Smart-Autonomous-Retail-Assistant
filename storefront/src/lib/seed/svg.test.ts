import { describe, expect, it } from "vitest";
import { buildCategorySvg, buildProductSvg, escapeXml, wrapText } from "./svg";

describe("escapeXml", () => {
  it("escapes all five XML predefined entities", () => {
    expect(escapeXml(`Tom & Jerry's "Big" <Show>`)).toBe(
      "Tom &amp; Jerry&apos;s &quot;Big&quot; &lt;Show&gt;"
    );
  });

  it("escapes & before other entities so it never double-escapes", () => {
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("is a no-op on plain text", () => {
    expect(escapeXml("Aurora Runner Mid")).toBe("Aurora Runner Mid");
  });
});

describe("wrapText", () => {
  it("keeps a short title on one line", () => {
    expect(wrapText("Aurora Runner Mid", 18)).toEqual(["Aurora Runner Mid"]);
  });

  it("wraps a long title across multiple lines without splitting words", () => {
    const lines = wrapText("Nexbeam True Wireless Wireless Earbuds 2.0", 18);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(19); // one word may slightly exceed the target
    }
    expect(lines.join(" ").replace(/…$/, "")).not.toContain("  ");
  });

  it("truncates with an ellipsis rather than exceeding maxLines", () => {
    const longTitle = Array.from({ length: 20 }, (_, i) => `Word${i}`).join(" ");
    const lines = wrapText(longTitle, 10, 3);
    expect(lines.length).toBe(3);
    expect(lines[2]).toMatch(/…$/);
  });
});

describe("buildProductSvg / buildCategorySvg", () => {
  const colors = { from: "#1e3a8a", to: "#6366f1" };

  it("produces well-formed XML for a title containing & and \"", () => {
    const svg = buildProductSvg({
      title: `Tom & Jerry's "Deluxe" Edition`,
      index: 1,
      total: 3,
      colors,
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    // Raw ampersand/quote must never reach the markup unescaped.
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(() => new DOMParser().parseFromString(svg, "image/svg+xml")).not.toThrow();
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  });

  it("includes an index/total badge on product images", () => {
    const svg = buildProductSvg({ title: "Test Product", index: 2, total: 3, colors });
    expect(svg).toContain("2/3");
  });

  it("category images render without an index badge and stay well-formed", () => {
    const svg = buildCategorySvg({ name: `Books & "Reference"`, colors });
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(svg).not.toMatch(/\d\/\d/);
  });
});
