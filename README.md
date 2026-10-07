# pi-ram

Long-term memory for [pi](https://github.com/earendil-works/pi-coding-agent),
powered by RAM (the `ramem` project). RAM indexes your agent
sessions into a local hybrid (vector + BM25) store; this extension drives
RAM's harness-agnostic `ram hook` handlers from pi's extension events so the
model gets past context at fixed points — the same behaviour Claude Code gets
from `ram setup`.

## Install

Requires the `ram` binary from the RAM project on your `PATH` (or at
`~/.local/bin/ram`) and a RAM index initialised (`ram init`).

```bash
pi install git:github.com/planetf1/pi-ram
```

Local development:

```bash
pi install /path/to/pi-ram
```

Verify it is loaded: `pi list`.

## What it does

| pi event | `ram hook` called | What the model sees |
|---|---|---|
| `before_agent_start` (once per session) | `session-start` | Top relevant memories for this project, as a context message |
| `before_agent_start` (per user message) | `user-prompt` | Cached summaries of files/issues/symbols the prompt mentions |
| `tool_result` after `edit`/`write` | `pre-tool` | The cached history of the file just changed, appended to the tool result |
| `tool_result` after `bash` | `post-tool-error` | Closest past context for a failed command, appended to the tool result |
| `session_shutdown` | `session-end` | (nothing — immediate transcript ingest) |
| `session_before_compact` | `pre-compact` | (nothing — flushes the transcript tail before compaction) |

Lookup hooks are SQLite-only (~16 ms); the error hook runs one rerank-off
hybrid search (<500 ms). Nothing calls an LLM on the hot path.

## Control

All control lives in RAM, identical to Claude Code:

```bash
ram hooks                # list every hook: state, risk class, wiring, telemetry
ram hooks on pre-tool    # enable a hook (off by default: user-prompt, pre-tool, post-tool-error)
ram hooks off user-prompt
ram hooks inject off     # master switch: silence all context injection
```

The handlers re-read RAM's config on every call, so toggles take effect at
the next hook fire — no pi restart.

## Guarantees

- **Additive-only**: the extension appends context. It never blocks or
  modifies a tool call, never edits tool arguments, and preserves original
  tool results verbatim (RAM context is appended as an extra text block).
- **Silent on every failure**: no `ram` binary, no daemon, no hit, timeout,
  or bad input all mean "nothing to say". A broken extension must not break
  a session.
- **Gated by RAM defaults**: the three context-injection hooks are off until
  you enable them (`ram hooks on <name>`); the data-safety hooks
  (session-end, pre-compact) are on.

## Telemetry

Every injection is recorded by RAM (state DB + `ram hooks` telemetry line +
OTel `ram_hook_injections_total` when an OTLP endpoint is configured). pi
sessions are also ingested passively by RAM's file watcher
(`~/.pi/agent/sessions`), so the store works even before this extension is
installed.
