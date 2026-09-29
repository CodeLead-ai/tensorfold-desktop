// Draws build/icon.png (1024×1024): the app's layers glyph in white on the accent gradient. No dependencies.
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const S = 1024
const px = new Uint8ClampedArray(S * S * 4)

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const [a0, a1] = [hex('#2F7CFF'), hex('#38C6FF')]

// macOS icon grid: an 824-pixel rounded square centred in 1024.
const inset = 100
const radius = 185
function squareCoverage(x, y) {
  const cx = Math.min(Math.max(x, inset + radius), S - inset - radius)
  const cy = Math.min(Math.max(y, inset + radius), S - inset - radius)
  const d = Math.hypot(x - cx, y - cy) - radius
  return Math.min(1, Math.max(0, 0.5 - d))
}

// The glyph, in the 24-unit space of the app's SVG icon.
const polylines = [
  [[4, 7.5], [12, 4], [20, 7.5], [12, 11], [4, 7.5]],
  [[4, 12], [12, 15.5], [20, 12]],
  [[4, 16.5], [12, 20], [20, 16.5]]
]
const unit = 25
const map = ([u, v]) => [S / 2 + (u - 12) * unit, S / 2 + (v - 12) * unit]
const segments = polylines.flatMap((line) => line.slice(1).map((p, i) => [map(line[i]), map(p)]))
const half = (1.8 * unit) / 2

function distToSegment(x, y, [[x1, y1], [x2, y2]]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const cover = squareCoverage(x + 0.5, y + 0.5)
    if (cover === 0) continue
    const t = (x + y) / (2 * S)
    let color = a0.map((c, k) => c + (a1[k] - c) * t)
    // a soft light from the top
    const light = Math.max(0, 1 - y / S) * 18
    color = color.map((c) => c + light)
    let d = Infinity
    for (const seg of segments) d = Math.min(d, distToSegment(x + 0.5, y + 0.5, seg))
    const glyph = Math.min(1, Math.max(0, half + 0.5 - d))
    color = color.map((c) => c + (255 - c) * glyph)
    px[i] = color[0]
    px[i + 1] = color[1]
    px[i + 2] = color[2]
    px[i + 3] = Math.round(cover * 255)
  }
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 8 + data.length)
  return out
}
const header = Buffer.alloc(13)
header.writeUInt32BE(S, 0)
header.writeUInt32BE(S, 4)
header[8] = 8 // bit depth
header[9] = 6 // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
writeFileSync(new URL('../build/icon.png', import.meta.url), png)
console.log(`build/icon.png: ${png.length} bytes`)
