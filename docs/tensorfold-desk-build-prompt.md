# Build prompt — TensorFold Desk

Paste everything below this line to the building agent, after creating the empty repository it names.

---

You are building **TensorFold Desk**, a local macOS Electron app that starts, stops, configures and monitors a `tensorfold serve` process (TensorFold, github.com/ashhart/TensorFold: an OpenAI-compatible LLM server for Apple Silicon). The specification is the file `SPEC.md` at the repository root; read it in full before writing any code, and treat its Appendix A as ground truth for the log format. Nothing in the spec is a guess: every line, endpoint and flag was read from the installed tool.

**Repository:** `/Users/peter/Projects/tensorfold-desk` (empty, `git init` done). Work on `main`; commit small, in the order below; every commit passes `npm run typecheck` and `npm test`.

**Stack (fixed):** Electron 31+ via `electron-vite`, React 18, TypeScript strict, vitest, electron-builder (arm64 dmg). Tailwind v4 or CSS variables — your call, but the palette in SPEC §5 is not negotiable. `contextIsolation: true`, `nodeIntegration: false`, a typed preload API. No other runtime dependencies without a one-line reason in the commit message.

**Order of work (each step ends in a commit):**
1. `src/shared/`: the serve config type (every flag in SPEC §2.1, grouped), the event union the parser emits, the health type. Tests for the argv builder: the endorsed preset must render exactly `serve <model> --port 8080 --context 89600 --reasoning-effort medium --no-update-check`.
2. `src/main/LogParser.ts`: pure, one line in, one event out. Fixture file `test/fixtures/serve-log-2026-09-29.txt` = SPEC Appendix A verbatim; tests assert every field of every line (numbers as numbers, `accepted` as `{accepted, proposed}`, `ttft`/`prefill` in seconds, the refusal's message intact, unknown lines as `{kind:"unknown"}`).
3. `mock/fake-tensorfold.mjs` + `npm run dev:mock`: an HTTP server on a configurable port answering `/v1/models`, `/health` (memory values drifting over time) and streaming `/v1/chat/completions`, printing the fixture lines to stdout on a timer, exiting on SIGTERM. From here on, build the UI against the mock.
4. `ProcessManager` (spawn/stop/restart, state machine, exit code + last 50 lines), `HealthPoller`, `Settings` (electron-store), and the preload API. Integration test with the mock: start → events flow → stop.
5. Renderer: Server view (form + presets + command preview + start/stop), status header, memory gauge, Requests view (table, totals, sparkline), Log view (follow, filter, copy). The app must be usable end to end against the mock here.
6. Checkpoints view (scan the folders in SPEC §2.6 with configurable roots; `tensorfold info` cached per path; "Serve this"), Pull, LM Studio coexistence (SPEC §2.5; commands configurable, degrade gracefully when `lms` is absent), Probe, Export snapshot, menu-bar item.
7. Packaging: `npm run build` produces the dmg; a `README.md` with install, the mock workflow, and the settings (binary path, checkpoint roots, LM Studio commands).

**Rules:**
- Read SPEC §6 as the definition of done; do not stop before it is met, and say plainly which criteria you could not verify (for example, the real 27B server if it is not on your machine — the mock covers everything but SPEC §6.1, §6.4 and §6.5).
- No telemetry, no analytics, no network from the renderer; the only outbound connections are localhost and, during a pull the user starts, huggingface.co from the CLI child.
- Never modify anything outside this repository; never touch `/Users/peter/Projects/codelead*` or `~/.lmstudio`. Reading `~/.lmstudio/models` and `~/.cache/huggingface` is fine.
- Prefer the spec's names (event kinds, view names) so the spec stays the map of the code.
- When TensorFold's real behaviour differs from the spec on your machine, record the difference in `NOTES.md` with the line you saw, keep the parser tolerant (unknown line, never a crash), and continue.
- Finish with a short `CHANGELOG.md` entry per commit group and a screenshot of each view against the mock in `docs/screens/`.
