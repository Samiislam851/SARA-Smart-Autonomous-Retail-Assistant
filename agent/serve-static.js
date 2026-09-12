// Static hosting for the drop-in embed: server/public/{agent.js, demo.html}
// plus a tiny /embed snippet page. Mounted by index.js; does not touch it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

/**
 * mountStatic(app) — serves server/public at "/" and adds GET /embed.
 * agent.js is served with cache-control: no-store so edits during the
 * hackathon show up immediately without a hard refresh; everything else
 * uses express.static defaults.
 */
export function mountStatic(app) {
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, filePath) {
        if (path.basename(filePath) === "agent.js") {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    })
  );

  app.get("/embed", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    const snippet = `<script src="${origin}/agent.js" data-server="${origin}" data-panel="true" data-site="my-site" defer></script>`;
    res.type("html").send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Embed the agent</title>
<style>
  body { font-family: ui-monospace, Menlo, monospace; background: #1d1a17; color: #e9e4dc; padding: 40px; }
  pre { background: #0f0d0b; padding: 16px; border-radius: 6px; overflow-x: auto; }
  p { max-width: 60ch; line-height: 1.5; color: #cfc8be; }
</style>
</head>
<body>
  <h1>Drop this on any page</h1>
  <pre>${escapeHtml(snippet)}</pre>
  <p>Reads its own attributes: <code>data-server</code> (defaults to the script's own origin),
  <code>data-panel</code> ("true" shows the trace panel), <code>data-site</code> (free-text site
  profile), <code>data-targets</code> ("auto" or "manual"). See <a href="/demo.html">/demo.html</a>
  for it running against an untagged page.</p>
</body>
</html>`);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
