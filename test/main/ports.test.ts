import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isPortAnswering, isPortAvailable, isPortFree } from '../../src/main/ports'
import { freePort } from '../helpers'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

function hold(port: number, host: string): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy())
    servers.push(server)
    server.listen(port, host, () => resolve())
  })
}

describe('the port check', () => {
  it('finds a free port free, for this Mac and for every interface', async () => {
    const port = await freePort()
    expect(await isPortAnswering(port)).toBe(false)
    expect(await isPortAvailable(port)).toBe(true)
    expect(await isPortAvailable(port, '0.0.0.0')).toBe(true)
  })

  it("sees a server on 127.0.0.1 from a remote start, which macOS would let bind 0.0.0.0 beside it", async () => {
    const port = await freePort()
    await hold(port, '127.0.0.1')
    expect(await isPortAnswering(port)).toBe(true)
    expect(await isPortAvailable(port)).toBe(false)
    expect(await isPortAvailable(port, '0.0.0.0')).toBe(false)
    expect(await isPortFree(port)).toBe(false)
  })
})
