import { describe, expect, it } from 'vitest'
import { localAddresses, remoteWarning } from '../../src/main/remote'

describe('remote connections in the main process', () => {
  it("names this Mac: a Bonjour name, and IPv4 addresses that aren't loopback", () => {
    const addresses = localAddresses()
    expect(addresses.hostname).toMatch(/\./)
    for (const a of addresses.ipv4) {
      expect(a.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      expect(a.address.startsWith('127.')).toBe(false)
    }
  })

  it('warns of no password or API key, no encryption, and the firewall, and says where to connect', () => {
    const { message, detail } = remoteWarning(8080, { hostname: 'Peters-MacBook-Pro.local', ipv4: [{ name: 'en0', address: '10.0.0.157' }] })
    expect(message).toBe('Allow connections from other machines?')
    expect(detail).toContain('http://Peters-MacBook-Pro.local:8080/v1 or http://10.0.0.157:8080/v1')
    expect(detail).toContain('No password or API key')
    expect(detail).toContain('No encryption')
    expect(detail).toContain('the first time, macOS may ask whether Python may accept incoming connections')
    expect(remoteWarning(9000, { hostname: 'mac.local', ipv4: [] }).detail).toContain('connect at http://mac.local:9000/v1.')
  })
})
