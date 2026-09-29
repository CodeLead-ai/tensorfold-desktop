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
17. `tensorfold info <repo id>` may download `config.json` from Hugging Face when it is not cached. The app
    only runs `info` on directories.
