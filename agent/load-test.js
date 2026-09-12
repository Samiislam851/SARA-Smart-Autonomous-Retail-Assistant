// Load test — no new deps (uses `ws`, already a server dependency, and the
// built-in `fetch`). Spawns N virtual sessions, each opens a WS connection
// and POSTs a realistic event sequence (page_view w/ targets, several
// dwells/scroll_depth, one cart_update) with small random delays between
// events. Reports POST latency p50/p95/p99, error count, traces received per
// session, and WS drops.
//
// Usage:
//   node load-test.js --base http://localhost:4000 --sessions 50 --events 20 \
//     --concurrency 20 [--max-p95 200]
//
// Exit code: non-zero if any POST returned non-200/errored, or if p95 latency
// exceeds --max-p95 (default 200ms).

import { WebSocket } from "ws";

function parseArgs(argv) {
  const args = {
    base: "http://localhost:4000",
    sessions: 50,
    events: 20,
    concurrency: 20,
    maxP95: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") args.base = next();
    else if (a === "--sessions") args.sessions = Number(next());
    else if (a === "--events") args.events = Number(next());
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--max-p95") args.maxP95 = Number(next());
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const PRODUCT_PAGE = "/product/khadi-field-jacket";
const TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link"];

/** Builds a realistic event sequence for one virtual session. */
function buildEvents(sessionId, n) {
  const events = [];
  events.push({
    session: sessionId,
    type: "page_view",
    target: PRODUCT_PAGE,
    meta: { targets: TARGETS },
  });

  const cartIdx = Math.max(1, Math.floor(n / 2));
  for (let i = 1; i < n; i++) {
    if (i === cartIdx) {
      events.push({
        session: sessionId,
        type: "cart_update",
        target: null,
        meta: { total: 1500 + i * 15, items: [{ sku: "khadi-jacket", qty: 1, price: 1500 }] },
      });
    } else if (i % 4 === 0) {
      events.push({
        session: sessionId,
        type: "scroll_depth",
        target: null,
        meta: { pct: Math.min(100, i * 8) },
      });
    } else if (i % 3 === 0) {
      events.push({
        session: sessionId,
        type: "dwell",
        target: "size-guide",
        meta: { ms: 3000 + i * 700 },
      });
    } else {
      events.push({
        session: sessionId,
        type: "dwell",
        target: PRODUCT_PAGE,
        meta: { ms: 1000 + i * 500 },
      });
    }
  }
  return events;
}

async function runSession(sessionId, base, eventCount) {
  const wsBase = base.replace(/^http/, "ws");
  const latencies = [];
  let errors = 0;
  let traceCount = 0;
  let wsDropped = false;

  let ws;
  try {
    ws = new WebSocket(`${wsBase}?session=${encodeURIComponent(sessionId)}`);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.kind === "trace") traceCount++;
      } catch {
        // ignore malformed frame — not the thing under test here
      }
    });
    ws.on("close", (code) => {
      if (code !== 1000) wsDropped = true;
    });
    ws.on("error", () => {
      wsDropped = true;
    });
  } catch {
    wsDropped = true;
  }

  const events = buildEvents(sessionId, eventCount);
  for (const ev of events) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
      });
      // Drain body so the connection can be reused.
      await res.text();
      latencies.push(Date.now() - t0);
      if (res.status !== 200) errors++;
    } catch {
      latencies.push(Date.now() - t0);
      errors++;
    }
    await sleep(20 + Math.random() * 80);
  }

  try {
    ws?.close(1000);
  } catch {
    // already closed/closing
  }

  return { latencies, errors, traceCount, wsDropped };
}

/** Runs `items` through `worker` with at most `limit` concurrently in flight. */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, lane);
  await Promise.all(lanes);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = Date.now();

  console.log(
    `load-test: base=${args.base} sessions=${args.sessions} events=${args.events} concurrency=${args.concurrency} max-p95=${args.maxP95}ms`
  );

  const sessionIds = Array.from({ length: args.sessions }, (_, i) => `load_${runId}_${i}`);
  const start = Date.now();
  const results = await runPool(sessionIds, args.concurrency, (id) => runSession(id, args.base, args.events));
  const wallMs = Date.now() - start;

  const allLatencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
  const totalTraces = results.reduce((sum, r) => sum + r.traceCount, 0);
  const totalDrops = results.filter((r) => r.wsDropped).length;
  const totalRequests = allLatencies.length;

  const p50 = percentile(allLatencies, 50);
  const p95 = percentile(allLatencies, 95);
  const p99 = percentile(allLatencies, 99);

  console.log("");
  console.log("| metric                | value |");
  console.log("|------------------------|-------|");
  console.log(`| wall time              | ${wallMs}ms |`);
  console.log(`| sessions               | ${args.sessions} |`);
  console.log(`| total POSTs            | ${totalRequests} |`);
  console.log(`| errors (non-200/fail)  | ${totalErrors} |`);
  console.log(`| p50 latency            | ${p50}ms |`);
  console.log(`| p95 latency            | ${p95}ms |`);
  console.log(`| p99 latency            | ${p99}ms |`);
  console.log(`| traces received        | ${totalTraces} |`);
  console.log(`| ws drops               | ${totalDrops} |`);
  console.log("");

  const failed = totalErrors > 0 || p95 > args.maxP95;
  if (failed) {
    console.error(
      `FAIL: errors=${totalErrors} p95=${p95}ms (max ${args.maxP95}ms)`
    );
    process.exit(1);
  }
  console.log("PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("load-test crashed:", err);
  process.exit(2);
});
