# Changelog

## Unreleased: remote connections (2026-10-01)

- **A Remote connections switch** in the Server view's Endpoint section. On passes `--host 0.0.0.0`; it asks first,
  in a dialog that warns there is no password or API key, no encryption, and that the macOS firewall may ask the first
  time. Off drops `--host`, so only this Mac can connect. Presets keep the switch, and the preset still shows as
  itself.
- While a server accepts remote connections, a "remote" chip shows in the header, and the Command card shows the
  address other machines use (the Bonjour name, then the IP addresses) with a Copy button.
- **The port check also connects to 127.0.0.1.** On macOS a server can bind `0.0.0.0` beside one on `127.0.0.1` with
  the same port, so a remote start could have run a second 27B server beside a local one.
- `npm run test:real` has an opt-in remote step (`TFDESK_REAL_REMOTE=1`). It passed against the real server: 200 on
  the network address with the switch on, refused with it off. The test also logs the app's own errors, and no longer
  hangs if the app does not quit.
- Tests: 191 unit tests and 9 UI tests.

## Unreleased: TensorFold 0.5.0 (2026-09-30)

This Mac's TensorFold moved from 0.3.6.2 to 0.5.0 (see [NOTES.md](NOTES.md#tensorfold-050-installed-2026-09-30)).
The app follows it, and still runs with 0.3.6.2.

- **The form follows the installed version.** The app reads the binary's `serve --help`. The flags 0.3.6.3–0.5.0
  added are in the table: `--vision`, `--vision-urls`, `--min-p` and `--decode-share`. A flag the binary lacks is
  dimmed with the release that added it, and setting it is an error. A later release's flags that the table lacks
  get plain fields under "More flags". Snapshots keep them too.
- `--reasoning-effort`'s default shows 0.5.0's: the chat template's own (xhigh for Qwen3.8). The endorsed preset still
  passes medium.
- **0.5.0's log lines:**
  - The concurrency line names the round's streams; it had stopped parsing.
  - The fitted context line's new wording.
  - "requests up to N tokens keep their prompt for the next turn": a header chip and a Startup line. The feed marks
    the requests past it, whose next turn prefills again.
  - `memory: … wait for room`: a header chip while streams wait. `memory: ended …`: a row in the feed.
  - The boxed prompt-kernel warning, and the new startup notes.
- **Check for a newer release** in Settings: `tensorfold update --check`, run only when asked. It shows the command
  that installs the release and the release notes' link.
- **Dump stacks** (Server and Log views): SIGUSR1 once TensorFold has armed it; the stacks arrive on stderr.
- The mock plays 0.5.0 (or 0.3.6.2), with `serve --help`, `update --check`, SIGUSR1 and memory pressure. It refuses
  flags its version lacks.
- `npm run test:real` checks the detected version and that the form has every flag of the binary. It dumps stacks
  on the real server and runs the update check. It keeps each session's lines in `.tmp/` and fails on a stdout line
  the parser does not know.
- **Lines under other tags.** The lane engine's `[lanes] saved conversation checkpoint …`, printed as the server
  stops, was unknown to the parser, in 0.3.6.2 too. The first 0.5.0 acceptance run caught it. Now `[lanes]` lines
  and the families' `[glm5]`, `[gemma4]`, `[nemotron]` and `[deepseek_v4]` lines parse: snapshots, errors,
  diagnostics and startup notes.
- Two real 0.5.0 serve sessions from that run are fixtures. Every stdout line of them is known.
- The mock, as 0.5.0, prints that run's recorded startup, warms and saves the system block, and saves conversations
  when stopped. Its stack dump names threads, as Python 3.14's faulthandler does.
- A failed `npm run test:real` keeps its logs but not the snapshots TensorFold saved in its folder (GiBs).
- Tests: 182 unit tests (from 140) and 8 UI tests (from 6); screenshots regenerated.

## 0.1.0 (2026-09-29)

The first version, built step by step from [SPEC.md](SPEC.md) and the build prompt. It targets the installed
TensorFold 0.3.6.2.

### Spec and scaffold
- `SPEC.md` copied to the root, where the build prompt expects it.
- electron-vite 5 with Electron 44, React 18, TypeScript 5.9 strict, vitest 5, ESLint, electron-builder 26.

### Shared contract (`src/shared`)
- Every `tensorfold serve` flag, grouped as `--help` groups them, with the argv builder, its inverse, the
  command-line formatter and the presets. The endorsed preset renders exactly
  `serve <model> --port 8080 --context 89600 --reasoning-effort medium --no-update-check`.
- The log-event union, the `/health` type and the memory gauge.

### LogParser
- One line in, one event out: startup, serving, done, refused, access, snapshot, error, notice, unknown.
  Every field of every SPEC Appendix A line is tested, and all 145 lines of the real K3 serve log parse. Unknown
  lines never throw.
- `NOTES.md` lists where TensorFold's real output differs from the spec.

### Mock
- `mock/fake-tensorfold.mjs` stands in for the 0.3.6.2 CLI: `serve` (startup lines, `/v1/models`, `/health`
  with memory that rises during each prefill, streamed chat completions, and the K3 requests replayed),
  `info`, `models` and `pull`, plus failure modes. `npm run dev:mock` runs the app against it under its own
  profile.

### Main process and preload
- `ProcessManager`: spawn, the state machine, SIGTERM then SIGKILL after a grace period, the exit code and the
  last 50 lines, and a log file per session. The server gets `PYTHONUNBUFFERED=1`.
- `HealthPoller` (every 2 s, backing off), `Settings` (electron-store), the login shell's `PATH`,
  binary discovery, port checks that name the holder, and the typed `window.tfdesk` API. The window is
  sandboxed and its requests are audited.

### Renderer
- Status header, Server view (form, presets, validation, exact command, startup sequence, memory gauge,
  death card), Requests (totals, sparkline, feed with refusals), Log (virtualized, follow, filter, copy).
- `npm run test:e2e` drives the built app through its UI; `npm run screens` writes `docs/screens/`.

### P1
- Checkpoint library with `tensorfold info` and "Serve this"; Pull with progress; LM Studio coexistence
  ("Unload LM Studio, then serve", "Stop, then restore", and a clear message without `lms`); Probe and the
  alternation set; serving snapshot (reproduces the command line) and "Copy for a runner"; menu-bar item.

### Packaging
- `npm run build` writes an ad-hoc-signed arm64 `.dmg`, with an app icon drawn by `scripts/make-icon.mjs`.
- README with install, the mock workflow and the settings. `npm run test:real` is the opt-in acceptance run
  against the real server.

### After the first build
- Checkpoints: a family with only a CUDA engine is not servable on a Mac, although `tensorfold info` exits 0 for
  it. Long checkpoint names no longer push the Serve button out of the card.
- Switching views starts at the top, not where the previous view was scrolled.
- Clicking a flag's name no longer clears it. The label handed the click to the reset button.
- The real-server acceptance test runs only while LM Studio is empty, fails at once on a death while loading, and
  checks its `--snapshot-dir` before any request. It writes `.tmp/acceptance.log`.
- `.gitignore` covers TensorFold snapshots, session logs, exported snapshots and dmgs.
- A cap on the app's session logs: the newest 50 by default, set in Settings, with the logs' count and size shown.
- Servers the app did not start stay out of scope: such a server shows up only as the port being in use.
- The LM Studio card shows only while LM Studio is running, which is read from the process list without asking
  `lms`. When LM Studio is not running, "Unload LM Studio, then serve" simply serves.
- A new app icon: TensorFold's folded sheet twisting from coral and violet into CodeLead's blue and cyan, on CodeLead's
  navy tile with its cursor. It is drawn from code by `scripts/make-icon.mjs` and used in the rail and, in
  development, the Dock.
- Command output (LM Studio's unload and restore) shows without terminal escape codes, and a redrawn spinner shows only
  its last state.
- §6.5 passes against the real LM Studio: an opt-in step of `npm run test:real`.
