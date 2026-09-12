// Generic subprocess runner shared by shell-out LLM backends (codex, claude).
// No shell (`execFile`, argv array), prompt on stdin, hard timeout that kills
// the whole process group (not just the direct child — a CLI that spawns a
// grandchild otherwise survives a plain `child.kill()`, see NOTES.md "Known
// limits" / M-review), stdout+stderr captured with a hard 64KB cap each, and
// an optional unique out-file that's always cleaned up (success, error, or
// timeout path).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_CAPTURE_BYTES = 64 * 1024;

function appendCapped(buf, chunk) {
  if (buf.length >= MAX_CAPTURE_BYTES) return buf;
  const room = MAX_CAPTURE_BYTES - buf.length;
  return buf + chunk.slice(0, room);
}

/**
 * runShell({ bin, args, input, timeoutMs, outFile, env, cwd })
 *   -> Promise<{ stdout, stderr, outFileContents }>
 *
 * - `input` (string, optional) is written to the child's stdin then the
 *   stream is closed.
 * - `outFile` (string, optional): if given, read back as utf8 after the
 *   child exits successfully and removed in a `finally`-style cleanup
 *   regardless of outcome.
 * - `env`/`cwd` optional overrides; `env` defaults to `process.env`.
 * - Rejects with an Error on timeout, non-zero exit, or spawn error. The
 *   Error carries `.stdout`/`.stderr`/`.code` for non-zero-exit rejections.
 */
export function runShell({ bin, args, input, timeoutMs, outFile, env, cwd }) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Calling execFile WITHOUT a callback returns a plain ChildProcess (same
    // as spawn) instead of engaging execFile's own internal buffering/
    // maxBuffer-based callback path — we manage capture and completion
    // ourselves so we can enforce our own 64KB cap and process-group kill.
    // `detached: true` makes this child the leader of its own process
    // group (pid === pgid), so `process.kill(-pid)` below reaches any
    // grandchild the CLI spawned too, not just this direct child.
    const child = execFile(bin, args, { detached: true, env, cwd });

    const cleanupOutFile = () => {
      if (!outFile) return;
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* best effort */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
      }
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout = appendCapped(stdout, d.toString());
    });
    child.stderr?.on("data", (d) => {
      stderr = appendCapped(stderr, d.toString());
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupOutFile();
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      let outFileContents = null;
      if (outFile) {
        try {
          outFileContents = fs.readFileSync(outFile, "utf8");
        } catch {
          /* may not exist, e.g. if the process errored before writing it */
        }
      }
      cleanupOutFile();

      if (timedOut) {
        reject(new Error(`timeout after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const err = new Error(
          `${path.basename(bin)} exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${stderr.slice(0, 200)}`
        );
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
        return;
      }
      resolve({ stdout, stderr, outFileContents });
    });

    // A child that exits (or never reads stdin) before we finish writing
    // triggers EPIPE on the write — without a listener that's an unhandled
    // 'error' event on the stream, which crashes the whole process. The
    // `child.on("error"/"close", ...)` handlers above already settle the
    // promise correctly in that case, so this listener only needs to
    // swallow the stream-level EPIPE itself.
    child.stdin?.on("error", () => {
      /* EPIPE etc. — child.on("close"/"error") above settles the promise */
    });
    try {
      if (input != null) {
        child.stdin.write(input);
      }
      child.stdin.end();
    } catch {
      /* best effort — same reasoning as the stdin "error" listener above */
    }
  });
}
