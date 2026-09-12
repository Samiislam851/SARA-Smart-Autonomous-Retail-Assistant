// server/decide/llm.js's buildSystemPrompt() probe — the AGENT_SENSITIVITY=
// demo prompt block (category: prompt/policy calibrated for a rehearsal, not
// a real shopper — see server/prompts/decide.md's demoSensitivityBlock()).
//
// policyConfig (server/policy-config.js) is a module-level singleton read
// once from process.env at import — so exercising both "demo" and "normal"
// sensitivity needs two separate processes, not two imports in one. Spawns
// `node --input-type=module -e '...'` as a child with the env var set,
// prints a JSON result, and asserts on it here — same shape as
// coalesce.test.js/outcome.test.js's child-process style, just without the
// HTTP server (this only needs the module, not a live decide() call).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LLM_MODULE = path.join(__dirname, "decide", "llm.js");

const FAKE_STATE_WITH_SIGNAL = JSON.stringify({
  page: "/product/x",
  gateSignals: [{ name: "variant_churn", template: "variant_help" }],
});
const FAKE_STATE_NO_SIGNAL = JSON.stringify({ page: "/product/x", gateSignals: [] });

function runPrompt(env, stateJson) {
  const script = `
    import { buildSystemPrompt } from ${JSON.stringify(LLM_MODULE)};
    const state = ${stateJson};
    process.stdout.write(buildSystemPrompt(state));
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

// (i) normal sensitivity (default/unset) — no demo block, even with a fired signal.
{
  const prompt = runPrompt({ AGENT_SENSITIVITY: "normal" }, FAKE_STATE_WITH_SIGNAL);
  assert.ok(!prompt.includes("Demo sensitivity mode"), "normal sensitivity must never get the demo block");
  console.log("(i) ok — normal sensitivity: no demo block even with signals_fired");
}

// (ii) demo sensitivity, no fired signal this call -> no demo block (only injected when a signal actually fired).
{
  const prompt = runPrompt({ AGENT_SENSITIVITY: "demo" }, FAKE_STATE_NO_SIGNAL);
  assert.ok(!prompt.includes("Demo sensitivity mode"), "demo sensitivity with no gateSignals must not get the block");
  console.log("(ii) ok — demo sensitivity, no signal fired: no demo block");
}

// (iii) demo sensitivity + a fired signal -> the block is appended, names the signal and its template.
{
  const prompt = runPrompt({ AGENT_SENSITIVITY: "demo" }, FAKE_STATE_WITH_SIGNAL);
  assert.ok(prompt.includes("Demo sensitivity mode"), "demo sensitivity + fired signal must get the block");
  assert.ok(prompt.includes("variant_churn"), "block must name the fired signal");
  assert.ok(prompt.includes('"variant_help"'), "block must name the matching template via for_signals");
  assert.ok(prompt.startsWith("You are a shop assistant"), "decide.md's own body must still come first, unchanged");
  console.log("(iii) ok — demo sensitivity + fired signal: block appended, names signal + template");
}

console.log("llm-prompt.test: all assertions passed");
