// claude backend — Claude Code headless (`claude -p`), via the shared shell
// runner. Verified interactively on this machine (2026-09-11):
//
//   claude -p --model haiku --output-format json --tools "" \
//     --no-session-persistence --system-prompt "<SYSTEM_PROMPT>" \
//     --json-schema "<schema.json>"          (state+"Decide." on stdin)
//
// returns in ~5-16s a JSON envelope on stdout. Flags used and why:
//   --tools ""              disables ALL tools (per `claude --help`: "" = no
//                            tools, "default" = all tools) — the decider must
//                            never get Bash/Read/etc, it only classifies.
//   --no-session-persistence  don't write a resumable session to disk for
//                            every one of these throwaway calls.
//   --system-prompt          our prompts/decide.md text, passed as a flag
//                            (NOT prepended to the stdin prompt like the
//                            codex backend) since claude -p has a dedicated
//                            flag for it.
//   --json-schema            structured-output flag DOES exist on this CLI
//                            (unlike codex's --output-schema-by-file, this
//                            one takes the schema inline) — when present the
//                            envelope includes BOTH a `.result` string AND a
//                            pre-parsed `.structured_output` object. We
//                            prefer `.structured_output`; `.result` (with
//                            ```json fence stripping) is a fallback for any
//                            older/odd CLI build that omits it.
//   --output-format json     the envelope shape probed above: `.result`
//                            (string), `.structured_output` (object, when
//                            --json-schema given), `.is_error`,
//                            `.duration_ms`, `.usage`.
//
// Nested-session note: the server process itself sometimes runs INSIDE a
// Claude Code session (dev), which sets CLAUDECODE=1 in its env. Tested
// in one run, a nested `claude -p` call SUCCEEDED even with CLAUDECODE=1 still
// set in the child's env (no refusal observed). We still strip it before
// spawning as a no-cost defensive measure, in case a future CLI version
// changes that behavior.

import { runShell } from "./shell.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

/**
 * run(prompt, { systemPrompt, schema, model, timeoutMs })
 *   -> { parsed, tokensIn, tokensOut }
 *
 * `schema` is the parsed schema.json object (not a path) — passed inline via
 * --json-schema.
 */
export async function run(prompt, { systemPrompt, schema, model, timeoutMs }) {
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt",
    systemPrompt,
    "--json-schema",
    JSON.stringify(schema),
  ];

  const env = { ...process.env };
  delete env.CLAUDECODE;

  let stdout;
  try {
    ({ stdout } = await runShell({
      bin: CLAUDE_BIN,
      args,
      input: `${prompt}\nDecide.`,
      timeoutMs,
      env,
    }));
  } catch (err) {
    if (/^timeout after/.test(err.message)) throw err;
    throw new Error(`claude exited with error: ${String(err.message).slice(0, 200)}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error("claude output was not a valid JSON envelope");
  }
  if (envelope.is_error) {
    throw new Error(`claude reported an error: ${String(envelope.result ?? "").slice(0, 150)}`);
  }

  let parsed = envelope.structured_output;
  if (!parsed || typeof parsed !== "object") {
    // Fallback: parse `.result`, stripping a ```json ... ``` fence if the
    // model wrapped it (observed without --json-schema; kept as a defensive
    // fallback here too in case a CLI build omits structured_output).
    let raw = String(envelope.result ?? "").trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("claude .result was not valid JSON (after fence-stripping)");
    }
  }

  // Token usage: prefer the envelope's own usage figures (input_tokens +
  // any cache-creation/cache-read tokens, all of which are billed input
  // tokens under Anthropic's pricing; output_tokens as-is). Fall back to a
  // chars/4 estimate, same convention as the codex backend, only if usage
  // is entirely absent.
  const usage = envelope.usage;
  let tokensIn, tokensOut;
  if (usage && typeof usage.input_tokens === "number") {
    tokensIn =
      usage.input_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    tokensOut = usage.output_tokens || 0;
  } else {
    const fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
    tokensIn = Math.round(fullPrompt.length / 4);
    tokensOut = Math.round(JSON.stringify(parsed).length / 4);
  }

  return { parsed, tokensIn, tokensOut, tokensTotalCodex: 0 };
}
