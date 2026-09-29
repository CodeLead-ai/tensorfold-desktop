# Notes: where TensorFold differs from the spec

The spec was written against TensorFold 0.3.6.2 on this Mac. These are the places where the installed tool,
its real output, or its source (tag `v0.3.6.2` on GitHub) say something different. The parser accepts both
forms everywhere. The app never crashes on a line it does not know: the line becomes `{ kind: 'unknown' }`.

Sources: `tensorfold serve --help` of the installed binary (`/Users/peter/Projects/codelead-bench/tensorfold-venv`),
the K3 run's serve log of 2026-09-29 (kept as `test/fixtures/k3-serve-2026-09-29.txt`), and the release's source.

## Log lines

1. **The concurrency line is longer than Appendix A's copy.** Appendix A stops at `then 114.0 KB a token`.
   The real line goes on:
   ```
   [tensorfold] concurrency: up to 8 requests share each round; memory budget 36.2 GB (MLX's share 41.8 GB, or 70% of 64 GB less 8.6 GB in use elsewhere); a stream 163 MB at 64 tokens, 394 MB at 2,112, then 114.0 KB a token; a shared round up to 1.40 GB; 2 streams of 8,192 tokens fit now (more wait their turn)
   ```
   `roundGb` and `fits` are null when the tail is missing.
2. **A startup line Appendix A leaves out**, printed between `drafter` and `… GiB of weights kept resident`:
   ```
   [tensorfold] lane kernels: windows of up to 32 rows reproduce one-row steps here (ms by rows 1: 57.4, 2: 59.6, 4: 61.7, 8: 64.4, 16: 67.9, 17: 74.3, 32: 77.6, 64: 107.0, 128: 188.9)
   ```
   It is parsed as `startup` / `lane-windows`.
3. **Appendix A's first `done` line isn't verbatim.** Its tail reads
   `rows=16.9 checkpoints=2 (0.92 GiB, hits=1 misses=0 evictions=0)`. The K3 log has the same request
   (`req-a22838d887b0`) ending `rows=5.0 checkpoints=1 (0.19 GiB, hits=0 misses=1 evictions=0)`. Its refusal also
   ends "leave more room.", where the real one says "leaves more room.". The fixture keeps Appendix A as written.
   The K3 log is a second fixture.
4. **`hits`, `misses` and `evictions` in a `done` line are the server's running totals**, not the request's.
   The source prints `store.hits` of the prefix-cache store. `checkpoints=N (X GiB, …)` is the store's size now.
   The request totals therefore take the latest value, never a sum.
5. **The round profile is not always there.** `ms/round=… forward=… draft=… post=… rows=…` is omitted while other
   streams are active (the source's `_round_profile` returns an empty string then). Those fields are nullable.
6. **More `done` forms in the source:** `checkpoints=off` (no prefix cache), `background preemptions=N` (a
   warming job), and `ttft=-1.00s` / `prefill=-1.00s` (not measured, read as null).
7. **Line types the spec does not list:** `request error: …` (answered 500), `stream error: …`,
   `snapshot read failed`, `snapshot save failed`, `conversation spill failed`, `saved system-block snapshot`,
   `warmed system block`, `spilled conversation`, `slow round`, `stalled Ns: … every thread's stack follows`,
   `no draft model: …`, `context window N tokens: …`, `warming N saved system block(s)`, `note: … not a
   checkpoint TensorFold is tested with`, update notices. All are parsed (`error`, `notice`, `snapshot`, `startup`).

## Streams and buffering

8. **Access lines are printed without a flush.** The source's `log_message` calls `print()` without `flush=True`,
   while every other line flushes. Through a pipe, an access line arrives only with the next flushed line; in the
   K3 log each `POST` sits right before its `done`. The app starts the server with `PYTHONUNBUFFERED=1` so
   lines arrive as they are written.
9. **Fatal errors go to stderr, not stdout.** Examples: `tensorfold: [Errno 2] No such file or directory: '…/config.json'`,
   Python tracebacks, and the `faulthandler` stack dump that follows `stalled`. The app reads both streams, and
   the "last 50 lines" after a death include stderr.

## Flags (`tensorfold serve --help`, installed 0.3.6.2)

10. `--ssd-experts GIB` takes a size in GiB; it is not a switch. `--alias` is repeatable. `--port` defaults to
    8080 (the help shows no default; the source does). `--context 0` on Metal removes the metadata cap. The form
    follows the spec and asks for a positive integer.
11. `--snapshot-dir` defaults to `~/.cache/tensorfold/prefix-snapshots` and takes `none`; `--spill-gib` needs it.

## Memory

12. **§2.4 conflates two budgets.** "Budget = 70% of RAM minus in use elsewhere" describes the concurrency
    line's `memory budget 36.2 GB`. The first startup line's `memory budget 44.8 GiB` is 70% of 64 GiB with
    nothing subtracted, and `/health.memory.budget` is that same 44.8 GiB (48,103,633,715 bytes).

## Requests

13. **Prefill rate is (prompt − cached) / prefill.** The spec says prompt / prefill, which counts cached tokens
    as if they were prefilled. The K3 log shows the difference:
    ```
    [tensorfold] done req-3c005e316298 prompt=26209 cached=26204 … prefill=0.18s …
    ```
    prompt / prefill would read 145,606 tok/s for a request that prefilled 5 tokens.
14. **A response's id is `chatcmpl-<uuid>`**, unrelated to the log's `req-<12 hex>`. The probe finds its `done` line
    by its prompt and reply token counts, arriving right after the response ends.

## Other commands

15. `tensorfold info` on a checkpoint no family can run prints the config lines, then an error on stderr, and exits
    non-zero. For example, Qwen3.5-0.8B gives `tensorfold: Qwen3.8 dense cannot run this checkpoint: the tied
    embedding head is not supported by this packed Qwen decoder. Use Vontra/Qwen3.8-27B-MLX-4bit`. Such
    checkpoints are listed as skipped. On this Mac only the Qwen3.8-27B folders are servable.
16. `tensorfold info` exits 0 for a checkpoint of a family with only a CUDA engine. On this Mac,
    `Qwen3.6-35B-A3B-MLX-4bit` prints `runs on      NVIDIA GPUs (CUDA)` and exits 0. The library therefore
    checks the "runs on" line too, and lists such a checkpoint as skipped: "runs on NVIDIA GPUs (CUDA) only".
17. **Where conversations are saved.** When it stops, TensorFold saves up to two conversations per model (the
    longest first) into the folder next to `--snapshot-dir`, `<parent>/session-snapshots`, keeping the two newest.
    By default that is `~/.cache/tensorfold/session-snapshots`. Anything started with the default snapshot folder
    therefore writes there, and can push out a conversation an earlier run left.
18. `tensorfold info <repo id>` may download `config.json` from Hugging Face when it is not cached. The app
    only runs `info` on directories.

## When TensorFold is upgraded (0.4.0 is out; 0.3.6.2 is installed)

The app targets the installed 0.3.6.2. Between it and 0.4.0 there are 0.3.6.3, 0.3.7 and 0.4.0. Their release notes,
and the 0.4.0 source, say what changes for the app:

- **Unchanged:** the `done` line (same format string, same round profile) and `/health` (same fields). The
  request feed and the memory gauge keep working.
- **New serve flags:** `--decode-share` (0.3.6.3, default 0.25), `--vision` and `--vision-urls`. The form knows
  0.3.6.2's flags only. The flag-table test compares the table with `serve --help`, so update the two together.
- **Memory:** 0.4.0 no longer reserves the whole reply at admission ("a stream holds memory for its next 2,048
  tokens, not its whole reply"). The `start failed … the reply is reserved in full` refusal becomes rarer. When
  memory runs short, the newest stream ends with an error naming `--parallel`. The refusal row keeps whatever
  message comes, and its number extraction may need the new wording.
- **Startup:** the concurrency line counts the probe round once ("0 streams of 8,192 tokens fit" became 13). A
  prompt kernel that does not build prints a warning. Both parse, or fall back to `unknown`.
- **A live status line in a terminal:** 0.4.0 redraws one line under the log in a TTY. The app reads a pipe, and
  sets `TENSORFOLD_NO_LIVE=1` anyway.

After upgrading:
1. `npm run test:real`: SPEC §6.1, §6.3, §6.4, §6.6 and §6.8 on the new version.
2. Keep a real serve log as `test/fixtures/serve-log-<version>.txt`, and add a test that none of its lines is
   `unknown`. That is how the K3 log is tested.
3. Add the new flags to `FLAGS` in `src/shared/config.ts` and to the test's copy of `serve --help`.

## Acceptance run

`npm run test:real` on this Mac (M5 Max, 64 GB) against TensorFold 0.3.6.2 and Qwen3.8-27B-MLX-8bit, with LM Studio
empty. It drives the app through its UI.

**2026-09-29 15:22: both tests pass.**
- §6.1: the endorsed preset (`… serve …/Qwen3.8-27B-MLX-8bit --port 8080 --context 89600 --reasoning-effort medium
  --no-update-check`) reached "serving". The header showed the model, port 8080, context 89,600, "loaded in" and
  tensorfold 0.3.6.2. Stop returned to "stopped" with exit code 0. The app's log file holds the serving line.
- §6.3, §6.4, §6.6, §6.8 as below. The run left `~/.cache/tensorfold` untouched.

**Figures from the 15:11 run** (the same checks, in an earlier version of the test):
- §6.4: active memory was 31.27 GiB before the probe and rose to 37.37 GiB during its 36,743-token prefill
  (read from the gauge once a second).
- Probe beside the server's `done` line (`req-e0c6e10457b8`):

  | | measured here | server's `done` line |
  | --- | --- | --- |
  | time to first token | 59.35 s | 59.35 s |
  | tok/s | 44.5 | 44.9 |
  | prompt and reply tokens | 36,743 and 16 | 36,743 and 16 |
  | prefill | – | 59.28 s (620 tok/s) |
  | accepted drafts | – | 11 of 30 |
- §6.3: the POST's access line arrived 16 ms after the click, and the `done` line 59.7 s after that. This
  confirms `PYTHONUNBUFFERED` on the real binary (item 8). The `done` line was in the feed at once.
- §6.6: the exported snapshot reproduced the command line.
- §6.8: the window made 3 requests, all to its own files.

**What the 15:11 run left behind.** In it, the server was started twice. The session that served the probe was
spawned 43 s after the test's click, without the test's `--snapshot-dir`. So TensorFold saved the probe's
conversation to `~/.cache/tensorfold/session-snapshots/75dda8dd1589a00d3dc8cee3acfe9853.safetensors` (2.57 GB,
15:13:57) and pruned an older conversation (item 17). The test now refuses to run while LM Studio holds a
model. It fails at once when the server dies while loading, and checks that the running command has its
`--snapshot-dir` before any request.

**Not run:**
- §6.5 with the real `lms`, which would unload LM Studio's model. The flow is tested end to end against
  `mock/fake-lms.mjs`.
- A real `pull`, so huggingface.co from the CLI child (§6.8) was not observed.
