// Draws the app icon: build/icon.svg, and build/icon.png (1024 px, rendered by Electron's Chromium).
//
// The mark joins the two brands. TensorFold's folded sheet (a mesh with lit nodes, coral to violet) twists
// once, and past the twist it turns into CodeLead's blue to cyan. It sits on CodeLead's dark navy tile with the
// site's faint grid, over the small glowing cursor of CodeLead's monogram. No dependencies but Electron.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const f = (n) => Number(n.toFixed(1))

// ------------------------------------------------------------------ the ribbon: one band, one twist
// A band of steady width follows a gentle S and turns over once in the middle: its apparent width is
// W·cos(θ), θ going from 0 to π across the twist, so the edges cross there and swap sides, as a real twisted
// sheet's do. Its ends taper to tips, like the sheet in TensorFold's logo.
const P = [
  [126, 606],
  [384, 270],
  [640, 770],
  [902, 392]
]
function at(t) {
  const u = 1 - t
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return [0, 1].map((k) => w.reduce((s, wi, i) => s + wi * P[i][k], 0))
}
function normal(t) {
  const u = 1 - t
  const d = [0, 1].map((k) => 3 * u * u * (P[1][k] - P[0][k]) + 6 * u * t * (P[2][k] - P[1][k]) + 3 * t * t * (P[3][k] - P[2][k]))
  const len = Math.hypot(d[0], d[1])
  return [-d[1] / len, d[0] / len]
}
const clamp = (x) => Math.min(1, Math.max(0, x))
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const TWIST = 0.5
/** Signed half-width: positive before the twist, negative after it (the edges have swapped sides). */
function halfWidth(t) {
  const width = 112 - 16 * t
  const tip = 0.3
  const taper = t < tip ? Math.sin(((t / tip) * Math.PI) / 2) : t > 1 - tip ? Math.sin((((1 - t) / tip) * Math.PI) / 2) : 1
  return width * Math.pow(taper, 1.35) * Math.cos(Math.PI * smoothstep(0.35, 0.65, t))
}
function point(t, s) {
  const [x, y] = at(t)
  const [nx, ny] = normal(t)
  const h = halfWidth(t) * s
  return [x + nx * h, y + ny * h]
}
const range = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n)

function segmentPath(t0, t1) {
  const ts = range(t0, t1, 120)
  const a = ts.map((t) => point(t, 1))
  const b = ts.map((t) => point(t, -1)).reverse()
  return `M${[...a, ...b].map(([x, y]) => `${f(x)},${f(y)}`).join(' L')} Z`
}
function polyline(pts) {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)},${f(y)}`).join(' ')
}

// The mesh on each half: lines along the band, lines across it, and a lit node at each crossing. Nodes on the
// half of the band nearer its lit edge shine brighter; none where the band is too narrow to show them.
function mesh(t0, t1) {
  const lines = []
  for (const s of [-0.6, -0.2, 0.2, 0.6]) lines.push(polyline(range(t0, t1, 80).map((t) => point(t, s))))
  const across = range(t0, t1, 11).slice(1, -1).filter((t) => Math.abs(halfWidth(t)) > 18)
  for (const t of across) lines.push(polyline(range(-1, 1, 12).map((s) => point(t, s))))
  const nodes = []
  for (const t of across) {
    for (const s of [-0.8, -0.4, 0, 0.4, 0.8]) {
      const [x, y] = point(t, s)
      const lit = (s + 1) / 2
      nodes.push({ x, y, r: 3.4 + 2.4 * lit, o: 0.4 + 0.55 * lit })
    }
  }
  return { lines, nodes }
}

const left = { path: segmentPath(0, TWIST), mesh: mesh(0, TWIST), tip: at(0) }
const right = { path: segmentPath(TWIST, 1), mesh: mesh(TWIST, 1), tip: at(1) }
// One physical edge of the sheet, lit along its whole length: it crosses over at the twist.
const litEdge = polyline(range(0.012, 0.988, 200).map((t) => point(t, 1)))
const darkEdge = polyline(range(0.012, 0.988, 200).map((t) => point(t, -1)))
const [px, py] = at(TWIST)

const meshSvg = (m) => `
    <g stroke="#ffffff" stroke-opacity="0.13" stroke-width="1.6" fill="none">${m.lines.map((d) => `<path d="${d}"/>`).join('')}</g>
    <g fill="#ffffff" filter="url(#node)">${m.nodes.map((n) => `<circle cx="${f(n.x)}" cy="${f(n.y)}" r="${f(n.r)}" fill-opacity="${f(n.o)}"/>`).join('')}</g>`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="tile" cx="50%" cy="34%" r="78%">
      <stop offset="0" stop-color="#172a52"/>
      <stop offset="0.5" stop-color="#0b1631"/>
      <stop offset="1" stop-color="#050a18"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="0.35" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse" x="0" y="0">
      <path d="M64 0H0V64" fill="none" stroke="#2f7cff" stroke-opacity="0.09" stroke-width="2"/>
    </pattern>
    <linearGradient id="tfold" gradientUnits="userSpaceOnUse" x1="${f(left.tip[0])}" y1="${f(left.tip[1])}" x2="${f(px)}" y2="${f(py)}">
      <stop offset="0" stop-color="#ff9a5c"/>
      <stop offset="0.42" stop-color="#ff5f8f"/>
      <stop offset="1" stop-color="#8a5cff"/>
    </linearGradient>
    <linearGradient id="clead" gradientUnits="userSpaceOnUse" x1="${f(px)}" y1="${f(py)}" x2="${f(right.tip[0])}" y2="${f(right.tip[1])}">
      <stop offset="0" stop-color="#5a5cff"/>
      <stop offset="0.5" stop-color="#2b8bff"/>
      <stop offset="1" stop-color="#7dd3ff"/>
    </linearGradient>
    <linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="${f(left.tip[0])}" y1="${f(left.tip[1])}" x2="${f(right.tip[0])}" y2="${f(right.tip[1])}">
      <stop offset="0" stop-color="#ffe2cc"/>
      <stop offset="0.5" stop-color="#f1e6ff"/>
      <stop offset="1" stop-color="#d4f1ff"/>
    </linearGradient>
    <radialGradient id="fold" gradientUnits="userSpaceOnUse" cx="${f(px)}" cy="${f(py)}" r="120">
      <stop offset="0" stop-color="#050a18" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#050a18" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="spark" gradientUnits="userSpaceOnUse" cx="${f(px)}" cy="${f(py)}" r="30">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="0.35" stop-color="#d9ccff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#8a5cff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cursor" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#4fc3ff"/>
      <stop offset="1" stop-color="#7dd3ff"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="26"/></filter>
    <filter id="node" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
    <clipPath id="tileClip"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
  </defs>

  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#tile)" filter="url(#shadow)"/>
  <g clip-path="url(#tileClip)">
    <rect x="100" y="100" width="824" height="824" fill="url(#grid)"/>
    <rect x="100" y="100" width="824" height="824" fill="url(#sheen)"/>

    <g filter="url(#glow)" opacity="0.75">
      <path d="${left.path}" fill="url(#tfold)"/>
      <path d="${right.path}" fill="url(#clead)"/>
    </g>

    <path d="${right.path}" fill="url(#clead)"/>
    ${meshSvg(right.mesh)}
    <path d="${left.path}" fill="url(#tfold)"/>
    ${meshSvg(left.mesh)}

    <path d="${left.path} ${right.path}" fill="url(#fold)"/>
    <path d="${darkEdge}" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="3" stroke-linecap="round"/>
    <path d="${litEdge}" fill="none" stroke="url(#edge)" stroke-width="6" stroke-linecap="round"/>
    <circle cx="${f(px)}" cy="${f(py)}" r="30" fill="url(#spark)"/>

    <rect x="448" y="790" width="128" height="22" rx="11" fill="#4fc3ff" filter="url(#soft)" opacity="0.9"/>
    <rect x="448" y="790" width="128" height="22" rx="11" fill="url(#cursor)"/>
  </g>
  <rect x="101" y="101" width="822" height="822" rx="185" fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="2"/>
</svg>
`

const buildDir = join(ROOT, 'build')
mkdirSync(buildDir, { recursive: true })
const svgPath = join(buildDir, 'icon.svg')
writeFileSync(svgPath, svg)
// The window's copy (the rail's mark): cropped to the tile, without the drop shadow's margin.
writeFileSync(
  join(ROOT, 'src', 'renderer', 'src', 'assets', 'icon.svg'),
  svg.replace('width="1024" height="1024" viewBox="0 0 1024 1024"', 'width="824" height="824" viewBox="100 100 824 824"').replace(' filter="url(#shadow)"', '')
)

// Rasterize with Electron's Chromium: the SVG is drawn on a 1024-pixel canvas, alpha kept.
const size = Number(process.argv[2] ?? 1024)
const out = process.argv[3] ?? join(buildDir, 'icon.png')
const env = { ...process.env }
delete env['ELECTRON_RUN_AS_NODE']
const result = spawnSync(electron, [join(ROOT, 'scripts', 'rasterize.cjs'), svgPath, out, String(size)], { stdio: ['ignore', 'inherit', 'inherit'], env })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`${svgPath}\n${out} (${size} px)`)
