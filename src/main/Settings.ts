import Store from 'electron-store'
import { defaultSettings, sanitizeSettings, type Settings } from '@shared/settings'
import type { Profile } from './profile'

export interface SettingsStore {
  get(): Settings
  set(patch: Partial<Settings>): Settings
}

/**
 * The defaults for this profile: the mock profile points at the mock checkpoints and the fake lms (the fake
 * tensorfold is found by findBinary when no binary is set).
 */
export function profileDefaults(profile: Profile, home: string): Settings {
  const defaults = defaultSettings(home)
  const mock = profile.mockDefaults
  if (!mock) return defaults
  return {
    ...defaults,
    checkpointRoots: mock.checkpointRoots,
    lmsPath: mock.lms,
    restoreCommand: mock.restoreCommand,
    lastConfig: { ...defaults.lastConfig, model: mock.model }
  }
}

/** Settings in `<userData>/settings.json` (electron-store), checked on every read and write. */
export class SettingsService implements SettingsStore {
  private readonly store: Store<Settings>

  constructor(private readonly defaults: Settings) {
    this.store = new Store<Settings>({ name: 'settings', defaults })
  }

  get(): Settings {
    return sanitizeSettings(this.store.store, this.defaults)
  }

  set(patch: Partial<Settings>): Settings {
    const next = sanitizeSettings({ ...this.get(), ...patch }, this.defaults)
    this.store.store = next
    return next
  }
}

export class MemorySettings implements SettingsStore {
  private value: Settings
  constructor(private readonly defaults: Settings) {
    this.value = defaults
  }
  get(): Settings {
    return this.value
  }
  set(patch: Partial<Settings>): Settings {
    this.value = sanitizeSettings({ ...this.value, ...patch }, this.defaults)
    return this.value
  }
}
