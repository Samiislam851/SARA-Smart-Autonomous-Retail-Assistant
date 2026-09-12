// Structured JSON logging to stdout. One JSON object per line:
// { ts, level, msg, ...ctx }. LOG_LEVEL (debug|info|warn|error, default
// "info") controls what actually gets printed to stdout; LOG_PRETTY=1 prints
// a human-readable one-liner instead of raw JSON. Every call (regardless of
// LOG_LEVEL) is also pushed into an in-process ring buffer of the last 500
// entries, exposed via GET /logs/recent (index.js, gated by AGENT_DEBUG=1) —
// so a debug-level entry can still be inspected after the fact even when
// LOG_LEVEL=info suppressed it from stdout.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;
const pretty = process.env.LOG_PRETTY === "1";

const RING_SIZE = 500;
const ring = [];

function pushRing(entry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

function write(level, msg, ctx) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(ctx || {}) };
  pushRing(entry);

  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;

  const sink = level === "error" || level === "warn" ? console.error : console.log;
  if (pretty) {
    const rest = ctx && Object.keys(ctx).length ? " " + JSON.stringify(ctx) : "";
    sink(`${entry.ts} [${level.toUpperCase()}] ${msg}${rest}`);
  } else {
    sink(JSON.stringify(entry));
  }
}

export const log = {
  debug: (msg, ctx) => write("debug", msg, ctx),
  info: (msg, ctx) => write("info", msg, ctx),
  warn: (msg, ctx) => write("warn", msg, ctx),
  error: (msg, ctx) => write("error", msg, ctx),
};

/**
 * recent(n, level) → last n ring entries (regardless of LOG_LEVEL/stdout
 * filtering), optionally filtered to entries at or above `level`.
 */
export function recent(n = 100, level) {
  let out = ring;
  if (typeof level === "string" && LEVELS[level.toLowerCase()] != null) {
    const min = LEVELS[level.toLowerCase()];
    out = out.filter((e) => (LEVELS[e.level] ?? 0) >= min);
  }
  const count = Math.min(500, Math.max(1, Number(n) || 100));
  return out.slice(-count);
}

export default log;
