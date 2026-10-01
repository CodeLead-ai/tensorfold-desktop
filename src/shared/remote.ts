/**
 * Remote connections: the switch that has the server listen on every network interface (`--host 0.0.0.0`), and the
 * addresses other machines then use. TensorFold has no password, no API key and no encryption, so the app asks
 * before it turns this on (src/main/ipc.ts). Off is TensorFold's default: 127.0.0.1, this Mac only.
 */
import type { ServeConfig } from './config'

/** `--host` for every network interface. */
export const REMOTE_HOST = '0.0.0.0'

const THIS_MAC_ONLY = new Set(['127.0.0.1', 'localhost', '::1'])

/** This Mac's names on the network. */
export interface NetworkAddresses {
  /** The Bonjour name other Macs resolve: `Peters-MacBook-Pro.local`. */
  hostname: string
  /** Its IPv4 addresses, Wi-Fi and Ethernet first. */
  ipv4: Array<{ name: string; address: string }>
}

/** The switch's state: on exactly when the server would listen on every interface. */
export function isRemote(config: ServeConfig): boolean {
  return config.endpoint.host === REMOTE_HOST
}

/** Whether the server would be reachable beyond this Mac: every interface, or one of its network addresses. */
export function listensBeyond(config: ServeConfig): boolean {
  const host = config.endpoint.host
  return host !== undefined && host !== '' && !THIS_MAC_ONLY.has(host)
}

/** The configuration with remote connections on (`--host 0.0.0.0`) or off (no `--host`: 127.0.0.1). */
export function withRemote(config: ServeConfig, on: boolean): ServeConfig {
  const { host: _host, ...endpoint } = config.endpoint
  return { ...config, endpoint: on ? { ...endpoint, host: REMOTE_HOST } : endpoint }
}

/** The OpenAI base URLs other machines use, the Bonjour name first; empty when only this Mac can connect. */
export function remoteUrls(config: ServeConfig, addresses: NetworkAddresses | null): string[] {
  const host = config.endpoint.host
  if (!listensBeyond(config) || host === undefined) return []
  const port = config.endpoint.port ?? 8080
  const url = (h: string): string => `http://${h.includes(':') ? `[${h}]` : h}:${port}/v1`
  if (host !== REMOTE_HOST) return [url(host)]
  return addresses ? [url(addresses.hostname), ...addresses.ipv4.map((a) => url(a.address))] : []
}
