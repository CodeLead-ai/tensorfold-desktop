const PATHS = {
  server: 'M5 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 9h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2ZM7 7.5h.01M7 16.5h.01',
  requests: 'M3 12h4l3 7 4-14 3 7h4',
  checkpoints: 'M12 3 3 7.5l9 4.5 9-4.5L12 3Zm-9 9 9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  probe: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 1v3m0 16v3M1 12h3m16 0h3',
  log: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 5 3 3-3 3m6 0h4',
  settings: 'M4 7h9m4 0h3M4 12h3m4 0h9M4 17h11m4 0h1M15 5v4M9 10v4M17 15v4',
  play: 'M8 5.5v13l10.5-6.5L8 5.5Z',
  stop: 'M7 7h10v10H7z',
  restart: 'M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5',
  copy: 'M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9Zm-4 6V5a2 2 0 0 1 2-2h8',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  chevron: 'm9 6 6 6-6 6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 21h16',
  close: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 3 2 20h20L12 3Zm0 7v4m0 3h.01',
  kill: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  export: 'M12 15V3m-5 5 5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  brand: 'M4 7.5 12 4l8 3.5-8 3.5-8-3.5Zm0 4.5 8 3.5 8-3.5M4 16.5 12 20l8-3.5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4'
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, filled = false }: { name: IconName; size?: number; filled?: boolean }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
