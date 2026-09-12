// codex backend — spawns the local `codex` CLI via the shared shell runner
// (backends/shell.js). Behaviour unchanged from the pre-refactor inline
// version in decide/llm.js: `exec --ephemeral --skip-git-repo-check -s
// read-only -C <fixed empty tmp dir> --output-schema <schema> -o <unique
// out file> [-m $LLM_MODEL]`, prompt on stdin, `tokens used\n<N,NNN>`
// parsed from stdout/stderr for the codex-reported total-token figure.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShell } from "./shell.js";

const CODEX_BIN = process.env.CODEX_BIN || "codex";

// codex exec prints a "tokens used\n<N,NNN>" line to stdout after the
// response (probed once, see server/NOTES.md "Cost design" section). That
// figure is the TOTAL tokens for the call, including codex's own system
// instructions (not just our prompts/decide.md + state) — it is NOT what an
// API deployment of the same prompt would be billed. We record it separately
// (tokensTotalCodex) and also estimate OUR prompt+state / output tokens via
// chars/4 (tokensInEst/tokensOutEst) as the API-comparable numbers.
const TOKENS_USED_RE = /tokens used\s*\r?\n\s*([\d,]+)/i;

let workdir = null;

/** Fixed empty workdir + copied schema file for the codex CLI, created once
 * on first use and cleaned up on process exit/SIGINT/SIGTERM. */
function ensureWorkdir(schemaSrc) {
  if (workdir) return workdir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-llm-codex-"));
  const schemaDest = path.join(dir, "schema.json");
  fs.copyFileSync(schemaSrc, schemaDest);
  workdir = { dir, schemaDest };

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  process.on("exit", cleanup);
  // `exit` alone never fires on SIGINT/SIGTERM (docker stop, Ctrl-C) unless
  // something else calls process.exit() first. Explicit handlers clean up
  // the tmp dir, then re-raise so the process still terminates with the
  // conventional 128+signal exit code. Deliberately NOT calling
  // `server.close()` here first: this module has no reference to the http
  // server (index.js owns it) and threading one through just for a graceful
  // drain on top of an already-hard process.exit() isn't worth the coupling
  // for a debug/dev-only CLI backend — process.exit() below is immediate by
  // design.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
  return workdir;
}

/**
 * run(prompt, { systemPrompt, schemaPath, model, timeoutMs })
 *   -> { parsed, tokensIn, tokensOut, tokensTotalCodex }
 */
export async function run(prompt, { systemPrompt, schemaPath, model, timeoutMs }) {
  const { dir, schemaDest } = ensureWorkdir(schemaPath);
  const outFile = path.join(dir, `out-${randomUUID()}.json`);
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-C",
    dir,
    "--output-schema",
    schemaDest,
    "-o",
    outFile,
  ];
  if (model) args.push("-m", model);
  args.push("-");

  const fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;

  let stdout, stderr, outFileContents;
  try {
    ({ stdout, stderr, outFileContents } = await runShell({
      bin: CODEX_BIN,
      args,
      input: fullPrompt,
      timeoutMs,
      outFile,
    }));
  } catch (err) {
    if (/^timeout after/.test(err.message)) throw err;
    throw new Error(`codex exited with error: ${String(err.message).slice(0, 200)}`);
  }

  if (outFileContents == null) {
    throw new Error("codex produced no output file");
  }
  let parsed;
  try {
    parsed = JSON.parse(outFileContents);
  } catch {
    throw new Error("codex output was not valid JSON");
  }

  const tokensMatch = `${stdout}\n${stderr}`.match(TOKENS_USED_RE);
  const tokensTotalCodex = tokensMatch ? Number(tokensMatch[1].replace(/,/g, "")) : 0;
  const tokensIn = Math.round(fullPrompt.length / 4);
  const tokensOut = Math.round(JSON.stringify(parsed).length / 4);

  return { parsed, tokensIn, tokensOut, tokensTotalCodex };
}
