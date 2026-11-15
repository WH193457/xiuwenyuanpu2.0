import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useLoaderData, useNavigate, useSearchParams } from 'react-router'
import type { Pattern, Sam3Candidate, Sam3Health, Sam3Response } from '../domain'
import { segmentationService } from '../services'
import { Icon } from './Icon'
import { Ornament, Stamp } from './shared'

const DEFAULT_BOX = [0.2, 0.18, 0.8, 0.82]
const SELECTION_KEY = 'xiuwen-sam3-selection-v1'

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value))
}

function statusCopy(health?: Sam3Health) {
  if (!health) return ['正在探测', 'checking']
  if (health.status === 'error' || health.model_state === 'error') return ['服务异常', 'error']
  if (health.model_state === 'ready') return ['模型就绪', 'ready']
  if (health.model_state === 'loading') return ['正在载入', 'loading']
  return ['服务在线 · 模型待命', 'cold']
}

export function DeconstructPage() {
  const patterns = useLoaderData() as Pattern[]
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const reduce = useReducedMotion()
  const initialId = params.get('pattern')?.toUpperCase() ?? 'DX005'
  const [patternId, setPatternId] = useState(patterns.some((pattern) => pattern.id === initialId) ? initialId : patterns[0].id)
  const pattern = patterns.find((item) => item.id === patternId)!
  const [box, setBox] = useState<number[]>(DEFAULT_BOX)
  const [dragStart, setDragStart] = useState<[number, number]>()
  const [health, setHealth] = useState<Sam3Health>()
  const [healthError, setHealthError] = useState('')
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<'single' | 'motif'>('single')
  const [result, setResult] = useState<Sam3Response>()
  const [selectedRank, setSelectedRank] = useState(1)
  const [error, setError] = useState('')
  const frameRef = useRef<HTMLDivElement>(null)
  const selected = result?.candidates.find((candidate) => candidate.rank === selectedRank)
  const [healthLabel, healthClass] = statusCopy(health)

  const checkHealth = async () => {
    try {
      setHealth(await segmentationService.health())
      setHealthError('')
    } catch (nextError) {
      setHealth(undefined)
      setHealthError(nextError instanceof Error ? nextError.message : '本地服务不可用。')
    }
  }

  useEffect(() => { void checkHealth() }, [])

  const pointFromEvent = (event: PointerEvent<HTMLDivElement>) => {
    const rect = frameRef.current!.getBoundingClientRect()
    return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)] as [number, number]
  }

  const beginBox = (event: PointerEvent<HTMLDivElement>) => {
    if (running) return
    const point = pointFromEvent(event)
    setDragStart(point)
    setBox([point[0], point[1], point[0], point[1]])
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveBox = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart || running) return
    const point = pointFromEvent(event)
    setBox([Math.min(dragStart[0], point[0]), Math.min(dragStart[1], point[1]), Math.max(dragStart[0], point[0]), Math.max(dragStart[1], point[1])])
  }

  const finishBox = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    let next = [Math.min(dragStart[0], point[0]), Math.min(dragStart[1], point[1]), Math.max(dragStart[0], point[0]), Math.max(dragStart[1], point[1])]
    const width = next[2] - next[0]
    const height = next[3] - next[1]
    if (width < 0.05 || height < 0.05) {
      next = [clamp(dragStart[0] - 0.14), clamp(dragStart[1] - 0.14), clamp(dragStart[0] + 0.14), clamp(dragStart[1] + 0.14)]
    }
    setBox(next)
    setDragStart(undefined)
    setResult(undefined)
  }

  const moveBoxWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const amount = direction * 0.015
    setBox((current) => {
      const [x0, y0, x1, y1] = current
      if (event.shiftKey) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return [x0, y0, clamp(x1 + amount, x0 + 0.05), y1]
        return [x0, y0, x1, clamp(y1 + amount, y0 + 0.05)]
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const safe = Math.max(-x0, Math.min(1 - x1, amount))
        return [x0 + safe, y0, x1 + safe, y1]
      }
      const safe = Math.max(-y0, Math.min(1 - y1, amount))
      return [x0, y0 + safe, x1, y1 + safe]
    })
    setResult(undefined)
  }

  const runSegmentation = async () => {
    setRunning(true)
    setError('')
    setResult(undefined)
    try {
      const next = await segmentationService.segment(patternId, box, mode)
      setResult(next)
      setSelectedRank(next.candidates[0]?.rank ?? 1)
      await checkHealth()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '拆解失败，请调整框选范围后重试。')
    } finally {
      setRunning(false)
    }
  }

  const changePattern = (nextId: string) => {
    setPatternId(nextId)
    setBox(DEFAULT_BOX)
    setResult(undefined)
    setError('')
  }

  const downloadCandidate = (candidate: Sam3Candidate) => {
    const link = document.createElement('a')
    link.href = candidate.cutout_data_url
    link.download = candidate.filename
    link.click()
  }

  const takeToCreate = () => {
    if (!selected) return
    try {
      sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ patternId, patternName: pattern.name, candidate: selected, createdAt: new Date().toISOString() }))
      navigate(`/create?patterns=${patternId}&sam3=1`)
    } catch {
      setError('浏览器临时存储空间不足，请先下载透明 PNG，再刷新页面重试。')
    }
  }

  return <div className="page-wrap deconstruct-page">
    <header className="page-title-block split-title deconstruct-title">
      <div><p className="eyebrow">SAM3 · PATTERN DECONSTRUCTION</p><h1>析纹台</h1></div>
      <div className="deconstruct-intro"><p>用一只框指定意图，让本机 SAM3 从母纹中抬起独立纹样元。图像只在电脑内处理，不上传、不改写原始资料。</p><span className={`service-state ${healthClass}`}><i />{healthError ? '服务未连接' : healthLabel}</span></div>
    </header>

    <section className="analysis-bench">
      <aside className="analysis-rail">
        <div className="rail-step active"><span>01</span><div><b>选母纹</b><small>指定拆解来源</small></div></div>
        <div className={`rail-step ${running || result ? 'active' : ''}`}><span>02</span><div><b>框取意图</b><small>拖动绣框定位</small></div></div>
        <div className={`rail-step ${result ? 'active' : ''}`}><span>03</span><div><b>复核入库</b><small>确认候选纹样元</small></div></div>
      </aside>

      <div className="analysis-stage">
        <div className="analysis-toolbar">
          <label>母纹编号<select value={patternId} onChange={(event) => changePattern(event.target.value)}>{patterns.map((item) => <option value={item.id} key={item.id}>{item.id} · {item.name.replace(/（暂定）/g, '')}</option>)}</select></label>
          <div><span>{pattern.category}</span><b>{pattern.name}</b></div>
          <button type="button" onClick={() => { setBox(DEFAULT_BOX); setResult(undefined) }}>重置绣框</button>
        </div>

        <div className={`embroidery-frame ${running ? 'is-running' : ''}`} ref={frameRef} tabIndex={0} role="application" aria-label="纹样框选区。拖动鼠标框选；方向键移动选框，按住 Shift 加方向键改变选框大小。" onPointerDown={beginBox} onPointerMove={moveBox} onPointerUp={finishBox} onKeyDown={moveBoxWithKeyboard}>
          <img src={pattern.image} alt={`${pattern.name}原始母纹`} draggable={false} />
          <div className="selection-veil" style={{ '--x0': `${box[0] * 100}%`, '--y0': `${box[1] * 100}%`, '--x1': `${box[2] * 100}%`, '--y1': `${box[3] * 100}%` } as React.CSSProperties}>
            <span className="selection-corner c1"/><span className="selection-corner c2"/><span className="selection-corner c3"/><span className="selection-corner c4"/>
            <small>POSITIVE BOX · {Math.round((box[2] - box[0]) * 100)} × {Math.round((box[3] - box[1]) * 100)}</small>
          </div>
          {running && <div className="sam3-scanner" aria-live="polite"><i/><strong>{health?.model_state === 'ready' ? 'SAM3 正在辨认纹样边界' : '首次运行，正在载入本地模型'}</strong><span>{health?.model_state === 'ready' ? '通常需要数秒' : '权重约 3.2 GB，仅本次会话加载一次'}</span></div>}
        </div>
        <p className="frame-guidance"><span>拖动框取</span><span>方向键移动 · Shift + 方向键缩放</span><span>黄线为意图框 · 青线为模型边界</span></p>
      </div>

      <aside className="analysis-action">
        <span className="action-index">SAM<br/><b>3</b></span>
        <p className="eyebrow">LOCAL INFERENCE</p>
        <h2>把一块纹样<br/>从底布上抬起来</h2>
        <p>{healthError || '框边缘会用于判断底布颜色；尽量让选框留出少量背景。系统会同时比较模型边界与颜色前景，避免把底布排在第一位。'}</p>
        <fieldset className="strategy-switch"><legend>拆解目标</legend><div><button type="button" className={mode==='single'?'active':''} onClick={()=>setMode('single')}>单个纹样元</button><button type="button" className={mode==='motif'?'active':''} onClick={()=>setMode('motif')}>完整连续图案</button></div></fieldset>
        {error && <div className="analysis-error" role="alert"><b>未完成拆解</b>{error}</div>}
        <button className="button primary analysis-run" disabled={running || !!healthError} onClick={runSegmentation}>{running ? '正在拆解…' : '开始智能拆解'}<Icon name="spark" size={18}/></button>
        {healthError && <button className="text-retry" onClick={checkHealth}>重新检测本地服务</button>}
        <dl><div><dt>处理位置</dt><dd>仅本机 GPU</dd></div><div><dt>原图状态</dt><dd>只读保护</dd></div><div><dt>输出</dt><dd>透明 PNG</dd></div></dl>
      </aside>
    </section>

    <AnimatePresence>{result && <motion.section className="candidate-section" initial={{ opacity: 0, y: reduce ? 0 : 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <Ornament label="候选纹样元"/>
      <div className="candidate-heading"><div><p className="eyebrow">HUMAN-IN-THE-LOOP REVIEW</p><h2>模型给出边界，人来做最后判断</h2><p>已综合模型置信、底布相似度、前景色差与框选贴合度排序。青色覆盖范围就是将被保留的区域。</p></div><div><b>{result.inference_seconds.toFixed(1)}s</b><span>本次推理</span></div></div>
      <div className="candidate-grid">{result.candidates.map((candidate) => <button type="button" className={`candidate-card ${selectedRank === candidate.rank ? 'selected' : ''}`} key={candidate.rank} onClick={() => setSelectedRank(candidate.rank)} aria-pressed={selectedRank === candidate.rank}>
        <div className="candidate-preview"><img src={candidate.preview_data_url} alt={`SAM3 候选 ${candidate.rank} 蒙版预览`}/><span>0{candidate.rank}</span>{candidate.status === 'review' && <i>建议复核</i>}</div>
        <div className="candidate-copy"><div><b>{candidate.rank === 1 ? '推荐边界' : `备选边界 ${candidate.rank}`}</b><small>{candidate.source==='hybrid'?'模型＋前景融合':candidate.source==='foreground'?'颜色前景修正':'SAM3 原始边界'} · 质量 {Math.round(candidate.fit * 100)}%</small></div><span className="candidate-radio"><i/></span></div>
      </button>)}</div>

      {selected && <div className="accepted-candidate">
        <div className="cutout-stage"><div className="cutout-grid"/><motion.img key={selected.rank} initial={{ opacity: 0, scale: reduce ? 1 : .94 }} animate={{ opacity: 1, scale: 1 }} src={selected.cutout_data_url} alt={`候选 ${selected.rank} 透明纹样元`}/><span>透明底预览</span></div>
        <div className="cutout-copy"><Stamp>{selected.status === 'pass' ? '取' : '核'}</Stamp><p className="eyebrow">SELECTED ELEMENT · CANDIDATE {selected.rank}</p><h3>确认这枚纹样元</h3><p>确认后它会作为本次会话的临时纹样元进入“创生工坊”，原始纹样库不会被覆盖。也可以先下载透明 PNG 留存。</p><dl><div><dt>候选质量</dt><dd>{Math.round(selected.fit * 100)}%</dd></div><div><dt>纹样吻合</dt><dd>{Math.round(selected.metrics.foreground_agreement * 100)}%</dd></div><div><dt>背景泄漏</dt><dd>{Math.round(selected.metrics.background_leakage * 100)}%</dd></div></dl><div className="cutout-actions"><button className="button secondary" onClick={() => downloadCandidate(selected)}>下载透明 PNG</button><button className="button primary" onClick={takeToCreate}>带入创生工坊<Icon name="arrow" size={18}/></button></div></div>
      </div>}
    </motion.section>}</AnimatePresence>
  </div>
}
