import { createServer } from 'node:net'

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
