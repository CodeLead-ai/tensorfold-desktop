/** LM Studio, this Mac's other server (SPEC §2.5): what `lms ps --json` says is loaded. */

export interface LmsModel {
  identifier: string
  modelKey: string
  displayName: string | null
  sizeBytes: number | null
  status: string | null
  contextLength: number | null
  architecture: string | null
}

export interface LmStudioStatus {
  /** lms was found and answered. */
  available: boolean
  lms: string | null
  models: LmsModel[]
  error: string | null
  checkedAt: number
}

export interface CommandResult {
  ok: boolean
  command: string
  code: number | null
  output: string
  error: string | null
}

export function parseLmsPs(stdout: string): LmsModel[] {
  const data: unknown = JSON.parse(stdout)
  if (!Array.isArray(data)) throw new Error('lms ps --json did not print a list')
  return data.map((raw) => {
    const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const str = (k: string): string | null => (typeof m[k] === 'string' ? (m[k] as string) : null)
    const num = (k: string): number | null => (typeof m[k] === 'number' ? (m[k] as number) : null)
    return {
      identifier: str('identifier') ?? str('modelKey') ?? '?',
      modelKey: str('modelKey') ?? str('path') ?? '?',
      displayName: str('displayName'),
      sizeBytes: num('sizeBytes'),
      status: str('status'),
      contextLength: num('contextLength'),
      architecture: str('architecture')
    }
  })
}
