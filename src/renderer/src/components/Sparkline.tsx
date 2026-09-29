import { useEffect, useRef } from 'react'

/** A canvas sparkline (SPEC §4): the series left to right, a mean line, the last point marked. */
export function Sparkline({ values, height = 64 }: { values: number[]; height?: number }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const width = el.clientWidth
      el.width = Math.max(1, Math.round(width * dpr))
      el.height = Math.round(height * dpr)
      const ctx = el.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const style = getComputedStyle(document.documentElement)
      const accent = style.getPropertyValue('--accent').trim() || '#2f7cff'
      const accent2 = style.getPropertyValue('--accent-2').trim() || '#38c6ff'
      const faint = style.getPropertyValue('--line-2').trim() || '#26375a'
      if (values.length === 0) {
        ctx.strokeStyle = faint
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.moveTo(0, height / 2)
        ctx.lineTo(width, height / 2)
        ctx.stroke()
        return
      }
      const pad = 6
      const max = Math.max(...values)
      const min = Math.min(...values)
      const span = max - min || 1
      const x = (i: number): number => (values.length === 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - 2 * pad))
      const y = (v: number): number => height - pad - ((v - min) / span) * (height - 2 * pad)
      const mean = values.reduce((s, v) => s + v, 0) / values.length
      ctx.strokeStyle = faint
      ctx.setLineDash([3, 4])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y(mean))
      ctx.lineTo(width, y(mean))
      ctx.stroke()
      ctx.setLineDash([])

      const gradient = ctx.createLinearGradient(0, 0, width, 0)
      gradient.addColorStop(0, accent)
      gradient.addColorStop(1, accent2)
      const fill = ctx.createLinearGradient(0, 0, 0, height)
      fill.addColorStop(0, `${accent}40`)
      fill.addColorStop(1, `${accent}00`)
      ctx.beginPath()
      values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))))
      ctx.lineTo(x(values.length - 1), height)
      ctx.lineTo(x(0), height)
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
      ctx.beginPath()
      values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))))
      ctx.strokeStyle = gradient
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.stroke()
      const last = values[values.length - 1] as number
      ctx.fillStyle = accent2
      ctx.beginPath()
      ctx.arc(x(values.length - 1), y(last), 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(el)
    return () => observer.disconnect()
  }, [values, height])

  return <canvas ref={canvas} style={{ width: '100%', height, display: 'block' }} />
}
