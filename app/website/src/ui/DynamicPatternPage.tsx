import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useSearchParams } from 'react-router'
import type { Pattern } from '../domain'
import { Icon } from './Icon'
import { Ornament, Stamp } from './shared'
import './dynamic.css'

type MotifPoint = {
  u: number
  v: number
  x: number
  y: number
  phase: number
  color: string
  weight: number
  rank: number
}

type AnimationSettings = { density: number; flow: number; glow: number; base: number }
const DEFAULTS: AnimationSettings = { density: 1, flow: 0.7, glow: 0.45, base: 0.7 }
const SAMPLE = 110
const FRAME_INTERVAL = 1000 / 30
const TOE_HREF = '/%E7%BA%B9%E6%A0%B7%E5%9B%BE%E7%89%87.8.toe'

export function DynamicPatternPage() {
  const patterns = useLoaderData() as Pattern[]
  const [params, setParams] = useSearchParams()
  const requestedId = params.get('pattern') ?? 'DX008'
  const pattern = useMemo(() => patterns.find(item => item.id === requestedId) ?? patterns[0], [patterns, requestedId])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [settings, setSettings] = useState(DEFAULTS)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pointCount, setPointCount] = useState(0)
  const [retry, setRetry] = useState(0)
  const settingsRef = useRef(settings)
  const pausedRef = useRef(paused)
  const updateRef = useRef<(() => void) | undefined>(undefined)
  const playbackRef = useRef<(() => void) | undefined>(undefined)
  const resetRef = useRef<(() => void) | undefined>(undefined)
  settingsRef.current = settings
  pausedRef.current = paused

  useEffect(() => {
    if (!pattern || params.get('pattern') === pattern.id) return
    const next = new URLSearchParams(params)
    next.set('pattern', pattern.id)
    setParams(next, { replace: true })
  }, [pattern, params, setParams])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !pattern) return
    setStatus('loading')
    setError('')
    setNotice('')
    setPointCount(0)
    const context = canvas.getContext('2d', { alpha: false })
    const trail = document.createElement('canvas')
    const trailContext = trail.getContext('2d')
    if (!context || !trailContext) {
      setStatus('error')
      setError('当前浏览器无法建立画布，请使用支持Canvas的浏览器。')
      return
    }

    let disposed = false
    let frame = 0
    let lastFrame = 0
    let simulationTime = 0
    let loaded = false
    let inView = true
    let samples: MotifPoint[] = []
    let points: MotifPoint[] = []
    let previousDensity = settingsRef.current.density
    const pointer = { x: 0, y: 0, active: false }
    const layout = { x: 0, y: 0, width: 0, height: 0 }
    const source = new Image()
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)

    const draw = () => {
      context.fillStyle = '#141c1a'
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (!loaded) return
      context.save()
      context.globalAlpha = samples.length ? settingsRef.current.base : 1
      context.drawImage(source, layout.x, layout.y, layout.width, layout.height)
      context.restore()
      context.save()
      context.globalAlpha = 0.65 + settingsRef.current.glow * 0.35
      context.drawImage(trail, 0, 0)
      context.restore()
    }

    const renderStitches = (advance: boolean) => {
      const { flow, glow } = settingsRef.current
      if (advance) {
        trailContext.save()
        trailContext.globalCompositeOperation = 'destination-out'
        trailContext.fillStyle = `rgba(0,0,0,${0.4 - glow * 0.3})`
        trailContext.fillRect(0, 0, trail.width, trail.height)
        trailContext.restore()
      } else trailContext.clearRect(0, 0, trail.width, trail.height)
      trailContext.lineCap = 'round'
      const amplitude = Math.min(layout.width, layout.height) * 0.014 * flow
      for (const point of points) {
        const homeX = layout.x + point.u * layout.width
        const homeY = layout.y + point.v * layout.height
        const wave = Math.sin(point.u * 12 + simulationTime * 1.25 + point.phase)
        const crossWave = Math.cos(point.v * 11 - simulationTime + point.phase)
        let x = homeX + wave * amplitude
        let y = homeY + crossWave * amplitude
        if (pointer.active) {
          const dx = homeX - pointer.x
          const dy = homeY - pointer.y
          const distance = Math.max(1, Math.hypot(dx, dy))
          const radius = Math.min(layout.width, layout.height) * 0.2
          const influence = Math.max(0, 1 - distance / radius) * radius * 0.22
          x += dx / distance * influence
          y += dy / distance * influence
        }
        const previousX = advance ? point.x : x
        const previousY = advance ? point.y : y
        point.x = x
        point.y = y
        trailContext.strokeStyle = point.color
        trailContext.lineWidth = point.weight * pixelRatio
        trailContext.beginPath()
        trailContext.moveTo(previousX - pixelRatio * 0.65, previousY - pixelRatio * 0.65)
        trailContext.lineTo(x + pixelRatio * 0.65, y + pixelRatio * 0.65)
        trailContext.stroke()
      }
      draw()
    }

    const selectPoints = () => {
      previousDensity = settingsRef.current.density
      // Stable spatial sampling preserves the whole motif at every density.
      const fraction = Math.min(1, previousDensity / 1.8)
      points = samples.filter(point => point.rank < fraction)
      setPointCount(points.length)
      renderStitches(false)
    }

    const resize = () => {
      const rectangle = canvas.getBoundingClientRect()
      const width = Math.max(1, Math.round(rectangle.width * pixelRatio))
      const height = Math.max(1, Math.round(rectangle.height * pixelRatio))
      if (canvas.width === width && canvas.height === height && layout.width) return
      canvas.width = trail.width = width
      canvas.height = trail.height = height
      if (loaded) {
        const scale = Math.min(width * 0.88 / source.naturalWidth, height * 0.86 / source.naturalHeight)
        layout.width = source.naturalWidth * scale
        layout.height = source.naturalHeight * scale
        layout.x = (width - layout.width) / 2
        layout.y = (height - layout.height) / 2
      }
      renderStitches(false)
    }

    const tick = (time: number) => {
      frame = 0
      if (disposed || !loaded || pausedRef.current || document.hidden || !inView) return
      if (!lastFrame) lastFrame = time
      const elapsed = time - lastFrame
      if (elapsed >= FRAME_INTERVAL) {
        simulationTime += Math.min(elapsed / 1000, 0.08)
        lastFrame = time
        renderStitches(true)
      }
      frame = requestAnimationFrame(tick)
    }

    const synchronizePlayback = () => {
      cancelAnimationFrame(frame)
      frame = 0
      lastFrame = 0
      if (!disposed && loaded && !pausedRef.current && !document.hidden && inView) frame = requestAnimationFrame(tick)
    }
    playbackRef.current = synchronizePlayback
    updateRef.current = () => {
      if (previousDensity !== settingsRef.current.density) selectPoints()
      else if (loaded) renderStitches(false)
    }
    resetRef.current = () => {
      simulationTime = 0
      pointer.active = false
      selectPoints()
    }

    const onMove = (event: PointerEvent) => {
      if (pausedRef.current) return
      const rectangle = canvas.getBoundingClientRect()
      pointer.x = (event.clientX - rectangle.left) / Math.max(1, rectangle.width) * canvas.width
      pointer.y = (event.clientY - rectangle.top) / Math.max(1, rectangle.height) * canvas.height
      pointer.active = true
    }
    const onLeave = () => { pointer.active = false }
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('pointerup', onLeave)
    canvas.addEventListener('pointercancel', onLeave)
    document.addEventListener('visibilitychange', synchronizePlayback)
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      synchronizePlayback()
    })
    intersectionObserver.observe(canvas)
    resize()

    source.onload = () => {
      if (disposed) return
      loaded = true
      const samplingCanvas = document.createElement('canvas')
      const scale = SAMPLE / Math.max(source.naturalWidth, source.naturalHeight)
      samplingCanvas.width = Math.max(1, Math.round(source.naturalWidth * scale))
      samplingCanvas.height = Math.max(1, Math.round(source.naturalHeight * scale))
      const samplingContext = samplingCanvas.getContext('2d', { willReadFrequently: true })
      try {
        if (!samplingContext) throw new Error('无法采样')
        samplingContext.drawImage(source, 0, 0, samplingCanvas.width, samplingCanvas.height)
        const pixels = samplingContext.getImageData(0, 0, samplingCanvas.width, samplingCanvas.height).data
        for (let y = 0; y < samplingCanvas.height; y += 1) {
          for (let x = 0; x < samplingCanvas.width; x += 1) {
            const index = (y * samplingCanvas.width + x) * 4
            const red = pixels[index]
            const green = pixels[index + 1]
            const blue = pixels[index + 2]
            const alpha = pixels[index + 3]
            const maximum = Math.max(red, green, blue)
            const saturation = maximum ? (maximum - Math.min(red, green, blue)) / maximum : 0
            const luminance = (red * 0.299 + green * 0.587 + blue * 0.114) / 255
            if (alpha < 64 || (luminance > 0.8 && saturation < 0.15)) continue
            const rank = ((x * 73 + y * 151 + x * y * 19) % 997) / 997
            samples.push({
              u: (x + 0.5) / samplingCanvas.width, v: (y + 0.5) / samplingCanvas.height,
              x: 0, y: 0, phase: rank * Math.PI * 2,
              color: `rgba(${red},${green},${blue},${alpha / 255})`,
              weight: 0.8 + saturation * 0.8, rank,
            })
          }
        }
      } catch {
        samples = []
        setNotice('当前环境无法读取纹样像素，已显示原纹预览。')
      }
      resize()
      selectPoints()
      setStatus('ready')
      synchronizePlayback()
    }
    source.onerror = () => {
      if (disposed) return
      setStatus('error')
      setError('纹样图片加载失败，请重新加载或选择另一件纹样。')
    }
    source.src = pattern.image

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener('visibilitychange', synchronizePlayback)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerup', onLeave)
      canvas.removeEventListener('pointercancel', onLeave)
      source.onload = null
      source.onerror = null
      updateRef.current = undefined
      playbackRef.current = undefined
      resetRef.current = undefined
    }
  }, [pattern, retry])

  useEffect(() => { updateRef.current?.() }, [settings])
  useEffect(() => { playbackRef.current?.() }, [paused])

  const updateSetting = (key: keyof AnimationSettings, value: string) => {
    setSettings(current => ({ ...current, [key]: Number(value) }))
  }

  const exportFrame = () => {
    const canvas = canvasRef.current
    if (!canvas || status !== 'ready') return
    try {
      canvas.toBlob(blob => {
        if (!blob) { setNotice('当前画面导出失败，请重试。'); return }
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `${pattern.id}-流动纹谱.png`
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        setNotice('当前画面已导出为PNG。')
      }, 'image/png')
    } catch { setNotice('当前图片无法导出，请重新加载纹样后重试。') }
  }

  if (!pattern) return null

  return <div className="page-wrap dynamic-page">
    <header className="page-title-block split-title">
      <div><p className="eyebrow">DYNAMIC PATTERN</p><h1>流动纹谱</h1></div>
      <p>让纹样的色点随节律流动，拖动滑杆调整密度、幅度与拖尾。划过画面可拨动针脚，暂停后可保存当前画面。</p>
    </header>
    <div className="dynamic-shell">
      <aside className="dynamic-panel">
        <div className="panel-title"><span>动</span><div><p>母纹选择</p><h2>{pattern.id}</h2></div></div>
        <label className="select-label">纹样
          <select aria-label="流动纹谱纹样" value={pattern.id} onChange={event => {
            const next = new URLSearchParams(params)
            next.set('pattern', event.target.value)
            setParams(next)
          }}>
            {patterns.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}
          </select>
        </label>
        <div className="dynamic-preview"><img src={pattern.image} alt={`${pattern.name}原纹参考`} /><Stamp subtle>源</Stamp></div>
        <label className="density-label">针脚密度 <b>{settings.density.toFixed(2)}×</b>
          <input aria-label="针脚密度" type="range" min={0.25} max={1.8} step={0.05} value={settings.density} onChange={event => updateSetting('density', event.target.value)} />
        </label>
        <label className="density-label">起伏幅度 <b>{settings.flow.toFixed(1)}</b>
          <input aria-label="起伏幅度" type="range" min={0} max={2} step={0.1} value={settings.flow} onChange={event => updateSetting('flow', event.target.value)} />
        </label>
        <label className="density-label">流光拖尾 <b>{settings.glow.toFixed(2)}</b>
          <input aria-label="流光拖尾" type="range" min={0} max={0.95} step={0.05} value={settings.glow} onChange={event => updateSetting('glow', event.target.value)} />
        </label>
        <label className="density-label">原纹叠加 <b>{settings.base.toFixed(2)}</b>
          <input aria-label="原纹叠加" type="range" min={0} max={1} step={0.05} value={settings.base} onChange={event => updateSetting('base', event.target.value)} />
        </label>
        <div className="dynamic-actions">
          <button className="button secondary" type="button" disabled={status !== 'ready'} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? '继续流动' : '暂停流动'}</button>
          <button className="button secondary" type="button" onClick={() => { setSettings({ ...DEFAULTS }); resetRef.current?.() }}>重置参数</button>
          <button className="button secondary" type="button" disabled={status !== 'ready'} onClick={exportFrame}>保存当前画面</button>
          <Link className="button primary" to={`/workshop?pattern=${pattern.id}&source=library`}>母纹带入文创贴图 <Icon name="arrow" size={18} /></Link>
        </div>
        {notice && <p className="dynamic-notice" role="status">{notice}</p>}
        <details className="dynamic-project"><summary>TouchDesigner工程</summary>
          <p>网页使用Canvas呈现针脚流动。原始动态工程可下载后在TouchDesigner中打开。</p>
          <a href={TOE_HREF} download="纹样图片.8.toe">下载纹样图片.8.toe</a>
        </details>
      </aside>
      <div className="dynamic-stage is-toe">
        <Ornament label="活态纹" />
        <canvas ref={canvasRef} className="dynamic-canvas" role="img" aria-label={`${pattern.name}动态纹样`} />
        <div className="dynamic-playback-status" role="status">{status === 'loading' ? '正在加载纹样…' : status === 'error' ? '纹样加载失败' : `${paused ? '已暂停' : '正在流动'} · ${pointCount.toLocaleString('zh-CN')}个针脚`}</div>
        {status === 'error' && <div className="dynamic-error" role="alert"><p>{error}</p><button className="button secondary" type="button" onClick={() => setRetry(value => value + 1)}>重新加载纹样</button></div>}
        <div className="dynamic-caption"><span>{pattern.category}</span><strong>{pattern.name}</strong></div>
      </div>
    </div>
  </div>
}
