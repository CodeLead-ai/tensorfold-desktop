#!/usr/bin/env node
/**
 * A stand-in for the `tensorfold` CLI (0.5.0, or 0.3.6.2) so TensorFold Desk can be built and tested on any
 * machine (SPEC §4, "Dev without a 27B"). No dependencies.
 *
 *   fake-tensorfold.mjs --version | serve <model> [flags] | serve --help | info <dir> | models | pull <repo…>
 *                       | update --check
 *
 * `serve` prints the real startup lines (test/fixtures), answers GET /v1/models, GET /health (memory that
 * rises during each prefill) and POST /v1/chat/completions (streaming or not), and replays the K3 run's
 * request lines on a timer, sped up. SIGTERM before "serving" kills it at once, as TensorFold installs its
 * handler only once it serves; after, it shuts down and exits 0. SIGUSR1 prints a stack dump on stderr, as
 * faulthandler does, once the memory budget line is out (before it, the signal ends the process).
 *
 * The startup lines are recorded ones: 0.5.0's from its endorsed session of 2026-09-30 (with --context past what
 * the budget keeps, "requests up to 49,664 tokens keep their prompt"), 0.3.6.2's from the K3 run. Both replay the
 * K3 run's requests (the done line did not change), and save the newest conversations when stopped, as the lane
 * engine does. Flags are checked against the version's recorded `serve --help`, as argparse would.
 *
 * Environment:
 *   MOCK_TENSORFOLD_VERSION      0.5.0 (default) or 0.3.6.2
 *   MOCK_TENSORFOLD_LATEST       what `update --check` finds on "GitHub": a version, or offline (default: this one)
 *   MOCK_TENSORFOLD_LOAD_MS      startup duration (default 2500)
 *   MOCK_TENSORFOLD_TIME_SCALE   replayed requests take this fraction of their real time (default 0.06)
 *   MOCK_TENSORFOLD_INTERVAL_MS  pause between replayed requests; 0 turns the replay off (default 1500)
 *   MOCK_TENSORFOLD_TOKENS_PER_S decode speed for real chat requests (default 60)
 *   MOCK_TENSORFOLD_PULL_STEP_MS progress step of `pull` (default 400)
 *   MOCK_TENSORFOLD_MEMORY       pressure: the replay's streams wait for memory, and one ends (0.4.0+'s lines)
 *   MOCK_TENSORFOLD_LOOPBACK_ONLY 1: listen on 127.0.0.1 even when --host asks for more (tests of the remote switch
 *                                that should not open a port to the network); the serving line still says --host
 *   MOCK_TENSORFOLD_FAIL         startup | crash | slow-stop | ignore-sigterm
 * A model path containing "broken" fails at startup too.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'test', 'fixtures')
const VERSION = process.env.MOCK_TENSORFOLD_VERSION === '0.3.6.2' ? '0.3.6.2' : '0.5.0'
const V050 = VERSION === '0.5.0'
const GIB = 1024 ** 3
/** "requests up to 49,664 tokens keep their prompt …", the endorsed session's (0.5.0 with --context). */
const KEPT_TOKENS = 49664
const KV_PER_TOKEN = 114 * 1024
/** Weights and fixed buffers the mock charges every request, so ~88k tokens are refused as on the 64 GB Mac. */
const BASE_GIB = 32.4

const envNumber = (name, fallback) => {
  const value = Number(process.env[name])
  return process.env[name] !== undefined && Number.isFinite(value) ? value : fallback
}
const LOAD_MS = envNumber('MOCK_TENSORFOLD_LOAD_MS', 2500)
const TIME_SCALE = envNumber('MOCK_TENSORFOLD_TIME_SCALE', 0.06)
const INTERVAL_MS = envNumber('MOCK_TENSORFOLD_INTERVAL_MS', 1500)
const TOKENS_PER_S = envNumber('MOCK_TENSORFOLD_TOKENS_PER_S', 60)
const PULL_STEP_MS = envNumber('MOCK_TENSORFOLD_PULL_STEP_MS', 400)
const FAIL = process.env.MOCK_TENSORFOLD_FAIL ?? ''
const MEMORY_PRESSURE = process.env.MOCK_TENSORFOLD_MEMORY === 'pressure'
const LOOPBACK_ONLY = process.env.MOCK_TENSORFOLD_LOOPBACK_ONLY === '1'

const out = (line) => process.stdout.write(`${line}\n`)
const err = (line) => process.stderr.write(`${line}\n`)
const log = (body) => out(`[tensorfold] ${body}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => randomBytes(n).toString('hex').slice(0, n)
const grouped = (n) => Math.round(n).toLocaleString('en-US')
const fixtureLines = (name) => readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l !== '')

/** Exit once stdout and stderr have drained (pipes are asynchronous on macOS). */
function exit(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

function usageError(sub, message) {
  err(`usage: tensorfold ${sub} [-h] …`)
  err(`tensorfold ${sub}: error: ${message}`)
  exit(2)
}

const serveHelp = () => readFileSync(join(FIXTURES, `tensorfold-serve-help-${VERSION}.txt`), 'utf8')

/** The switches this version's `serve --help` lists, and which of them take a value. */
function serveSwitches() {
  const switches = new Map()
  for (const m of serveHelp().matchAll(/^ {2}(--[a-z0-9-]+)((?:, --[a-z0-9-]+)*)( [A-Z_{][^ ]*)?/gm)) {
    switches.set(m[1], m[3] !== undefined)
    for (const other of (m[2] ?? '').split(', ').filter(Boolean)) switches.set(other, false)
  }
  return switches
}

// ------------------------------------------------------------------------------------------------ serve

function parseServe(args) {
  const opts = { host: '127.0.0.1', port: 8080, context: null, name: '', drafts: true, drafter: 'auto', maxTokens: 4096, thinking: true, effort: V050 ? null : 'medium', vision: false, visionUrls: false, snapshotDir: null }
  const known = serveSwitches()
  const unrecognized = []
  let model = null
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (!word.startsWith('--')) {
      model = word
      continue
    }
    const eq = word.indexOf('=')
    const flag = eq > 0 ? word.slice(0, eq) : word
    if (!known.has(flag)) {
      // argparse reports the value with it: `unrecognized arguments: --min-p 0.1`.
      const next = args[i + 1]
      unrecognized.push(...(eq < 0 && next !== undefined && !next.startsWith('-') && !existsSync(next) ? [word, args[++i]] : [word]))
      continue
    }
    const takesValue = known.get(flag)
    const value = !takesValue ? undefined : eq > 0 ? word.slice(eq + 1) : args[++i]
    if (takesValue && value === undefined) usageError('serve', `argument ${flag}: expected one argument`)
    if (flag === '--host') opts.host = value
    else if (flag === '--port') opts.port = Number(value)
    else if (flag === '--context') opts.context = Number(value)
    else if (flag === '--name') opts.name = value
    else if (flag === '--max-tokens') opts.maxTokens = Number(value)
    else if (flag === '--drafter') opts.drafter = value
    else if (flag === '--reasoning-effort') opts.effort = value
    else if (flag === '--no-drafts') opts.drafts = false
    else if (flag === '--no-thinking') opts.thinking = false
    else if (flag === '--thinking') opts.thinking = true
    else if (flag === '--snapshot-dir') opts.snapshotDir = value
    else if (flag === '--vision') opts.vision = true
    else if (flag === '--vision-urls') opts.visionUrls = true
  }
  if (unrecognized.length > 0) {
    err('usage: tensorfold [-h] [--version] {serve,pull,models,update,info} ...')
    err(`tensorfold: error: unrecognized arguments: ${unrecognized.join(' ')}`)
    exit(2)
    return null
  }
  return { model, opts }
}

function pythonTraceback(lastLine) {
  err('Traceback (most recent call last):')
  err('  File "/mock/tensorfold-venv/bin/tensorfold", line 8, in <module>')
  err('    sys.exit(main())')
  err('  File "/mock/tensorfold-venv/lib/python3.14/site-packages/tensorfold/cli.py", line 139, in main')
  err('    return int(args.func(args) or 0)')
  err(lastLine)
}

/** faulthandler's dump of every thread, as `kill -USR1` gets it from TensorFold 0.5.0 on Python 3.14 (it names threads). */
function stackDump() {
  const site = '/mock/tensorfold-venv/lib/python3.14/site-packages/tensorfold'
  const lib = '/mock/python3.14/lib/python3.14'
  const lines = [
    'Thread 0x0000000375db7000 [tensorfold-watchdog] (most recent call first):',
    `  File "${lib}/threading.py", line 373 in wait`,
    `  File "${lib}/threading.py", line 670 in wait`,
    `  File "${site}/server/scheduler.py", line 180 in _watch`,
    `  File "${lib}/threading.py", line 1024 in run`,
    `  File "${lib}/threading.py", line 1082 in _bootstrap_inner`,
    `  File "${lib}/threading.py", line 1044 in _bootstrap`,
    '',
    'Thread 0x0000000374263000 [tensorfold-engine] (most recent call first):',
    `  File "${lib}/threading.py", line 373 in wait`,
    `  File "${lib}/queue.py", line 210 in get`,
    `  File "${site}/server/scheduler.py", line 73 in get`,
    `  File "${site}/server/scheduler.py", line 291 in _loop`,
    `  File "${site}/server/scheduler.py", line 267 in _run`,
    `  File "${lib}/threading.py", line 1024 in run`,
    `  File "${lib}/threading.py", line 1082 in _bootstrap_inner`,
    `  File "${lib}/threading.py", line 1044 in _bootstrap`,
    '',
    'Current thread 0x00000001f46fe180 (most recent call first):',
    `  File "${lib}/selectors.py", line 398 in select`,
    `  File "${lib}/socketserver.py", line 235 in serve_forever`,
    `  File "${site}/cli.py", line 603 in _serve_mlx`,
    `  File "${site}/cli.py", line 482 in cmd_serve`,
    `  File "${site}/cli.py", line 150 in main`,
    '  File "/mock/tensorfold-venv/bin/tensorfold", line 6 in <module>'
  ]
  for (const line of lines) err(line)
}

async function serve(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(serveHelp())
    return exit(0)
  }
  const parsed = parseServe(args)
  if (!parsed) return
  const { model, opts } = parsed
  if (!model) return usageError('serve', 'the following arguments are required: model')
  const isDir = existsSync(model) && statSync(model).isDirectory()
  if (!isDir && !/^[\w.-]+\/[\w.-]+$/.test(model)) {
    err(`tensorfold: ${model} is neither a directory nor a Hugging Face repo id (owner/name)`)
    return exit(1)
  }
  if (isDir && !existsSync(join(model, 'config.json'))) {
    err(`tensorfold: [Errno 2] No such file or directory: '${join(model, 'config.json')}'`)
    return exit(1)
  }
  // serve_options.check, once the family is known from config.json
  if (opts.visionUrls && !opts.vision) {
    err('tensorfold: --vision-urls needs --vision')
    return exit(1)
  }

  const served = opts.name || basename(model)
  const context = opts.context ?? 262144
  const started = Date.now()
  let serving = false
  let stopping = false
  let armed = false
  let server = null
  /** Prompt-plus-reply tokens of the newest conversations; the lane engine saves two as the server stops. */
  const conversations = []
  const remember = (tokens) => {
    conversations.push(Math.round(tokens))
    if (conversations.length > 2) conversations.shift()
  }

  // TensorFold arms faulthandler's dump just before its memory budget line; before that SIGUSR1 ends it.
  process.on('SIGUSR1', () => (armed ? stackDump() : exit(128 + 30)))

  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
  function onSignal(signal) {
    if (!serving) {
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
      return
    }
    if (FAIL === 'ignore-sigterm' || stopping) return
    stopping = true
    server?.close()
    // checkpoints.py: the newest conversations, longest first, into the snapshot folder's session-snapshots
    if (opts.snapshotDir !== 'none') {
      for (const tokens of conversations.slice().sort((a, b) => b - a)) {
        out(`[lanes] saved conversation checkpoint tokens=${tokens} (${((tokens * 72 * 1024) / GIB).toFixed(1)} GiB) in 0.4s`)
      }
    }
    setTimeout(() => exit(0), FAIL === 'slow-stop' ? 8000 : 300)
  }

  // A recorded startup sequence, in its order, with this server's name: 0.5.0's endorsed session, or the K3 run's.
  const k3 = fixtureLines('k3-serve-2026-09-29.txt')
  const servingAt = k3.findIndex((l) => l.includes('] serving '))
  const recorded = V050 ? fixtureLines('serve-log-0.5.0-endorsed-2026-09-30.txt') : k3
  const servingLine = recorded.find((l) => l.includes('] serving '))
  const startup = recorded
    .slice(0, recorded.indexOf(servingLine))
    .filter((l) => (opts.drafts && opts.drafter !== 'none') || !l.includes('] drafter '))
    // the kept-prompt line comes after the rest, only when --context is past it
    .filter((l) => !l.includes('] requests up to '))
    // a saved system block to warm is in the default snapshot folder, not in a new one
    .filter((l) => opts.snapshotDir === null || !l.includes('] warming '))
  const weights = [0.02, 0.05, 0.2, 0.1, 0.05, 0.35, 0.05, 0.08, 0.05, 0.05]
  for (let i = 0; i < startup.length; i++) {
    await sleep(LOAD_MS * (weights[i] ?? 0.05))
    const line = startup[i].replace(/loading [^:]+:/, `loading ${served}:`)
    out(line)
    armed = true
    if (V050 && opts.vision && line.includes('] 31.1 GiB of weights')) {
      log('image encoder: 1.37 GiB workspace measured at the largest image request (four images, 4,096 image tokens)')
    }
    if (i === 1 && (FAIL === 'startup' || model.includes('broken'))) {
      await sleep(LOAD_MS * 0.1)
      pythonTraceback('MemoryError: [mock] could not map the weights into MLX buffers')
      return exit(1)
    }
  }
  if (opts.context === null) {
    // fit_window: the kept size, in whole KiB of tokens (0.5.0); 0.3.6.2 fitted what one request could use
    const kept = V050 ? ' and still keep its prompt for the next turn' : ''
    log(`context window ${grouped(V050 ? Math.floor(KEPT_TOKENS / 1024) * 1024 : 65536)} tokens: the most one request can use in the 44.8 GiB memory budget${kept} (the model's window is ${grouped(context)}); have clients compact before it`)
  } else if (V050 && opts.context > KEPT_TOKENS) {
    log(`requests up to ${grouped(KEPT_TOKENS)} tokens keep their prompt for the next turn in the 44.8 GiB memory budget; a longer one is served, and its next turn prefills again`)
  }

  const state = { cache: 2 * GIB, peak: 0, inflight: new Set(), hits: 0, misses: 0, evictions: 0 }
  function memory() {
    const kv = [...state.inflight].reduce((sum, r) => sum + r.kvTokens * KV_PER_TOKEN, 0)
    const active = Math.round(31.1 * GIB + 0.45 * GIB + kv + Math.sin(Date.now() / 7000) * 0.12 * GIB)
    state.peak = Math.max(state.peak, active)
    return { active, cache: Math.round(state.cache), peak: state.peak, budget: 48103633715, mlx_budget: 44882408243, footprint: Math.round(active + state.cache + 1.1 * GIB) }
  }
  function release(request) {
    state.inflight.delete(request)
    state.cache = Math.min(8 * GIB, state.cache + request.kvTokens * KV_PER_TOKEN)
  }

  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => route(req, res, body).catch((e) => err(`[mock] ${e.stack ?? e}`)))
  })
  const access = (req, status) => log(`${req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '127.0.0.1'} "${req.method} ${req.url} HTTP/${req.httpVersion}" ${status} -`)
  const json = (req, res, status, payload) => {
    access(req, status)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  async function route(req, res, body) {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return json(req, res, 200, { status: 'ok', model: served, model_ids: [served], max_batch_size: 8, warming: false, memory: memory() })
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      return json(req, res, 200, { object: 'list', data: [{ id: served, object: 'model', created: Math.floor(started / 1000), owned_by: 'tensorfold' }] })
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) return chat(req, res, body)
    return json(req, res, 404, { error: { message: `no route for ${req.method} ${path}` } })
  }

  async function chat(req, res, body) {
    let request
    try {
      request = JSON.parse(body || '{}')
    } catch {
      return json(req, res, 400, { error: { message: 'the body is not JSON', type: 'invalid_request_error' } })
    }
    const text = (request.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const prompt = Math.max(1, Math.ceil(text.length / 4)) + 12
    const maxTokens = Number(request.max_tokens ?? request.max_completion_tokens ?? opts.maxTokens)
    const stream = request.stream === true
    const effort = request.reasoning_effort ?? opts.effort ?? 'xhigh'
    const thinking = request.chat_template_kwargs?.enable_thinking ?? opts.thinking

    const refuse = (message) => {
      if (!stream) return json(req, res, 400, { error: { message, type: 'invalid_request_error' } })
      access(req, 200)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ error: { message, type: 'invalid_request_error' } })}\n\n`)
      res.end('data: [DONE]\n\n')
    }
    if (prompt + maxTokens > context) {
      return refuse(
        `the rendered prompt has ${grouped(prompt)} tokens and requests ${grouped(maxTokens)} reply tokens; this server's context window is ${grouped(context)}. Shorten the prompt, or request at most ${grouped(Math.max(0, context - prompt))} reply tokens`
      )
    }
    const needGib = BASE_GIB + ((prompt + maxTokens) * KV_PER_TOKEN) / GIB
    if (needGib > 41.8) {
      const fit = Math.max(0, Math.floor(((41.8 - BASE_GIB) * GIB) / KV_PER_TOKEN) - maxTokens)
      const message = `This request needs about ${needGib.toFixed(1)} GiB of the 41.8 GiB MLX may use (this server's 44.8 GiB memory budget less 3.0 GiB for the rest of the process); it fits up to ${grouped(fit)} tokens in the prompt with ${grouped(maxTokens)} reply tokens. Shorten the prompt or max_tokens (the reply is reserved in full), or start the server with a smaller --context so clients compact sooner; --drafter none, a smaller or more quantized checkpoint, or a Mac with more RAM leaves more room.`
      log(`start failed req-${hex(12)} cached=0: RequestError: ${message}`)
      return refuse(message)
    }

    const id = `chatcmpl-${hex(32)}`
    const created = Math.floor(Date.now() / 1000)
    const replyTokens = Math.max(1, Math.min(maxTokens, 48 + (text.length % 400)))
    const thinkTokens = thinking ? Math.floor(replyTokens * 0.3) : 0
    const request_ = { kvTokens: 0 }
    state.inflight.add(request_)
    const receivedAt = Date.now()
    let closed = false
    res.on('close', () => (closed = true))

    if (stream) {
      access(req, 200)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
    }
    const prefillMs = (prompt / 2000) * 1000
    for (let t = 0; t < prefillMs && !closed; t += 50) {
      request_.kvTokens = (prompt * t) / prefillMs
      await sleep(Math.min(50, prefillMs - t))
    }
    const prefilledAt = Date.now()
    let firstTokenAt = null
    let content = ''
    let reasoning = ''
    let produced = 0
    for (; produced < replyTokens && !closed; produced++) {
      await sleep(1000 / TOKENS_PER_S)
      firstTokenAt ??= Date.now()
      request_.kvTokens = prompt + produced
      const word = WORDS[(produced * 7 + prompt) % WORDS.length] + ' '
      const delta = produced < thinkTokens ? { reasoning_content: word } : { content: word }
      if (produced < thinkTokens) reasoning += word
      else content += word
      if (stream) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    }
    release(request_)
    const finish = produced >= maxTokens ? 'length' : 'stop'
    const usage = { prompt_tokens: prompt, completion_tokens: produced, total_tokens: prompt + produced }
    if (!closed) {
      if (stream) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
        if (request.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [], usage })}\n\n`)
        res.end('data: [DONE]\n\n')
      } else {
        json(req, res, 200, {
          id, object: 'chat.completion', created, model: served,
          choices: [{ index: 0, message: { role: 'assistant', content: content.trim(), ...(reasoning ? { reasoning_content: reasoning.trim() } : {}) }, finish_reason: finish }],
          usage
        })
      }
    }
    const decodeS = Math.max(0.001, (Date.now() - (firstTokenAt ?? Date.now())) / 1000)
    const rounds = Math.max(1, Math.round(produced / 4.6))
    state.misses += 1
    remember(prompt + produced - 5)
    log(
      `done req-${hex(12)} prompt=${prompt} cached=0 thinking=${thinking ? 'True' : 'False'} effort=${effort} tokens=${produced} sha=${hex(12)} ` +
        `finish=${finish} tok/s=${(produced / decodeS).toFixed(1)} ttft=${(((firstTokenAt ?? Date.now()) - receivedAt) / 1000).toFixed(2)}s ` +
        `prefill=${((prefilledAt - receivedAt) / 1000).toFixed(2)}s rounds=${rounds} accepted=${Math.max(0, produced - rounds)}/${rounds * 16} ` +
        `ms/round=${(1000 / TOKENS_PER_S * 4.6).toFixed(1)} forward=${(1000 / TOKENS_PER_S * 4.6).toFixed(1)} draft=0.0 post=0.0 rows=16.8 ` +
        `checkpoints=1 (0.19 GiB, hits=${state.hits} misses=${state.misses} evictions=${state.evictions})`
    )
  }

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      pythonTraceback(`OSError: [Errno 48] Address already in use`)
      return exit(1)
    }
    pythonTraceback(`OSError: ${e.message}`)
    exit(1)
  })
  await new Promise((resolve) => server.listen(opts.port, LOOPBACK_ONLY ? '127.0.0.1' : opts.host, resolve))
  out(
    servingLine
      .replace(/serving \S+ at http:\/\/\S+?\/v1/, `serving ${served} at http://${opts.host}:${opts.port}/v1`)
      .replace(/drafts: \w+/, `drafts: ${opts.drafts ? 'on' : 'off'}`)
      .replace(/context: \d+/, `context: ${opts.context ?? (V050 ? Math.floor(KEPT_TOKENS / 1024) * 1024 : 65536)}`)
      .replace(/loaded in [\d.]+s/, `loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  )
  serving = true
  // 0.5.0 warms the saved system block for its kernels in the background, and saves it (the endorsed session)
  if (V050 && opts.snapshotDir === null) {
    setTimeout(() => {
      if (stopping) return
      log('saved system-block snapshot tokens=847 in 0.0s')
      setTimeout(() => stopping || log('warmed system block tokens=847 of 847 in 1.3s'), LOAD_MS * 0.4)
    }, LOAD_MS * 0.1)
  }

  if (FAIL === 'crash') {
    setTimeout(() => {
      log('stream error: RuntimeError: [mock] [METAL] Command buffer execution failed: Caused GPU Timeout Error')
      pythonTraceback('RuntimeError: [mock] [METAL] Command buffer execution failed: Caused GPU Timeout Error')
      exit(1)
    }, 3000)
  }
  if (INTERVAL_MS > 0) void replay(k3.slice(servingAt + 1))

  /**
   * The K3 run's request lines, replayed: each `done` line after its request's (scaled) prefill and decode. Under
   * MOCK_TENSORFOLD_MEMORY=pressure, 0.4.0+'s memory lines come between the first few.
   */
  async function replay(lines) {
    let requests = 0
    const pressure = [
      null,
      'memory: 1 of 3 streams wait for room (newest first)',
      `memory: ended req-${hex(12)}, the newest of 3 streams`,
      'memory: 0 of 2 streams wait for room (newest first)'
    ]
    for (let i = 0; !stopping; i = (i + 1) % lines.length) {
      const line = lines[i]
      if (line.includes('] done ')) {
        await simulate(line)
        requests++
        if (MEMORY_PRESSURE && V050 && pressure[requests]) log(pressure[requests])
        await sleep(INTERVAL_MS)
      } else if (line.includes('] start failed ')) {
        out(line.replace(/req-[0-9a-f]{12}/, `req-${hex(12)}`))
        await sleep(INTERVAL_MS / 2)
      } else {
        out(line)
        await sleep(30)
      }
    }
  }

  async function simulate(doneLine) {
    const field = (key) => parseFloat(new RegExp(`(?:^| )${key.replace('/', '\\/')}=([\\d.]+)`).exec(doneLine.slice(13))?.[1] ?? '0')
    const prompt = field('prompt')
    const tokens = field('tokens')
    const prefillMs = field('prefill') * 1000 * TIME_SCALE
    const decodeMs = (tokens / Math.max(1, field('tok/s'))) * 1000 * TIME_SCALE
    const request_ = { kvTokens: 0 }
    state.inflight.add(request_)
    const t0 = Date.now()
    for (;;) {
      if (stopping) return
      const elapsed = Date.now() - t0
      if (elapsed < prefillMs) request_.kvTokens = (prompt * elapsed) / prefillMs
      else if (elapsed < prefillMs + decodeMs) request_.kvTokens = prompt + (tokens * (elapsed - prefillMs)) / decodeMs
      else break
      await sleep(Math.min(100, Math.max(5, prefillMs + decodeMs - elapsed)))
    }
    release(request_)
    remember(prompt + tokens - 5)
    out(doneLine.replace(/req-[0-9a-f]{12}/, `req-${hex(12)}`).replace(/sha=[0-9a-f]+/, `sha=${hex(12)}`))
  }
}

const WORDS = 'the lane kernels verify eight rows a round while the drafter proposes the next block and every accepted token equals the serial reply'.split(' ')

// ------------------------------------------------------------------------------------------------ info, models, pull

function infoLine(key, value) {
  return key.length <= 12 ? `${key.padEnd(12)} ${value}` : `${key} ${value}`
}

function info(model) {
  if (!model) return usageError('info', 'the following arguments are required: model')
  if (!existsSync(model) || !statSync(model).isDirectory()) {
    err(`tensorfold: ${model} is neither a directory nor a Hugging Face repo id (owner/name)`)
    return exit(1)
  }
  const configPath = join(model, 'config.json')
  if (!existsSync(configPath)) {
    err(`tensorfold: [Errno 2] No such file or directory: '${configPath}'`)
    return exit(1)
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const text = config.text_config ?? config
  if (config.model_type !== 'qwen3_5') {
    const families = V050
      ? 'deepseek_v4, gemma4, gemma4_text, glm5_next, nemotron_h, prism_hadamard_qwen35, qwen3_5, qwen3_5_moe, qwen4_exp'
      : 'gemma4, gemma4_text, glm5_next, nemotron_h, qwen3_5, qwen3_5_moe, qwen4_exp'
    err(
      `tensorfold: TensorFold has no recipe for model_type '${config.model_type}' yet (it has: ${families}; \`tensorfold models\` lists the tested checkpoints). To run a model or checkpoint TensorFold has no recipe for, write one with the recipe book (https://github.com/ashhart/TensorFold/blob/main/docs/recipes/README.md: adding a family on a Mac, adding a CUDA family on NVIDIA GPUs), and read the runbook first (https://github.com/ashhart/TensorFold/blob/main/RUNBOOK.md).`
    )
    return exit(1)
  }
  const q = config.quantization ?? {}
  out(infoLine('model_type', config.model_type))
  out(infoLine('family', 'Qwen3.8 dense (tensorfold.families.qwen3_5)'))
  out(infoLine('engine', 'MLX lane engine, CUDA engine'))
  out(infoLine('kernels', 'qwen/dense/v1'))
  for (const key of ['num_hidden_layers', 'hidden_size', 'vocab_size', 'max_position_embeddings']) {
    if (text[key] !== undefined) out(infoLine(key, text[key]))
  }
  out(infoLine('quantization', q.bits ? `MLX ${q.bits}-bit, groups of ${q.group_size ?? 64}` : 'none (bf16)'))
  out(infoLine('CUDA formats', 'affine 2/3/4/5/6/8-bit, groups 32/64/128'))
  out(infoLine('runs on', 'Apple Silicon (MLX), NVIDIA GPUs (CUDA)'))
  if ((text.hidden_size ?? 0) < 5120) {
    err('tensorfold: Qwen3.8 dense cannot run this checkpoint: the tied embedding head is not supported by this packed Qwen decoder. Use Vontra/Qwen3.8-27B-MLX-4bit')
    return exit(1)
  }
  out(infoLine('sampling', `{'temperature': ${(config.temperature ?? 1).toFixed(1)}, 'top_k': ${config.top_k ?? 20}, 'top_p': ${config.top_p ?? 0.95}}`))
  exit(0)
}

function models() {
  process.stdout.write(readFileSync(join(FIXTURES, V050 ? 'tensorfold-models.txt' : 'tensorfold-models-0.3.6.2.txt'), 'utf8'))
  exit(0)
}

/** `update --check` as update.py answers it; the mock asks no one. */
function update(args) {
  if (!args.includes('--check')) {
    err('[mock] only `update --check` is simulated: the mock installs nothing')
    return exit(1)
  }
  const latest = process.env.MOCK_TENSORFOLD_LATEST ?? VERSION
  if (latest === 'offline') {
    err('[tensorfold] could not reach GitHub to look for releases (https://api.github.com/repos/ashhart/TensorFold/releases/latest)')
    return exit(1)
  }
  const newer = latest.split('.').map(Number).reduce((cmp, part, i) => cmp || part - (Number(VERSION.split('.')[i]) || 0), 0) > 0
  if (newer) log(`TensorFold ${latest} is available (this is ${VERSION})`)
  else log(`TensorFold ${VERSION} is the latest release`)
  exit(0)
}

async function pull(repos) {
  if (repos.length === 0) return usageError('pull', 'the following arguments are required: repos')
  let stop = false
  process.on('SIGTERM', () => {
    stop = true
    exit(143)
  })
  for (const repo of repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      err(`tensorfold: ${repo} is not a Hugging Face repo id (owner/name)`)
      return exit(1)
    }
    log(`downloading ${repo} from Hugging Face`)
    const files = 6
    for (let i = 0; i <= files && !stop; i++) {
      const pct = Math.round((100 * i) / files)
      process.stderr.write(`\rFetching ${files} files: ${String(pct).padStart(3)}%|${'█'.repeat(Math.round(pct / 10)).padEnd(10)}| ${i}/${files} [00:0${i}<00:0${files - i},  2.50it/s]`)
      await sleep(PULL_STEP_MS)
    }
    process.stderr.write('\n')
    const what = /dflash|draft/i.test(repo) ? 'no model family (a draft model?)' : 'Qwen3.8 dense (qwen3_5)'
    out(`${repo}: 3.1 GB in /mock/hf-cache/hub/models--${repo.replace('/', '--')}/snapshots/${hex(40)} [${what}]`)
  }
  exit(0)
}

// ------------------------------------------------------------------------------------------------ main

const [command, ...rest] = process.argv.slice(2)
if (command === '--version') {
  out(`tensorfold ${VERSION}`)
  exit(0)
} else if (command === 'serve') {
  await serve(rest)
} else if (command === 'info') {
  info(rest[0])
} else if (command === 'models') {
  models()
} else if (command === 'pull') {
  await pull(rest)
} else if (command === 'update') {
  update(rest)
} else {
  err('usage: tensorfold [-h] [--version] {serve,pull,models,update,info} ...')
  if (command !== undefined && command !== '-h' && command !== '--help') err(`tensorfold: error: argument command: invalid choice: '${command}'`)
  exit(command === undefined || command === '-h' || command === '--help' ? 0 : 2)
}
