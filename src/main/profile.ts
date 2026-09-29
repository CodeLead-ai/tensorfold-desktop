import { join } from 'node:path'

/**
 * Which profile the app runs under. `npm run dev:mock` sets TENSORFOLD_DESK_MOCK=1: the app then keeps its
 * settings and logs apart ("TensorFold Desk (mock)") and defaults to the fake tensorfold, the mock
 * checkpoints and the fake lms in this repository.
 */
export interface Profile {
  mock: boolean
  /** App name, which also names the userData folder. */
  name: string
  /** Defaults the mock profile starts with. */
  mockDefaults: {
    binary: string
    model: string
    checkpointRoots: string[]
    lms: string
    restoreCommand: string
  } | null
}

export function resolveProfile(env: NodeJS.ProcessEnv, appRoot: string): Profile {
  const mock = env['TENSORFOLD_DESK_MOCK'] === '1'
  if (!mock) return { mock, name: 'TensorFold Desk', mockDefaults: null }
  const dir = join(appRoot, 'mock')
  return {
    mock,
    name: 'TensorFold Desk (mock)',
    mockDefaults: {
      binary: join(dir, 'fake-tensorfold.mjs'),
      model: join(dir, 'models', 'lmstudio-community', 'Qwen3.8-27B-MLX-8bit'),
      checkpointRoots: [join(dir, 'models'), join(dir, 'hf-cache', 'hub')],
      lms: join(dir, 'fake-lms.mjs'),
      restoreCommand: 'lms load google/gemma-4-e4b'
    }
  }
}
