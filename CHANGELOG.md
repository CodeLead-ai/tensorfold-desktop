# Changelog

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
