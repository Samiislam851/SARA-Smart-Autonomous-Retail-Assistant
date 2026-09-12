// anthropic backend — official @anthropic-ai/sdk (the one allowed new dep).
// `new Anthropic()` resolves ANTHROPIC_API_KEY (or an `ant auth login`
// profile) from the environment — never hardcode a key here. Default model
// LLM_MODEL||"claude-haiku-4-5" (tiny model, per project ask; this is a
// 5-way classification, not a task needing a bigger model or extended
// thinking/budget_tokens).
//
// Untested live on this machine: no ANTHROPIC_API_KEY is configured here.
// Verified instead that the module loads, the request shape matches the
// installed SDK's types (node_modules/@anthropic-ai/sdk/resources/messages/
// messages.d.ts: `output_config: { format: { type: "json_schema", schema }
// }` is exactly `JSONOutputFormat`), and that an unauthenticated call fails
// cleanly through the AuthenticationError branch below (see NOTES.md).
//
// Uses `client.messages.create` (not `.parse`) — `.parse` is built around
// zodOutputFormat()'s typed parsing path; feeding it a raw JSON-Schema
// object (no zod schema) doesn't get us anything `.create` + a manual
// JSON.parse of the first text block doesn't already give us, and keeps
// this backend's error handling identical in shape to the other three.

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

let _client = null;
function client() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * SDK helper (node_modules/@anthropic-ai/sdk/helpers/json-schema.js, backed
 * by lib/transform-json-schema.js) builds the `output_config.format` object
 * for us — deep-clones the schema, so prompts/schema.json itself stays
 * unchanged. The transformer has no first-class null-in-type-array/
 * enum-with-null handling: unrecognized sibling keys (e.g. an `enum`
 * alongside `type`) get folded into `description` as a `{key: value}` note
 * rather than rejected — that's the SDK's intended fallback behaviour, not a
 * bug here, so it's left as-is. `validateProposalShape` (decide/index.js /
 * policy.js) remains the real shape guard regardless of what the model
 * returns.
 */

/**
 * run(prompt, { systemPrompt, schema, model, timeoutMs })
 *   -> { parsed, tokensIn, tokensOut, tokensTotalCodex: 0 }
 */
export async function run(prompt, { systemPrompt, schema, model, timeoutMs }) {
  let response;
  try {
    response = await client().messages.create(
      {
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: jsonSchemaOutputFormat(schema) },
      },
      { timeout: timeoutMs }
    );
  } catch (err) {
    // Mapped separately per brief: rate limit / connection / generic API
    // error (incl. 401 AuthenticationError) each get a short, distinct
    // reason so `trace.why: "llm error: <reason>"` is diagnosable without
    // leaking a raw SDK error body.
    if (err instanceof Anthropic.RateLimitError) throw new Error("rate limited");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("connection failed");
    if (err instanceof Anthropic.AuthenticationError) throw new Error("auth");
    if (err instanceof Anthropic.APIError) throw new Error(`api error ${err.status ?? ""}`.trim());
    // Missing/unresolvable credentials (no ANTHROPIC_API_KEY, no `ant auth
    // login` profile) fail BEFORE any request is sent — the SDK throws a
    // plain Error here, not an APIError/AuthenticationError subclass (no
    // HTTP response was ever made). Verified on this machine (no key
    // configured): "Could not resolve authentication method. Expected one
    // of apiKey, authToken, credentials, config, or profile to be set...".
    // Treated as the same "auth" category as a 401 from the API itself.
    if (/authentication method|api.?key/i.test(err.message || "")) throw new Error("auth");
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new Error("model refused");
  }

  const textBlock = response.content?.find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error("response had no text content block");
  }
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error("response text was not valid JSON");
  }

  const usage = response.usage || {};
  const tokensIn = usage.input_tokens || 0;
  const tokensOut = usage.output_tokens || 0;

  return { parsed, tokensIn, tokensOut, tokensTotalCodex: 0 };
}
