// pi-ram — RAM (ramem) long-term memory for pi.
//
// Drives the harness-agnostic `ram hook` handlers (the same ones Claude Code
// calls) from pi's extension events. Design invariants, mirroring RAM issue
// #105:
//
// - Additive-only: this extension may append context. It never sets
//   `block`, never mutates tool arguments, and never alters a tool result's
//   meaning — RAM context is always appended as an extra text block.
// - Silent on every failure mode: no ram binary, no daemon, no hit, timeout,
//   bad JSON — all of it means "nothing to say". A broken extension must not
//   break a session.
// - Gating lives in RAM: `ram hooks on|off <name>` and `ram hooks inject off`
//   work identically for pi; the handlers re-read RAM's config on every call
//   and exit silently when their gate is off.
//
// Event mapping (pi -> `ram hook` subcommand):
//   session_start / before_agent_start -> session-start (once per session)
//   before_agent_start (user prompt)   -> user-prompt
//   tool_result (edit/write)           -> pre-tool  (appended to the result)
//   tool_result (bash)                 -> post-tool-error (appended on error)
//   session_shutdown                   -> session-end (immediate ingest)
//   session_before_compact             -> pre-compact (flush transcript tail)
//
// Note on pre-tool timing: Claude Code injects file context *before* the edit
// executes; pi's cleanest injection point is the tool result the model sees
// next, so the file's history arrives right after the edit lands. Same value,
// one step later.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const HOOK_TIMEOUTS_MS = {
  "session-start": 5000,
  "user-prompt": 3000,
  "pre-tool": 3000,
  "post-tool-error": 5000,
  "session-end": 5000,
  "pre-compact": 15000,
};

let ramBin = null;
let binDead = false;

function resolveRam() {
  if (binDead) return null;
  if (ramBin) return ramBin;
  const local = `${process.env.HOME ?? ""}/.local/bin/ram`;
  ramBin = existsSync(local) ? local : "ram";
  return ramBin;
}

// Run `ram hook <sub>` with a JSON payload on stdin. Resolves to the trimmed
// stdout on exit 0, or null on any failure (missing binary, non-zero exit,
// timeout, spawn error). Never rejects.
function runHook(sub, payload, timeoutMs, signal) {
  return new Promise((resolve) => {
    const bin = resolveRam();
    if (!bin) return resolve(null);
    let child;
    try {
      child = spawn(bin, ["hook", sub], {
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
    } catch {
      return resolve(null);
    }
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(null);
    }, timeoutMs);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", (err) => {
      if (err?.code === "ENOENT") binDead = true;
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out.trim() || null : null);
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

const textOf = (content) =>
  (content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("\n");

// `ram hook` emits either plain markdown (session-start, daemon path) or a
// JSON envelope ("{"additionalContext": …}" or "{"hookSpecificOutput": {
// "additionalContext": …}}"). Inject only the context text: the envelope is
// token noise in pi (every injection, every escaped newline) and muddies the
// `<context source="ram">` marker boundaries that consumers strip on (ramem
// #107). Any parse failure degrades to the raw string — additive-only
// invariants unchanged.
function injectText(out) {
  if (!out) return out;
  try {
    const v = JSON.parse(out);
    const ctx = v?.hookSpecificOutput?.additionalContext ?? v?.additionalContext;
    return typeof ctx === "string" && ctx ? ctx : out;
  } catch {
    return out;
  }
}

export default (pi) => {
  let sessionContextDone = false;
  let lastUserPrompt = "";

  const sid = (ctx) => {
    try {
      return ctx.sessionManager?.getSessionId?.() ?? "";
    } catch {
      return "";
    }
  };

  const sessionFile = (ctx) => {
    try {
      return ctx.sessionManager?.getSessionFile?.() ?? "";
    } catch {
      return "";
    }
  };

  pi.on("session_start", () => {
    sessionContextDone = false;
    lastUserPrompt = "";
  });

  pi.on("message_start", (event) => {
    try {
      if (event.message?.role !== "user") return;
      const text = textOf(event.message.content);
      if (text.trim()) lastUserPrompt = text;
    } catch {}
  });

  // Runs before the first LLM call of an agent run. This is where session
  // context (once) and user-prompt entity context (per user message) are
  // injected, as a custom message the model sees.
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      if (binDead) return;
      const base = { session_id: sid(ctx), cwd: ctx.cwd };
      const parts = [];
      if (!sessionContextDone) {
        sessionContextDone = true;
        const out = await runHook("session-start", base, HOOK_TIMEOUTS_MS["session-start"], ctx.signal);
        const text = injectText(out);
        if (text) parts.push(text);
      }
      if (lastUserPrompt) {
        const prompt = lastUserPrompt;
        lastUserPrompt = "";
        const out = await runHook("user-prompt", { ...base, prompt }, HOOK_TIMEOUTS_MS["user-prompt"], ctx.signal);
        const text = injectText(out);
        if (text) parts.push(text);
      }
      if (parts.length > 0) {
        return {
          message: {
            customType: "ram_context",
            content: [{ type: "text", text: parts.join("\n\n") }],
          },
        };
      }
    } catch {}
  });

  // Append RAM context to the tool result the model sees next. Additive-only:
  // the original result content is preserved verbatim, RAM's block is appended.
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (binDead) return;
      const base = { session_id: sid(ctx), cwd: ctx.cwd };
      let out = null;
      if (event.toolName === "edit" || event.toolName === "write") {
        const file_path = event.input?.path ?? event.input?.file_path;
        if (file_path) {
          out = await runHook(
            "pre-tool",
            { ...base, tool_name: event.toolName, tool_input: { file_path } },
            HOOK_TIMEOUTS_MS["pre-tool"],
            ctx.signal,
          );
        }
      } else if (event.toolName === "bash") {
        out = await runHook(
          "post-tool-error",
          { ...base, tool_name: "Bash", tool_response: { stdout: textOf(event.content) } },
          HOOK_TIMEOUTS_MS["post-tool-error"],
          ctx.signal,
        );
      }
      const text = injectText(out);
      if (text) {
        return { content: [...(event.content ?? []), { type: "text", text }] };
      }
    } catch {}
  });

  // Data-safety: immediate ingest on shutdown and before compaction. The
  // daemon's file watcher already ingests ~/.pi/agent/sessions; these close
  // the poll-lag window. Fire-and-forget — injection is not involved.
  pi.on("session_shutdown", (event, ctx) => {
    try {
      if (binDead) return;
      runHook(
        "session-end",
        {
          session_id: sid(ctx),
          transcript_path: sessionFile(ctx),
          cwd: ctx.cwd,
          reason: "shutdown",
        },
        HOOK_TIMEOUTS_MS["session-end"],
        ctx.signal,
      );
    } catch {}
  });

  pi.on("session_before_compact", (_event, ctx) => {
    try {
      if (binDead) return;
      runHook(
        "pre-compact",
        { session_id: sid(ctx), transcript_path: sessionFile(ctx), trigger: "auto" },
        HOOK_TIMEOUTS_MS["pre-compact"],
        ctx.signal,
      );
    } catch {}
  });
};
