import { connect, createServer } from 'node:net'

/** True when nothing listens on host:port (the check TensorFold itself makes only after loading). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/** True when something accepts connections on 127.0.0.1:port: a server there, or one on every interface. */
export function isPortAnswering(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * True when a server could take the port. macOS lets a server bind 0.0.0.0 while another holds 127.0.0.1 on the same
 * port (and Python's servers do), so a bind alone would let a remote server start beside a local one. A server on
 * either answers on 127.0.0.1. Every interface is never bound here, so the check sets off no firewall prompt.
 */
export async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  if (await isPortAnswering(port)) return false
  return host === '0.0.0.0' || host === '::' ? true : isPortFree(port, host)
}

/** Who holds the port, as far as an OpenAI-compatible /v1/models says. */
export async function describePortOwner(port: number, host = '127.0.0.1', fetchImpl: typeof fetch = fetch): Promise<string> {
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  try {
    const res = await fetchImpl(`http://${h}:${port}/v1/models`, { signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as { data?: Array<{ id?: string; owned_by?: string }> }
    const model = body.data?.[0]
    if (model?.owned_by === 'tensorfold') return `a TensorFold server (${model.id}) is already serving on port ${port}`
    if (model?.id) return `another OpenAI-compatible server (${model.id}) is on port ${port}`
  } catch {
    // not an HTTP server, or it did not answer in time
  }
  return `port ${port} is in use by another program`
}
