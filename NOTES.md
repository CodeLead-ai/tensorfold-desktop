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

## Flags (`tensorfold serve --help`, 0.3.6.2)

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

## TensorFold 0.5.0 (installed 2026-09-30)

**The upgrade.** On 2026-09-30, at Peter's go-ahead, `tensorfold update` moved the bench's venv
(`~/Projects/codelead-bench/tensorfold-venv`) from 0.3.6.2 to 0.5.0, the latest release. It ran
`pip install --upgrade git+https://github.com/ashhart/TensorFold.git@v0.5.0` (commit `9cd52ab4`). Only TensorFold
changed: 0.5.0 accepts the venv's MLX 0.32.3, mlx-lm 0.31.3 and the rest, so pip left them alone. The server was
stopped and nothing else ran. To go back:
```bash
/Users/peter/Projects/codelead-bench/tensorfold-venv/bin/python -m pip install 'git+https://github.com/ashhart/TensorFold.git@v0.3.6.2'
```

**The bench's command still works:** the four flags its scripts pass (`--port 8080 --context 89600
--reasoning-effort medium --no-update-check`) are unchanged. What can still make 0.5.0's runs differ from 0.3.6.2's:
- `--reasoning-effort` no longer defaults to medium but to the chat template's own (xhigh for Qwen3.8). The bench
  passes medium, so its server default is unchanged. A request's own `reasoning_effort` still wins.
- 0.4.0's release notes say replies "can differ from 0.3.x's by a token here and there", for the 5- and 6-bit
  layers. The bench's model is 8-bit, and the notes name no change for it on an M5. Whether its replies still
  equal 0.3.6.2's is unverified.
- 0.3.6.3: `--decode-share` (default 0.25). While a prompt prefills, running replies keep decoding for that share of
  each chunk's time. 0.3.6.2 prefilled whole prompts first, which `--decode-share 0` restores. Timings under
  concurrency change; one request at a time does not.
- 0.4.0: a stream holds memory for its next 2,048 tokens, not its whole reply, so more streams fit. When memory
  runs short, kept prompts go first, then the newest streams wait, then the newest ends with an error naming
  `--parallel`. 0.4.0 also sizes the window the same way on every start (#95). The refused start of 2026-09-30
  09:26 (below) may therefore not recur, but that is unverified.

**What changed for the app** (0.5.0's source, and its `serve --help`, `models` and `info` outputs recorded on this
Mac; the fixtures hold both versions' help):
- **Flags:** `--vision` and `--vision-urls` (endpoint) and `--decode-share` (drafting), all from 0.3.6.3, and
  `--min-p` (generation, 0.5.0). `--reasoning-effort`'s default changed as above. Nothing was removed.
- **The concurrency line** names the shared round's streams (`a shared round up to 1.40 GB at 8 streams; …`). The
  old pattern no longer matched it, so it would have become an unknown line. It now parses.
- **The fitted context line** (no `--context`) adds "and still keep its prompt for the next turn".
- **New lines:** `requests up to N tokens keep their prompt for the next turn in the X GiB memory budget; a longer
  one is served, and its next turn prefills again`, printed with `--context` when the budget keeps less (N counts
  prompt and reply). Also `memory: N of M streams wait for room (newest first)` and `memory: ended req-…, the
  newest of M streams`. That request gets an error, and no `done` line or `request error` line is printed for it.
  Also a boxed `WARNING: …` (a prompt kernel that does not build) and notes (image encoder, Bonsai widening, an MTP
  layer type).
- **Unchanged:** the `done` line, `/health` (the live token totals of #79 are on the CUDA server only), access lines,
  refusal messages, `info` for the 27B, and `update --check`'s output. Also SIGUSR1: both versions arm
  faulthandler's dump before printing the memory budget line.
- `tensorfold models` lists two new families: DeepSeek-V4-Flash and Ternary Bonsai 2.

**Recorded from the real 0.5.0 on this Mac:** `--version`, `serve --help`, `models`, `info` for every local
checkpoint, and two serve sessions from Peter's `npm run test:real` of 2026-09-30 10:43. They are the fixtures
`serve-log-0.5.0-endorsed-2026-09-30.txt` (the endorsed flags) and `serve-log-0.5.0-probe-2026-09-30.txt` (a
36,743-token probe, a SIGUSR1 stack dump on stderr, and the stop). They confirm:
- the concurrency line's `at 8 streams`;
- `requests up to 49,664 tokens keep their prompt …`;
- 0.5.0 warming and saving the system block for its kernels (`warming 1 saved system block(s)`, `saved
  system-block snapshot tokens=847`, `warmed system block tokens=847 of 847`);
- Python 3.14's faulthandler, which names each thread (`Thread 0x… [tensorfold-engine] (most recent call first):`).

The memory wait and end lines, the boxed warning, the fitted context line and the image encoder line are still
known from the source only.

**A line the app never knew, 0.3.6.2 included.** As it stops, the lane engine saves the newest conversations under
its own tag: `[lanes] saved conversation checkpoint tokens=36738 (2.5 GiB) in 0.4s`. The source has more tagged
lines: `[lanes]` (a failed conversation save, and the profiling lines of `TF_PROFILE` and the like) and the families'
`[glm5]`, `[gemma4]`, `[nemotron]` and `[deepseek_v4]` startup lines. The parser read only `[tensorfold]`, and no
check caught it until the acceptance run began to fail on unknown lines. It now reads them all: the save is a
`snapshot`, a failed save an error, the profiling lines `diagnostic` notices, and the families' lines notes.

## Acceptance run

`npm run test:real` on this Mac (M5 Max, 64 GB) against TensorFold 0.3.6.2 and Qwen3.8-27B-MLX-8bit, with LM Studio
empty. It drives the app through its UI. The runs below are 0.3.6.2's, then 0.5.0's (the last one).

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

**What the 15:11 run left behind.** In it, the server was started twice. The first start died for lack of memory:
LM Studio still held `qwen/qwen3.8-27b` (29.5 GB). The session that served the probe was started again 43 s later,
after that memory was freed, and without the test's `--snapshot-dir`. So TensorFold saved the probe's
conversation to `~/.cache/tensorfold/session-snapshots/75dda8dd1589a00d3dc8cee3acfe9853.safetensors` (2.57 GB,
15:13:57) and pruned an older conversation (item 17). The test now refuses to run while LM Studio holds a
model. It fails at once when the server dies while loading, and checks that the running command has its
`--snapshot-dir` before any request.

**2026-09-30 09:26–09:31: the final code, rerun.**
- §6.3, §6.4, §6.6, §6.8 pass. The probe measured 58.98 s to the first token, the same as the server's `done`
  line, and 44.5 tok/s against 44.5. The gauge rose from 31.08 GiB during the prefill. The access line arrived 18 ms
  after the click. The window made 4 requests, all to its own files. The probe's conversation was saved in the
  test's own folder.
- §6.1 passes (serving after 24.2 s, exit 0 on stop), but only on the second try. The first start was refused by
  TensorFold itself:
  ```
  tensorfold: a 89,600-token context window does not fit this server's memory budget: the most one request can use is 89,355 tokens (prompt plus reply)
  ```
  TensorFold sizes the window from the new process's own MLX memory at startup (`largest_window` in
  `server/prompt_memory.py`). The endorsed `--context 89600` sits within about 30 MB of what this Mac affords, so a
  start can fail on a small variation, 245 tokens short in this case. Three more starts with the same flags that
  morning succeeded. If it recurs, three options: `TENSORFOLD_MEMORY_LIMIT_GB` (the startup line says up to 51.8),
  a slightly smaller `--context`, or omitting `--context` so TensorFold fits the window itself.
- Around the run: a regression queue's idle server on 8080 was stopped with SIGTERM (exit clean in 2 s) and
  restarted afterwards with the same command, from the same folder, into the same log.

**2026-09-30 09:42: §6.5 against the real LM Studio passes** (`TFDESK_REAL_LMS=1 TFDESK_RESTORE_COMMAND='…'`,
run with `-t 6.5`).
- **Without `lms`:** with its path set to a missing file, the LM Studio card says "LM Studio's lms was not found
  (looked at /nonexistent/lms). Set its path in Settings, or start the server without unloading."
- **Unload, then serve:** LM Studio held `qwen/qwen3.8-27b` (idle, context 131072). "Unload LM Studio, then serve"
  ran `lms unload --all` ("Unloaded 1 model."). LM Studio then listed nothing, and the endorsed preset was
  serving 25.4 s after the click.
- **Stop, then restore:** the server stopped (exit 0) and `cd /Users/peter/Projects/codelead-bench &&
  ./reload-model.sh` ran. It reloaded the model in 7.75 s against its reference configuration
  (`testdebt-2026-09-10a-serving-config.json`) and printed "MATCH — configuration reproduced; series stays
  comparable". LM Studio listed the model again 15.4 s after the click. The reload restores the reference
  configuration, parallel 1; before the test the model was loaded at parallel 4.
- **Cleaned output:** the script's spinner reached the card as raw terminal escape codes. Command output is now
  cleaned: the codes are removed, and a redrawn line shows only its last state.

**2026-09-30 10:43–10:45: TensorFold 0.5.0, run by Peter.** Everything passed but one line the parser did not
know (fixed above).
- §6.1 passes. The run found 0.5.0 and the 38 flags of its `serve --help`, all of them in the form. The endorsed
  preset was serving after 35.2 s ("loaded in 34.8 s"), and the header showed "prompts kept ≤ 49,664". It stopped
  with exit 0, and all 14 lines were known. `update --check`: "0.5.0 is the latest release".
  - This start used the endorsed flags, and so the default snapshot folder, as Peter's own server does. TensorFold
    warmed the saved system block for 0.5.0's kernels, and saved it into `~/.cache/tensorfold/prefix-snapshots`: one
    847-token block, 221 MB. His own first 0.5.0 start would have done the same.
- §6.3, §6.4, §6.6, §6.8 pass.
  - Serving after 29.8 s. The gauge rose from 31.09 to 36.42 GiB during the 36,743-token prefill.
  - Measured against the server's `done` line: 59.09 s to the first token (59.08), tok/s 35.2 (36.0). Prefill
    59.02 s (623 tok/s), drafts 11 of 30 accepted.
  - The POST's access line came 20 ms after the click, and the `done` line was in the feed. The snapshot reproduced
    the command line. The window made 4 requests, all to its own files.
  - "Dump stacks": the stacks of 4 threads, 11 ms after SIGUSR1, and the server kept serving.
  - On stop, the conversation (36,738 tokens, 2.5 GiB) was saved in the test's folder. Its `[lanes]` line was the
    one unknown to the parser. That failed the test, which kept its 2.4 GB folder in the temp directory; a failed
    run now keeps the logs only.
- **Against 0.3.6.2** (the 09:26 run):
  - Time to first token 59.1 s against 59.0, prefill 623 against 620 tok/s.
  - The 16-token reply ran at 36.0 tok/s against 44.9. Four rounds are too few to compare decode speed; the bench is
    the measure.
  - Loading took 29.6–34.8 s against 24–25 s.
  - `--context 89600` was admitted on both starts.
  - Past 2,112 tokens, a stream grows 64 KB a token against 114 KB. The concurrency line says 4 streams of 8,192
    tokens fit against the K3 run's 2, with 6.8 GB in use elsewhere against 8.6.
  - Requests up to 49,664 tokens, reply included, keep their prompt for the next turn. CodeLead's 20–27k-token prompts
    are within it.

**2026-10-01 10:27–10:31: 0.5.0 again, with the remote step** (`TFDESK_REAL_REMOTE=1 npm run test:real`): 3 passed,
§6.5 skipped.
- Every stdout line of the four sessions was known.
- `update --check` found 0.6.0. The bench's venv was not upgraded.
- The probe matched its `done` line: 58.24 s to the first token, and a prefill of 632 tok/s.
- **Remote:**
  - With the switch on, `GET http://10.0.0.157:8080/v1/models` (en0) answered 200. The header showed "remote
    Peters-MacBook-Pro.local:8080".
  - With the switch off and the server restarted, 10.0.0.157 refused the connection (`ECONNREFUSED`) and 127.0.0.1
    answered 200.
- **An earlier run that morning (10:15) passed the same three tests, then hung on quit:** the app sat in a native
  alert, the kind Electron shows for an uncaught exception in the main process. Three more runs did not reproduce it:
  this one, the remote step alone against the real server, and the same steps against the mock. The test now logs the
  main process's stderr and any uncaught exception in `.tmp/acceptance.log`, and kills an app that does not quit in
  20 s.

**Not run:**
- A real `pull`, so huggingface.co from the CLI child (§6.8) was not observed.

## Decisions (2026-09-29 to 2026-10-01)

- **The form follows the installed binary.** The app reads `serve --help` once per binary and version, about 50 ms.
  A flag the binary lacks is dimmed with the release that added it ("tensorfold 0.3.6.2 has no --min-p (it came in
  0.5.0)"), and setting it is an error. A flag the binary lists but the app's table lacks (a later release's)
  gets a plain field under "More flags": a switch, a choice, or text passed as typed.
- **The update check runs only when asked,** from Settings: `tensorfold update --check`, whose request to
  api.github.com is the CLI's. The app never installs. It shows `tensorfold update` to copy, because an upgrade
  changes the environment a bench runs in.
- **Remote connections are a switch (2026-10-01).** On passes `--host 0.0.0.0` after a confirmation, a native
  dialog with Cancel as the default. The dialog says there is no password or API key, no encryption, and that the
  macOS firewall may ask the first time. Off drops `--host`. `--host` is not part of a preset: it carries across presets
  like the environment, and `presetOf` ignores it. A network address typed into the `--host` field keeps its
  validation warning instead of the dialog. While a server listens beyond this Mac, the header and the Command card
  show the address other machines use: the Bonjour name (`os.hostname()`), then the IPv4 addresses, Wi-Fi and
  Ethernet first.
- **The port check connects as well as binds.** macOS lets a server bind `0.0.0.0:8080` while another holds
  `127.0.0.1:8080`, and Python's servers do. With the switch on, a bind-only check would have let the app start a
  second 27B server beside one a bench script started. The check now first tries to connect to `127.0.0.1:port`,
  where a server on either address answers. It never binds `0.0.0.0` itself, so it sets off no firewall prompt for the
  app.
- **"Dump stacks" sends SIGUSR1** only once the memory budget line is out, since TensorFold arms the dump just
  before it and the signal would end the process earlier. It is sent only when the binary is a Python entry point,
  which the venv's is. A shell wrapper that does not exec Python would take the signal itself.

- **Servers the app did not start are out of scope.** A server started by a bench runner, for example, shows up
  only as the port being in use. The port check names the model it serves.
- **The LM Studio card shows only while LM Studio is running.** The app finds LM Studio in the process list
  (the app, or its headless `llmster`) and does not ask `lms`, which could start LM Studio's daemon. When LM Studio
  is not running, nothing is shown, and "Unload LM Studio, then serve" simply serves. When it runs and `lms` is
  missing, the card says so.
- **The restore command on this Mac is the bench's reload script,** set in the app's settings (not in its code) to
  `cd /Users/peter/Projects/codelead-bench && ./reload-model.sh`. Testing §6.5 against the real LM Studio waits
  until Peter says it can be touched.
