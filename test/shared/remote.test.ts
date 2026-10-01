import { describe, expect, it } from 'vitest'
import { applyPreset, buildServeArgv, emptyConfig } from '@shared/config'
import { REMOTE_HOST, isRemote, listensBeyond, remoteUrls, withRemote, type NetworkAddresses } from '@shared/remote'

const MODEL = '/m/Qwen3.8-27B-MLX-8bit'
const ADDRESSES: NetworkAddresses = { hostname: 'Peters-MacBook-Pro.local', ipv4: [{ name: 'en0', address: '10.0.0.157' }] }

describe('the remote-connections switch', () => {
  it('is --host 0.0.0.0 when on, and no --host (127.0.0.1) when off', () => {
    const endorsed = applyPreset(emptyConfig(MODEL), 'endorsed')
    const on = withRemote(endorsed, true)
    expect(isRemote(on)).toBe(true)
    expect(on.endpoint).toEqual({ port: 8080, host: REMOTE_HOST })
    expect(buildServeArgv(on).slice(2, 4)).toEqual(['--host', '0.0.0.0'])
    const off = withRemote(on, false)
    expect(isRemote(off)).toBe(false)
    expect(off.endpoint).toEqual({ port: 8080 })
    expect(buildServeArgv(off)).toEqual(buildServeArgv(endorsed))
  })

  it('tells this Mac alone from the network', () => {
    const at = (host?: string): boolean => listensBeyond({ ...emptyConfig(MODEL), endpoint: host === undefined ? {} : { host } })
    expect([at(), at(''), at('127.0.0.1'), at('localhost'), at('::1')]).toEqual([false, false, false, false, false])
    expect([at('0.0.0.0'), at('10.0.0.157'), at('fe80::1')]).toEqual([true, true, true])
    expect(isRemote({ ...emptyConfig(MODEL), endpoint: { host: '10.0.0.157' } })).toBe(false)
  })

  it('names the URLs other machines use: the Bonjour name first, then the addresses', () => {
    const on = { ...emptyConfig(MODEL), endpoint: { host: '0.0.0.0', port: 8081 } }
    expect(remoteUrls(on, ADDRESSES)).toEqual(['http://Peters-MacBook-Pro.local:8081/v1', 'http://10.0.0.157:8081/v1'])
    expect(remoteUrls(on, null)).toEqual([])
    expect(remoteUrls({ ...emptyConfig(MODEL), endpoint: { host: '10.0.0.157' } }, ADDRESSES)).toEqual(['http://10.0.0.157:8080/v1'])
    expect(remoteUrls({ ...emptyConfig(MODEL), endpoint: { host: 'fe80::1' } }, ADDRESSES)).toEqual(['http://[fe80::1]:8080/v1'])
    expect(remoteUrls(emptyConfig(MODEL), ADDRESSES)).toEqual([])
  })
})
