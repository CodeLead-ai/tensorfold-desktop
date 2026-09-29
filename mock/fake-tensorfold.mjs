#!/usr/bin/env node
/**
 * A stand-in for the `tensorfold` CLI (0.3.6.2) so TensorFold Desk can be built and tested on any machine
 * (SPEC §4, "Dev without a 27B"). No dependencies.
 *
 *   fake-tensorfold.mjs --version | serve <model> [flags] | info <dir> | models | pull <repo…>
 *
 * `serve` prints the real startup lines (test/fixtures), answers GET /v1/models, GET /health (memory that
 * rises during each prefill) and POST /v1/chat/completions (streaming or not), and replays the K3 run's
 * request lines on a timer, sped up. SIGTERM before "serving" kills it at once, as TensorFold installs its
 * handler only once it serves; after, it shuts down and exits 0.
 *
 * Environment:
 *   MOCK_TENSORFOLD_LOAD_MS      startup duration (default 2500)
 *   MOCK_TENSORFOLD_TIME_SCALE   replayed requests take this fraction of their real time (default 0.06)
 *   MOCK_TENSORFOLD_INTERVAL_MS  pause between replayed requests; 0 turns the replay off (default 1500)
 *   MOCK_TENSORFOLD_TOKENS_PER_S decode speed for real chat requests (default 60)
 *   MOCK_TENSORFOLD_PULL_STEP_MS progress step of `pull` (default 400)
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
const VERSION = '0.3.6.2'
const GIB = 1024 ** 3
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

// ------------------------------------------------------------------------------------------------ serve

function parseServe(args) {
  const opts = { host: '127.0.0.1', port: 8080, context: null, name: '', drafts: true, drafter: 'auto', maxTokens: 4096, thinking: true, effort: 'medium' }
  const switches = new Set(['--no-drafts', '--thinking', '--no-thinking', '--ple-on-ssd', '--no-update-check'])
  let model = null
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (!word.startsWith('--')) {
      model = word
      continue
    }
    const eq = word.indexOf('=')
    const flag = eq > 0 ? word.slice(0, eq) : word
    const value = switches.has(flag) ? undefined : eq > 0 ? word.slice(eq + 1) : args[++i]
    if (!switches.has(flag) && value === undefined) usageError('serve', `argument ${flag}: expected one argument`)
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

async function serve(args) {
  const { model, opts } = parseServe(args)
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

  const served = opts.name || basename(model)
  const context = opts.context ?? 262144
  const started = Date.now()
  let serving = false
  let stopping = false
  let server = null

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
    setTimeout(() => exit(0), FAIL === 'slow-stop' ? 8000 : 300)
  }

  // The K3 run's startup sequence, in its order, with this server's name.
  const k3 = fixtureLines('k3-serve-2026-09-29.txt')
  const servingAt = k3.findIndex((l) => l.includes('] serving '))
  const startup = k3.slice(0, servingAt).filter((l) => (opts.drafts && opts.drafter !== 'none') || !l.includes('] drafter '))
  const weights = [0.02, 0.05, 0.2, 0.1, 0.05, 0.35, 0.05, 0.08, 0.05, 0.05]
  for (let i = 0; i < startup.length; i++) {
    await sleep(LOAD_MS * (weights[i] ?? 0.05))
    out(startup[i].replace(/loading [^:]+:/, `loading ${served}:`))
    if (i === 1 && (FAIL === 'startup' || model.includes('broken'))) {
      await sleep(LOAD_MS * 0.1)
      pythonTraceback('MemoryError: [mock] could not map the weights into MLX buffers')
      return exit(1)
    }
  }
  if (opts.context === null) {
    log(`context window ${grouped(65536)} tokens: the most one request can use in the 44.8 GiB memory budget (the model's window is ${grouped(context)}); have clients compact before it`)
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
    const effort = request.reasoning_effort ?? opts.effort
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
  await new Promise((resolve) => server.listen(opts.port, opts.host, resolve))
  out(
    k3[servingAt]
      .replace(/serving \S+ at http:\/\/\S+?\/v1/, `serving ${served} at http://${opts.host}:${opts.port}/v1`)
      .replace(/drafts: \w+/, `drafts: ${opts.drafts ? 'on' : 'off'}`)
      .replace(/context: \d+/, `context: ${opts.context ?? 65536}`)
      .replace(/loaded in [\d.]+s/, `loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  )
  serving = true

  if (FAIL === 'crash') {
    setTimeout(() => {
      log('stream error: RuntimeError: [mock] [METAL] Command buffer execution failed: Caused GPU Timeout Error')
      pythonTraceback('RuntimeError: [mock] [METAL] Command buffer execution failed: Caused GPU Timeout Error')
      exit(1)
    }, 3000)
  }
  if (INTERVAL_MS > 0) void replay(k3.slice(servingAt + 1))

  /** The K3 run's request lines, replayed: each `done` line after its request's (scaled) prefill and decode. */
  async function replay(lines) {
    for (let i = 0; !stopping; i = (i + 1) % lines.length) {
      const line = lines[i]
      if (line.includes('] done ')) {
        await simulate(line)
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
    err(
      `tensorfold: TensorFold has no recipe for model_type '${config.model_type}' yet (it has: gemma4, gemma4_text, glm5_next, nemotron_h, qwen3_5, qwen3_5_moe, qwen4_exp; \`tensorfold models\` lists the tested checkpoints). To run a model or checkpoint TensorFold has no recipe for, write one with the recipe book (https://github.com/ashhart/TensorFold/blob/main/docs/recipes/README.md: adding a family on a Mac, adding a CUDA family on NVIDIA GPUs), and read the runbook first (https://github.com/ashhart/TensorFold/blob/main/RUNBOOK.md).`
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
  process.stdout.write(readFileSync(join(FIXTURES, 'tensorfold-models.txt'), 'utf8'))
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
} else {
  err('usage: tensorfold [-h] [--version] {serve,pull,models,update,info} ...')
  if (command !== undefined && command !== '-h' && command !== '--help') err(`tensorfold: error: argument command: invalid choice: '${command}'`)
  exit(command === undefined || command === '-h' || command === '--help' ? 0 : 2)
}
