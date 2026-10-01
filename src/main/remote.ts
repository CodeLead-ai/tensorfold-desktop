/**
 * Remote connections in the main process: this Mac's names on the network, and the words of the confirmation shown
 * before the form lets other machines connect (the dialog itself is in ipc.ts). No Electron here.
 */
import { hostname, networkInterfaces } from 'node:os'
import type { NetworkAddresses } from '@shared/remote'

export function localAddresses(): NetworkAddresses {
  const name = hostname()
  const ipv4: NetworkAddresses['ipv4'] = []
  for (const [iface, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) ipv4.push({ name: iface, address: entry.address })
  }
  // Wi-Fi and Ethernet (en0, en1, …) before VPNs and bridges.
  const wired = (n: string): number => (/^en\d+$/.test(n) ? 0 : 1)
  ipv4.sort((a, b) => wired(a.name) - wired(b.name))
  return { hostname: name.includes('.') ? name : `${name}.local`, ipv4 }
}

/** What the confirmation says: where other machines connect, and the three things to know first. */
export function remoteWarning(port: number, addresses: NetworkAddresses): { message: string; detail: string } {
  const lan = addresses.ipv4[0]
  return {
    message: 'Allow connections from other machines?',
    detail: [
      `The server will listen on every network interface (--host 0.0.0.0). Other machines connect at http://${addresses.hostname}:${port}/v1${lan ? ` or http://${lan.address}:${port}/v1` : ''}.`,
      '',
      '• No password or API key: TensorFold has none yet, so anyone who can reach this port can use the model.',
      '• No encryption: prompts and replies travel as plain HTTP.',
      '• Firewall: the first time, macOS may ask whether Python may accept incoming connections. Allow it, or other machines cannot connect.',
      '',
      'It takes effect when the server starts or restarts.'
    ].join('\n')
  }
}
