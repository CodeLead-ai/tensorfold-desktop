/** `tensorfold pull <repo>` (SPEC §3.7): its progress (Hugging Face's bars on stderr) and its result line. */

export interface PullProgress {
  label: string
  percent: number
  done: string
  total: string
}

export interface PullState {
  repo: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt: number | null
  /** Output other than progress redraws, last lines first kept. */
  lines: string[]
  progress: PullProgress | null
  /** `<repo>: 3.1 GB in <path> [<family>]` */
  result: { repo: string; gb: number; path: string; what: string } | null
  exitCode: number | null
}

/** A tqdm bar: `Fetching 6 files:  50%|█████     | 3/6 [00:01<00:01,  2.50it/s]`. */
export function parseProgress(segment: string): PullProgress | null {
  const m = /^(.*?):\s+(\d+)%\|.*?\|\s*([\d.]+\s*[kMGTB]*)\/([\d.]+\s*[kMGTB]*)/.exec(segment.trim())
  if (!m) return null
  return { label: (m[1] as string).trim(), percent: Number(m[2]), done: (m[3] as string).trim(), total: (m[4] as string).trim() }
}

export function parsePullResult(line: string): PullState['result'] {
  const m = /^(\S+\/\S+): ([\d.]+) GB in (.+) \[(.+)\]$/.exec(line.trim())
  return m ? { repo: m[1] as string, gb: Number(m[2]), path: m[3] as string, what: m[4] as string } : null
}

export function isRepoId(text: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(text)
}
