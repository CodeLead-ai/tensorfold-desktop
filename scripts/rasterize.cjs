// Electron main script: rasterize an SVG file to a PNG of the given size, transparency kept.
// Usage: electron scripts/rasterize.cjs <in.svg> <out.png> [size]
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')

const [input, output, sizeArg] = process.argv.slice(2)
const size = Number(sizeArg || 1024)

app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<!doctype html><canvas></canvas>')
  const svg = readFileSync(input, 'utf8')
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}
    await img.decode()
    const canvas = document.querySelector('canvas')
    canvas.width = ${size}
    canvas.height = ${size}
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, ${size}, ${size})
    return canvas.toDataURL('image/png')
  })()`)
  writeFileSync(output, Buffer.from(dataUrl.split(',')[1], 'base64'))
  app.exit(0)
})
