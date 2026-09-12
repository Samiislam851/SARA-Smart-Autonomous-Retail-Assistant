// gemini backend — official @google/genai SDK. Client auto-resolves
// GEMINI_API_KEY or GOOGLE_API_KEY from the environment (SDK internally
// checks GOOGLE_API_KEY first, warns if both are set) — never hardcode a
// key here. Default model LLM_MODEL||"gemini-2.5-flash-lite" (tiny, per
// project ask).
//
// Untested live on this machine: no GEMINI_API_KEY/GOOGLE_API_KEY configured
// here, so the exact model id ("gemini-2.5-flash-lite") was NOT verified
// against a live `models.list()` call as the brief asked — do that as a
// first step wherever a key becomes available (see NOTES.md). What IS
// verified: the module loads, the request/schema shape matches the
// installed SDK's types, and an unauthenticated call fails cleanly through
// the mapped-error branch below (observed message: "Could not load the
// default credentials..." when no key is set — the SDK falls through to
// Application Default Credentials rather than throwing immediately at
// construction).
//
// Structured output: rather than hand-converting our JSON Schema into
// Gemini's own `Schema`/`Type` dialect, pass plain JSON Schema (with a
// `$schema` key added, a local copy — prompts/schema.json itself is
// untouched) as `config.responseSchema`. The SDK's own
// `maybeMoveToResponseJsonSchema()` (node_modules/@google/genai/dist/node/
// index.cjs) detects the `$schema` key and moves it to `responseJsonSchema`
// for us, which IS plain JSON Schema (unlike `responseSchema`) — so
// `additionalProperties`, `type: ["string","null"]`, and `enum` with a
// `null` member all pass through unmodified.

import { GoogleGenAI, ApiError } from "@google/genai";

let _client = null;
function client() {
  if (!_client) _client = new GoogleGenAI({});
  return _client;
}

/**
 * run(prompt, { systemPrompt, schema, model, timeoutMs })
 *   -> { parsed, tokensIn, tokensOut, tokensTotalCodex: 0 }
 */
export async function run(prompt, { systemPrompt, schema, model, timeoutMs }) {
  const geminiSchema = { $schema: "http://json-schema.org/draft-07/schema#", ...schema };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await client().models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: geminiSchema,
        abortSignal: controller.signal,
      },
    });
  } catch (err) {
    // Rate-limit/429 checked FIRST — a 429 body can still mention "quota"/
    // "key" text that would otherwise misfire the generic auth-message
    // regex below. ApiError (HTTP response received) with a 401/403 status
    // is an unambiguous auth failure. Missing credentials can ALSO fail
    // before any HTTP call is made — the SDK falls through to Application
    // Default Credentials and throws a plain Error whose message names
    // "credentials" or "API key" (verified on this machine, no key
    // configured: "Could not load the default credentials..."). Both map to
    // the same short "auth" reason so `trace.why` stays diagnosable without
    // leaking a raw error body, matching the anthropic backend's
    // convention. `instanceof ApiError` (SDK export) rather than a
    // constructor-name string match.
    if (err instanceof ApiError && err.status === 429) throw new Error("rate limited");
    if (/rate.?limit|quota/i.test(err?.message || "")) throw new Error("rate limited");
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      throw new Error("auth");
    }
    if (/credentials|api.?key/i.test(err?.message || "")) throw new Error("auth");
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = response.text;
  if (!text) throw new Error("response had no text content");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("response text was not valid JSON");
  }

  const usage = response.usageMetadata || {};
  const tokensIn = usage.promptTokenCount || 0;
  const tokensOut = usage.candidatesTokenCount || 0;

  return { parsed, tokensIn, tokensOut, tokensTotalCodex: 0 };
}
