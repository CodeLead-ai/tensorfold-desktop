# TensorFold Desk — specification for a local control and monitoring app (side project)

2026-09-29. Peter's ask: "we may need to build a webui for tensorfold as a side project … this must be an electron app (unless you think a web app is better)". Audience: Peter, and the agent that builds it (the build prompt is `docs/tensorfold-desk-build-prompt.md`). Facts below were read from the installed TensorFold 0.3.6.2 on Peter's Mac (64 GB, M-series) on 2026-09-29; nothing is assumed.

## 1. Decision: Electron, not a browser app

The app has to spawn and stop a local process (`tensorfold serve`), read its stdout continuously, browse the file system for checkpoints, run `lms` to coexist with LM Studio, and sit in the menu bar while a run lasts. A browser tab cannot do any of that without a local daemon, and that daemon is exactly Electron's main process. Electron also matches the Session Log Viewer's stack (electron-vite, React 18, TypeScript, vitest), so the two apps can share tooling and, later, the renderer could be embedded in the VS Code extension's webview. Recommendation: **Electron, menu-bar presence plus one main window**, macOS arm64 first (TensorFold's other target, DGX Spark, is Linux; keep the process manager platform-neutral, ship macOS).

## 2. What TensorFold offers today (the surface the app can use)

### 2.1 CLI (`tensorfold --version` → 0.3.6.2)

- `tensorfold serve <model> [flags]` — the only long-running command. `<model>` is a Hugging Face repo id or a **model directory** (LM Studio's MLX checkpoints work as directories: `/Users/peter/.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit`).
  - endpoint: `--host` (default 127.0.0.1), `--port`, `--name` (the model id clients ask for), `--alias` (more ids).
  - generation: `--context` (prompt + reply window; this Mac admits 89,600 for the 27B 8-bit; 131072 is refused), `--max-tokens` (default 4096 when a request does not say), `--temperature`, `--top-p`, `--top-k`, `--thinking/--no-thinking`, `--reasoning-effort {low,medium,xhigh}` (default medium), `--thinking-budget`.
  - drafting and caches: `--no-drafts` (serial reference), `--drafter {auto|none|repo-or-dir}` (auto = the family's draft model when pulled; for Qwen3.8 dense: `z-lab/Qwen3.8-27B-DFlash2`), `--drafter-bits` (default 4), `--mtp-drafts`, `--mtp-confidence`, `--lane-kernels {auto,on,off}`, `--prompt-cache-gib`, `--checkpoint-slots`, `--spill-gib`, `--snapshot-dir` (default `~/.cache/tensorfold/prefix-snapshots`), `--max-snapshots`, `--parallel {n|auto}` (Mac: up to 8 as memory allows), `--mlx-cache-gib` (default 8), `--ssd-experts`, `--ple-on-ssd`, `--no-update-check`.
  - NVIDIA-only: `--backend`, `--tp`, `--rank`, `--master`, `--master-port`, `--kv-dtype`. Show them under an "NVIDIA (DGX Spark)" disclosure; they do nothing on a Mac.
- `tensorfold info <model>` — reads config.json only (safe while serving): model_type, family, engine, kernels, layers, hidden size, vocab, max_position_embeddings, quantization, sampling defaults, "runs on".
- `tensorfold models` — the families and the checkpoints/drafters they are tested with (Gemma 4, GLM-5.3-Flash, Nemotron 3.5 Lightning, Qwen3.8 dense, Qwen3.6 MoE, Qwen3.8 Flash Next).
- `tensorfold pull <repo> [...]` — downloads from Hugging Face into `~/.cache/huggingface/hub/models--<org>--<name>/snapshots/<sha>` (progress on stdout).
- `tensorfold update` — installs the newest release from GitHub. Env: `TENSORFOLD_NO_UPDATE_CHECK=1`, `TENSORFOLD_MEMORY_LIMIT_GB` (raises the memory budget; the startup line says the ceiling, 51.8 on this Mac).
- Install on this Mac: a venv, `/Users/peter/Projects/codelead-bench/tensorfold-venv/bin/tensorfold` (python3.14, MLX). The app must let the user point at any `tensorfold` binary and default to `which tensorfold`, then that venv path.

### 2.2 HTTP (OpenAI-compatible, default `http://127.0.0.1:8080/v1`)

- `GET /v1/models` → `{"data":[{"id":"Qwen3.8-27B-MLX-8bit","owned_by":"tensorfold",…}]}` — identity.
- `GET /health` → `{"status":"ok","model":…,"model_ids":[…],"max_batch_size":8,"warming":false,"memory":{"active","cache","peak","budget","mlx_budget","footprint"}}` (bytes) — the only live metrics endpoint. No token counters.
- `POST /v1/chat/completions` (streaming and not; `reasoning_effort` accepted; thinking arrives as `reasoning_content`).
- `/metrics`, `/slots`, `/stats`, `/v1/stats` → 404. Everything per request comes from **stdout**.

### 2.3 The serve log (stdout) — the app's main data source

Startup (one line each, in this order):
```
[tensorfold] memory budget 44.8 GiB: MLX's buffers up to 41.8 GiB, 3 GiB for the rest of the process; TENSORFOLD_MEMORY_LIMIT_GB can raise it to 51.8
[tensorfold] loading Qwen3.8-27B-MLX-8bit: Qwen3.8 dense (qwen3_5)
[tensorfold] lane kernels on: 9 matmul shapes warmed, fused projections {'zba': 48, 'kv': 16, 'gu': 64}
[tensorfold] drafter /Users/peter/.cache/huggingface/hub/models--z-lab--Qwen3.8-27B-DFlash2/snapshots/50307d4c… block=8 bits=4
[tensorfold] 31.1 GiB of weights kept resident
[tensorfold] prompt chunks of up to 2,048 tokens, cut at replies 256+ tokens apart
[tensorfold] concurrency: up to 8 requests share each round; memory budget 36.2 GB (MLX's share 41.8 GB, or 70% of 64 GB less 8.6 GB in use elsewhere); a stream 163 MB at 64 tokens, 394 MB at 2,112, then 114.0 KB a token
[tensorfold] loaded system-block snapshot tokens=640 in 0.0s
[tensorfold] serving Qwen3.8-27B-MLX-8bit at http://127.0.0.1:8080/v1 (sampling: temperature 1.0, top_k 20, top_p 0.95; drafts: on; context: 89600; loaded in 31.0s)
```
Per request (the line to parse; every field is `key=value`, the parenthesis at the end is the prefix-cache tally):
```
[tensorfold] done req-07bcd37c1ff7 prompt=23124 cached=0 thinking=True effort=medium tokens=4598 sha=5c969274b94d finish=stop tok/s=60.5 ttft=41.74s prefill=41.71s rounds=773 accepted=3824/12792 ms/round=98.2 forward=98.2 draft=0.0 post=0.0 rows=17.5 checkpoints=0 (0.00 GiB, hits=13 misses=17 evictions=29)
```
Refusals (the request was admitted or not BEFORE prefill; both are cheap, both must be shown as refusals, not errors of the app):
```
[tensorfold] start failed req-… cached=0: RequestError: This request needs about 41.8 GiB of the 41.8 GiB MLX may use (this server's 44.8 GiB memory budget less 3.0 GiB for the rest of the process); it fits up to 25,225 tokens in the prompt with 64,000 reply tokens. Shorten the prompt or max_tokens (the reply is reserved in full), or start the server with a smaller --context …
```
and the window check, answered as HTTP 400 (not in the log as "start failed"): "the rendered prompt has 25,548 tokens and requests 64,000 reply tokens; this server's context window is 65,536. … request at most 39,988 reply tokens".
Other lines: access lines `[tensorfold] 127.0.0.1 "POST /v1/chat/completions HTTP/1.1" 200 -` (the access line is written when headers go out, so a refused stream still logs 200), `read conversation snapshot tokens=9370 from disk in 0.06s`, `read system-block snapshot …`. The log is line-oriented UTF-8; the app reads it from the child's stdout (never from a file it did not write).

### 2.4 Memory model (what the gauge must explain)

- Budget = 70% of RAM minus "in use elsewhere" at start (LM Studio's loaded model counts: **unload it first**, `lms unload --all`), split into MLX buffers (weights + KV + caches) and 3 GiB for the process. `TENSORFOLD_MEMORY_LIMIT_GB` raises it.
- The reply is **reserved in full** at admission: a request asking `max_tokens` 64,000 on a 25k prompt needs ~41.8 GiB and is refused even though the window admits it. Clients that treat `max_tokens` as a cap (LM Studio's habit) hit this; CodeLead's provider retries at the stated cap since 2026-09-29. The app shows refusals with the message and, in the request row, the `max_tokens` the client asked when the message states it.
- `/health.memory` gives active / cache / peak / budget / mlx_budget / footprint in bytes: gauge = active over mlx_budget, with cache and peak as ticks.

### 2.5 Coexistence with LM Studio (this machine's other server)

`lms ps` (and `lms ps --json`) lists LM Studio's loaded models; `lms unload --all` frees them; the endorsed reload is a script (`codelead-bench/reload-model.sh`) that reloads and diffs the configuration. The app offers "unload LM Studio, then serve" and "stop, then run the restore command" with the commands user-configurable (the app never hardcodes CodeLead's paths; it ships with those as the first preset on Peter's machine only through settings).

### 2.6 Checkpoints on disk

- LM Studio: `~/.lmstudio/models/<publisher>/<name>/` (MLX directories carry `config.json` + safetensors; GGUF ones are not servable by TensorFold: skip when no `config.json` or when `tensorfold info` fails).
- Hugging Face cache: `~/.cache/huggingface/hub/models--<org>--<name>/snapshots/<sha>/` (drafters live here after `pull`).
- TensorFold's own: `~/.cache/tensorfold/{prefix-snapshots,session-snapshots}`.

## 3. What we need (features, by priority)

**P0 — control and see (the reason for the app)**
1. **Server panel.** Start / stop / restart. A form over the serve flags in 2.1, grouped as the CLI groups them, with sensible defaults, validation (port free, model dir has `config.json`, context is a positive integer), and the **exact command line shown and copyable**. Presets: "CodeLead endorsed" (`--port 8080 --context 89600 --reasoning-effort medium --no-update-check`, drafter auto), "Serial reference" (`--no-drafts`), "Custom". State machine: stopped → loading (the startup lines stream in; "loaded in N s" ends it) → serving → stopping; server death shows the exit code and the last 50 lines.
2. **Status header.** Model id, port, context, drafts on/off with the drafter's name, sampling, "loaded in", uptime, TensorFold version, backend (MLX), parallel lanes.
3. **Memory gauge** from `/health` every 2 s while serving: active / cache / peak against mlx_budget and budget, footprint, with the numbers in GiB and the startup line's budget sentence quoted once.
4. **Request feed** parsed from stdout: a table (time, req id, prompt tokens, cached, effort, thinking, reply tokens, finish, tok/s, ttft, prefill, accepted x/y and the ratio, ms/round, prefix-cache hits/misses/evictions, sha) plus a live tok/s sparkline and a header with the session's totals (requests, tokens in/out, mean tok/s, mean prefill rate = prompt/prefill, acceptance ratio). Refusals are rows too, highlighted, with the message.
5. **Log pane.** The raw stream, follow mode, a filter box, copy; the app writes its own copy to `~/Library/Application Support/TensorFold Desk/logs/<start-stamp>.log`.

**P1 — the rest of the loop**
6. **Checkpoint library.** Scan the folders in 2.6 (paths configurable), one card per servable checkpoint with `tensorfold info` (cached), the family, quantization, max context, size on disk, whether it is a family TensorFold lists as tested (`tensorfold models`), and whether its drafter is pulled. "Serve this" pre-fills the server form.
7. **Pull.** A Hugging Face repo id → `tensorfold pull` with progress from stdout; the family list's drafters offered one click away.
8. **LM Studio coexistence** as in 2.5: show what LM Studio has loaded, "unload and serve", "stop and restore" with configurable commands.
9. **Probe.** Send one chat completion (prompt text, max_tokens, reasoning_effort, stream) and show the measured tok/s and ttft beside the server's own `done` line for the same request; a saved probe set (the bench's alternation probe: a real prompt replayed solo and after a big generation).
10. **Serving snapshot.** Export the running configuration as JSON (command line, every flag, version, checkpoint path and sha, drafter, started-at) — the bench's serving-config record; also "copy for a runner" (the `CODELEAD_BASE_URL`/`CODELEAD_MODEL` lines).
11. **Menu-bar item.** State dot, model, last tok/s; start/stop from the menu.

**P2 — later**
12. Session history (JSON per serve session: config + per-request stats), with a summary table across sessions.
13. Several servers (ports) at once, when memory allows.
14. `tensorfold update` with the changelog shown; a notice when a newer release exists (the CLI prints one unless `--no-update-check`).
15. Notifications: refusal bursts, server died, memory over 95% of budget.

**Non-goals.** Not a chat client (the probe is a measuring tool). Not an LM Studio replacement for GGUF. No telemetry, no accounts, no network beyond localhost and Hugging Face pulls the user starts. No CUDA/DGX features on macOS beyond showing the flags.

## 4. Architecture

- **Stack:** Electron 31+ with electron-vite; React 18; TypeScript strict; Tailwind v4 or plain CSS variables; vitest for unit tests; electron-builder for a signed-or-unsigned arm64 `.dmg`. Match `codelead-sessionvoewer`'s scripts (`dev`, `build`, `test`, `typecheck`, `lint`).
- **Main process** (`src/main/`): `ProcessManager` (spawn `tensorfold serve` with `child_process.spawn`, argv built from a typed config; SIGTERM then SIGKILL after 5 s; exit code and last lines kept), `LogParser` (pure module: a line in, an event out — startup, serving, done, refused, access, snapshot, unknown), `HealthPoller` (fetch `/health` every 2 s while serving; back off on failure), `Checkpoints` (scan + `tensorfold info` cache), `LmStudio` (`lms ps --json`, `lms unload --all`, user command), `Settings` (electron-store JSON), `SnapshotWriter`.
- **Preload** (`src/preload/`): `contextBridge` with a typed API (`startServer(config)`, `stopServer()`, `onEvent(cb)`, `getHealth()`, `listCheckpoints()`, `pull(repo)`, `probe(request)`, `exportSnapshot()`, settings get/set). `contextIsolation: true`, `nodeIntegration: false`.
- **Renderer** (`src/renderer/`): views Server, Requests, Checkpoints, Probe, Log, Settings; a store (zustand) fed by IPC events; tabular numbers; a sparkline component (canvas). No network calls from the renderer except through preload.
- **Shared** (`src/shared/`): the config type, the event types, the parser's output types — one contract file, tested.
- **Dev without a 27B:** a `mock/fake-tensorfold.mjs` that answers `/v1/models`, `/health` (memory values drifting) and `/v1/chat/completions` (streams filler) and prints the fixture log lines (Appendix A) on a timer; `npm run dev:mock` points the app at it. Required, so the UI can be built and tested on any machine.

## 5. Look

Dark-first, the CodeLead-AI palette (ground `#060B18`, card `#0D1526`, line `#1B2740`, text `#E8EEF8`, muted `#8FA0BC`, accent `#2F7CFF` → `#38C6FF`, white `#F4F7FB`; light variant on `#F3F6FB`/`#FFFFFF`), monospace for ids and numbers, `font-variant-numeric: tabular-nums` everywhere numbers line up. Left rail with the six views; the status header across the top; the gauge and the sparkline are the two graphics that matter. Name in the title bar: "TensorFold Desk" (working title; Peter names it).

## 6. Acceptance criteria (what "done" means)

1. Start the endorsed preset against the real `tensorfold` on this Mac: the header reaches "serving" with model, port, context and "loaded in"; stop returns to "stopped" with the exit code.
2. Every line in Appendix A parses into the documented event with the exact field values (unit tests; fixture file in the repo).
3. During a run, the request feed shows each `done` line within a second of it appearing; the sparkline and the totals update; a refusal line appears highlighted with its message.
4. The memory gauge tracks `/health` (visible change during a long prefill).
5. "Unload LM Studio, then serve" works with `lms` present and degrades to a clear message when it is not.
6. Export snapshot writes the JSON of 3.10 and the file reproduces the command line.
7. `npm run typecheck`, `npm test`, `npm run build` green; `npm run dev:mock` runs the UI without a model; the `.dmg` opens on macOS arm64.
8. Nothing leaves the machine: a network audit of the renderer shows only 127.0.0.1 and, during a pull, huggingface.co from the CLI child.

## Appendix A — parser fixtures (verbatim, 2026-09-29, this Mac)

```
[tensorfold] memory budget 44.8 GiB: MLX's buffers up to 41.8 GiB, 3 GiB for the rest of the process; TENSORFOLD_MEMORY_LIMIT_GB can raise it to 51.8
[tensorfold] loading Qwen3.8-27B-MLX-8bit: Qwen3.8 dense (qwen3_5)
[tensorfold] lane kernels on: 9 matmul shapes warmed, fused projections {'zba': 48, 'kv': 16, 'gu': 64}
[tensorfold] drafter /Users/peter/.cache/huggingface/hub/models--z-lab--Qwen3.8-27B-DFlash2/snapshots/50307d4c4cde6860d4eee73e2547cd786fe8e8a4 block=8 bits=4
[tensorfold] 31.1 GiB of weights kept resident
[tensorfold] prompt chunks of up to 2,048 tokens, cut at replies 256+ tokens apart
[tensorfold] concurrency: up to 8 requests share each round; memory budget 36.2 GB (MLX's share 41.8 GB, or 70% of 64 GB less 8.6 GB in use elsewhere); a stream 163 MB at 64 tokens, 394 MB at 2,112, then 114.0 KB a token
[tensorfold] loaded system-block snapshot tokens=640 in 0.0s
[tensorfold] serving Qwen3.8-27B-MLX-8bit at http://127.0.0.1:8080/v1 (sampling: temperature 1.0, top_k 20, top_p 0.95; drafts: on; context: 89600; loaded in 31.0s)
[tensorfold] 127.0.0.1 "GET /v1/models HTTP/1.1" 200 -
[tensorfold] 127.0.0.1 "POST /v1/chat/completions HTTP/1.1" 200 -
[tensorfold] read conversation snapshot tokens=9370 from disk in 0.06s
[tensorfold] done req-a22838d887b0 prompt=42 cached=0 thinking=True effort=low tokens=5 sha=235a6b4690b8 finish=length tok/s=59.1 ttft=0.72s prefill=0.72s rounds=1 accepted=4/4 ms/round=67.3 forward=67.3 draft=0.0 post=0.0 rows=16.9 checkpoints=2 (0.92 GiB, hits=1 misses=0 evictions=0)
[tensorfold] done req-07bcd37c1ff7 prompt=23124 cached=0 thinking=True effort=medium tokens=4598 sha=5c969274b94d finish=stop tok/s=60.5 ttft=41.74s prefill=41.71s rounds=773 accepted=3824/12792 ms/round=98.2 forward=98.2 draft=0.0 post=0.0 rows=17.5 checkpoints=0 (0.00 GiB, hits=13 misses=17 evictions=29)
[tensorfold] start failed req-449c47a5f5a1 cached=0: RequestError: This request needs about 41.8 GiB of the 41.8 GiB MLX may use (this server's 44.8 GiB memory budget less 3.0 GiB for the rest of the process); it fits up to 25,225 tokens in the prompt with 64,000 reply tokens. Shorten the prompt or max_tokens (the reply is reserved in full), or start the server with a smaller --context so clients compact sooner; --drafter none, a smaller or more quantized checkpoint, or a Mac with more RAM leave more room.
```
`/health` sample: `{"status":"ok","model":"Qwen3.8-27B-MLX-8bit","model_ids":["Qwen3.8-27B-MLX-8bit"],"max_batch_size":8,"warming":false,"memory":{"active":35826818500,"cache":8512000534,"peak":39936870996,"budget":48103633715,"mlx_budget":44882408243,"footprint":45436108856}}`

## Appendix B — what else exists (checked 2026-09-29)

`MiaAI-Lab/sparkDash` (MIT, v1.8.9, ~500 stars) is a fleet dashboard for NVIDIA DGX Spark on Linux/ARM64: its collectors are nvidia-smi/sysfs, and for TensorFold it only shows live tok/s when `/health` publishes cumulative token counters, which the MLX build does not. Not usable on this Mac; its per-backend probe list is a useful reference for what a dashboard shows. LM Studio's app has no view of a foreign server. TensorFold itself has no UI; its stdout is the interface, which is why this app reads it.
