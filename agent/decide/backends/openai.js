// openai backend — plain `fetch` to a chat-completions endpoint. Works
// unmodified against OpenRouter, or a local Ollama server
// (OPENAI_BASE_URL=http://localhost:11434/v1, any API key string). Moved
// unchanged out of decide/llm.js as part of the backends/ refactor — see
// server/NOTES.md "LLM decider" for behaviour notes (two JSON modes,
// auto-detection, runtime 400 fallback).

const LLM_JSON_MODE_EXPLICIT = Boolean(process.env.LLM_JSON_MODE);
let LLM_JSON_MODE = process.env.LLM_JSON_MODE || null;

function buildOpenAiBody(mode, model, prompt, systemPrompt, schemaJson) {
  const systemContent =
    mode === "object"
      ? `${systemPrompt}\n\n## Output format\nRespond with ONLY a single JSON object (no prose, no markdown fences) that matches EXACTLY this JSON Schema:\n${JSON.stringify(schemaJson)}`
      : systemPrompt;
  const responseFormat =
    mode === "object"
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: { name: "decide", schema: schemaJson, strict: true } };
  return {
    model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: prompt },
    ],
    response_format: responseFormat,
  };
}

/**
 * detectJsonMode(model, schemaJson) — probes the endpoint once with a
 * trivial json_schema request. 400 -> the server doesn't support
 * response_format:json_schema; fall back to "object" mode for the rest of
 * the process. Any other outcome (including a probe-level error, e.g. no
 * network yet) defaults to "schema" — the real call will surface its own
 * error if that's wrong, and the runtime fallback in run() catches a late
 * 400 too.
 */
async function detectJsonMode(model) {
  if (LLM_JSON_MODE_EXPLICIT) return;
  const apiKey = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  if (!apiKey) {
    LLM_JSON_MODE = "schema";
    return;
  }
  const probeSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  try {
    const controller = new AbortController();
    // A dead/unreachable OPENAI_BASE_URL (e.g. during local dev against a
    // not-yet-started Ollama server) could otherwise stall this probe. 5s is
    // plenty for a same-host or same-network endpoint to respond either way.
    const timer = setTimeout(() => controller.abort(), 5_000);
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: 'Reply with {"ok":true}' }],
          response_format: { type: "json_schema", json_schema: { name: "probe", schema: probeSchema, strict: true } },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    LLM_JSON_MODE = res.status === 400 ? "object" : "schema";
  } catch {
    LLM_JSON_MODE = "schema";
  }
  console.log(`[llm] json mode auto-detected: ${LLM_JSON_MODE}`);
}

// Lazy, not run at module import — a server start whose mode/backend never
// touches openai shouldn't block on a network probe to an irrelevant
// OPENAI_BASE_URL. Deferred to first actual call via this singleton promise
// (only fires the probe once, even under concurrent first calls).
let jsonModeDetectPromise = null;
function ensureJsonModeDetected(model) {
  if (LLM_JSON_MODE_EXPLICIT || LLM_JSON_MODE !== null) return Promise.resolve();
  if (!jsonModeDetectPromise) jsonModeDetectPromise = detectJsonMode(model);
  return jsonModeDetectPromise;
}

/**
 * run(prompt, { systemPrompt, schema, model, timeoutMs })
 *   -> { parsed, tokensIn, tokensOut, tokensTotalCodex: 0 }
 */
export async function run(prompt, { systemPrompt, schema, model, timeoutMs }) {
  await ensureJsonModeDetected(model);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  let mode = LLM_JSON_MODE || "schema";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildOpenAiBody(mode, model, prompt, systemPrompt, schema)),
      signal: controller.signal,
    });
    // Runtime safety net: a probe can pass but a real call still 400 (e.g.
    // schema too complex for the server's grammar compiler). Retry once in
    // object mode and remember the switch for subsequent calls, unless the
    // mode was pinned explicitly via LLM_JSON_MODE.
    if (!res.ok && res.status === 400 && mode === "schema" && !LLM_JSON_MODE_EXPLICIT) {
      console.log("[llm] json_schema rejected (400) at runtime — switching to json_object mode");
      // Drain the first response's body before discarding `res` and issuing
      // the retry fetch — an unread body can keep the underlying connection
      // from being released back to the pool.
      await res.text().catch(() => {});
      LLM_JSON_MODE = "object";
      mode = "object";
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildOpenAiBody(mode, model, prompt, systemPrompt, schema)),
        signal: controller.signal,
      });
    }
    if (!res.ok) {
      throw new Error(`openai http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    if (!content) throw new Error("openai response missing message content");
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("openai response content was not valid JSON");
    }
    const tokensIn = body?.usage?.prompt_tokens ?? 0;
    const tokensOut = body?.usage?.completion_tokens ?? 0;
    return { parsed, tokensIn, tokensOut, tokensTotalCodex: 0 };
  } finally {
    clearTimeout(timer);
  }
}
