#!/usr/bin/env node
// Guards against drift between the merchant-edited server data
// (server/store/catalog.json, server/store/promos.json) and the web mirror
// (web/lib/products.ts, web/lib/promos.ts). The web build context is
// ./web only (see docker-compose.yml), so web can't `import` the server
// JSON directly — this script is the substitute for that link: it diffs
// product slugs+prices and promo ids between the two sources and fails
// loudly on any mismatch.
//
// Run: node web/scripts/check-store-mirror.mjs
// Wired into scripts/check.sh (repo root).
//
// Note: web/lib/{products,promos}.ts are parsed with a small brace-depth
// splitter + field regexes rather than a real TS parser — sufficient for
// these files' plain object-literal-array shape. If that shape changes
// substantially, update the parser here too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");

function splitTopLevelObjects(arraySource) {
  const objects = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arraySource.length; i++) {
    const c = arraySource[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(arraySource.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function extractArraySource(source, constName) {
  const m = source.match(new RegExp(`export const ${constName}[^=]*=\\s*\\[`));
  if (!m) throw new Error(`could not find "export const ${constName}" array in source`);
  const start = m.index + m[0].length - 1; // index of the opening '['
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  throw new Error(`unterminated array literal for ${constName}`);
}

function stringField(objSrc, name) {
  const m = objSrc.match(new RegExp(`\\b${name}:\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
}

function numberField(objSrc, name) {
  const m = objSrc.match(new RegExp(`\\b${name}:\\s*(-?[0-9.]+)`));
  return m ? Number(m[1]) : undefined;
}

function loadWebProducts() {
  const src = fs.readFileSync(path.join(webRoot, "lib/products.ts"), "utf8");
  const arr = extractArraySource(src, "PRODUCTS");
  return splitTopLevelObjects(arr).map((obj) => ({
    slug: stringField(obj, "slug"),
    price: numberField(obj, "price"),
  }));
}

function loadWebPromos() {
  const src = fs.readFileSync(path.join(webRoot, "lib/promos.ts"), "utf8");
  const arr = extractArraySource(src, "PROMOS");
  return splitTopLevelObjects(arr).map((obj) => ({ id: stringField(obj, "id") }));
}

function loadServerJson(relPath) {
  const p = path.join(repoRoot, relPath);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  let fail = false;
  const ok = (msg) => console.log(`  [ OK ] ${msg}`);
  const warn = (msg) => console.log(`  [WARN] ${msg}`);
  const err = (msg) => {
    console.log(`  [FAIL] ${msg}`);
    fail = true;
  };

  console.log("==> check-store-mirror: web/lib vs server/store");

  const webProducts = loadWebProducts();
  const webPromos = loadWebPromos();
  const serverCatalog = loadServerJson("server/store/catalog.json");
  const serverPromos = loadServerJson("server/store/promos.json");

  if (!serverCatalog) {
    warn("server/store/catalog.json not found — skipping product mirror check");
  } else {
    const serverBySlug = new Map(serverCatalog.map((p) => [p.slug, p]));
    const webBySlug = new Map(webProducts.map((p) => [p.slug, p]));
    for (const [slug, sp] of serverBySlug) {
      const wp = webBySlug.get(slug);
      if (!wp) {
        err(`product "${slug}" is in server/store/catalog.json but missing from web/lib/products.ts`);
      } else if (wp.price !== sp.price) {
        err(`product "${slug}" price mismatch: web=${wp.price} server=${sp.price}`);
      } else {
        ok(`product "${slug}" slug+price match`);
      }
    }
    for (const slug of webBySlug.keys()) {
      if (!serverBySlug.has(slug)) {
        err(`product "${slug}" is in web/lib/products.ts but missing from server/store/catalog.json`);
      }
    }
  }

  if (!serverPromos) {
    warn("server/store/promos.json not found — skipping promo mirror check");
  } else {
    const serverIds = new Set(serverPromos.map((p) => p.id));
    const webIds = new Set(webPromos.map((p) => p.id));
    for (const id of serverIds) {
      if (!webIds.has(id)) err(`promo "${id}" is on server but missing from web/lib/promos.ts`);
      else ok(`promo "${id}" present in both`);
    }
    for (const id of webIds) {
      if (!serverIds.has(id)) err(`promo "${id}" is in web/lib/promos.ts but missing from server`);
    }
  }

  if (fail) {
    console.log("==> check-store-mirror: FAIL");
    process.exit(1);
  }
  console.log("==> check-store-mirror: PASS");
}

main();
