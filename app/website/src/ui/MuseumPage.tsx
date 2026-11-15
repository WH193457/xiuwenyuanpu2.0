import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useSearchParams } from 'react-router'
import type { MarbleWorld, Pattern } from '../domain'
import { marbleService } from '../marble'
import { appearanceSearchParams, readWorkshopSession, resolveWorkshopSelection } from '../workshopSession'
import { PRODUCT_CATALOG } from '../productCatalog'
import { mountMuseumScene, type MuseumRuntime, type MuseumView } from '../museumScene'
import './museum.css'

const views: { id: MuseumView; label: string }[] = [
  { id: 'overview', label: '展厅全景' }, ...PRODUCT_CATALOG,
]
const collections = [...new Set(PRODUCT_CATALOG.map(item => item.category))]
const collectionViews: { id: MuseumView; label: string }[] = collections.map(category => ({ id: `collection:${category}`, label: category + '展区' }))
const sourceNames = { library: '母纹原图', create: '创生工坊已选候选', sam3: 'SAM3提取纹样元' }

export function MuseumPage() {
  const patterns = useLoaderData() as Pattern[]
  const [params, setParams] = useSearchParams()
  const [session] = useState(readWorkshopSession)
  const selection = useMemo(() => resolveWorkshopSelection(patterns, params, session), [patterns, params, session])
  const { pattern, carrier, textureUrl, source, appearance } = selection
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<MuseumRuntime | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [sceneError, setSceneError] = useState('')
  const [retry, setRetry] = useState(0)
  const [view, setView] = useState<MuseumView>('overview')
  const [rotating, setRotating] = useState(false)
  const [notice, setNotice] = useState('')
  const [world, setWorld] = useState<{ patternId: string; value: MarbleWorld }>()
  const [busy, setBusy] = useState(false)
  const [marbleError, setMarbleError] = useState('')
  const active = useRef(true)
  const live = marbleService.isLive()

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  useEffect(() => {
    if (!pattern || (params.get('pattern') === pattern.id && params.get('carrier') === carrier)) return
    const next = new URLSearchParams(params)
    const requestedPattern = params.get('pattern')
    if (params.has('pattern') && !patterns.some(item => item.id === requestedPattern)) next.set('source', 'library')
    next.set('pattern', pattern.id)
    next.set('carrier', carrier)
    setParams(next, { replace: true })
  }, [pattern, patterns, carrier, params, setParams])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !pattern || !textureUrl) return
    let runtime: MuseumRuntime | undefined
    let cancelled = false
    setReady(false)
    setSceneError('')
    setView('overview')
    setRotating(false)
    setNotice('')
    const fail = (reason: unknown) => {
      if (cancelled) return
      setReady(false)
      setRotating(false)
      setSceneError(reason instanceof Error ? reason.message : String(reason))
      runtime?.dispose()
      runtimeRef.current = undefined
    }
    try {
      runtime = mountMuseumScene(host, { pattern, textureUrl, featuredCarrier: carrier, appearance }, fail, () => {
        if (!cancelled) setRotating(false)
      })
      runtimeRef.current = runtime
      void runtime.ready.then(() => { if (!cancelled) setReady(true) }).catch(fail)
    } catch {
      fail('当前浏览器无法启动三维显示。可检查硬件加速设置后重新加载展厅。')
    }
    return () => {
      cancelled = true
      runtime?.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = undefined
    }
  }, [pattern, textureUrl, carrier, appearance, retry])

  const choosePattern = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('pattern', id)
    next.set('carrier', carrier)
    next.set('source', 'library')
    setParams(next)
    setMarbleError('')
  }
  const chooseSource = (value: 'library' | 'session') => {
    const next = new URLSearchParams(params)
    next.set('source', value)
    setParams(next)
  }
  const chooseView = (next: MuseumView) => {
    runtimeRef.current?.setRotating(false)
    runtimeRef.current?.setView(next)
    setRotating(false)
    setView(next)
  }
  const toggleRotation = () => {
    const next = !rotating
    runtimeRef.current?.setRotating(next)
    setRotating(next)
  }
  const stepView = (step: number) => {
    const currentIndex = PRODUCT_CATALOG.findIndex(item => item.id === view)
    const origin = currentIndex === -1 && step < 0 ? 0 : currentIndex
    const nextIndex = (origin + step + PRODUCT_CATALOG.length) % PRODUCT_CATALOG.length
    chooseView(PRODUCT_CATALOG[nextIndex].id)
  }
  const capture = () => {
    try {
      const image = runtimeRef.current?.capture()
      if (!image) return
      const link = document.createElement('a')
      link.download = `${pattern?.id}-博物馆-${view}.png`
      link.href = image
      link.click()
      setNotice('已导出当前展厅视角。')
    } catch { setNotice('截图导出失败，请重新加载展厅后重试。') }
  }
  const generateMarble = async () => {
    if (!pattern || busy || !live) return
    setBusy(true)
    setMarbleError('')
    try {
      const next = await marbleService.generateMuseum({
        displayName: `侗纹博物馆 · ${pattern.id}`,
        textPrompt: `A serene museum gallery for Dong embroidery patterns, linen walls, warm lighting, ${PRODUCT_CATALOG.length} cultural products decorated with motif ${pattern.id}, contemplative atmosphere`,
      })
      if (active.current) setWorld({ patternId: pattern.id, value: next })
    } catch (error) {
      if (active.current) setMarbleError(error instanceof Error ? error.message : '云端展厅生成失败。')
    } finally { if (active.current) setBusy(false) }
  }

  if (!pattern || !textureUrl) return <div className="page-wrap museum-page"><h1>3D文创博物馆</h1><p role="alert">当前资料库没有可展示的纹样。</p></div>
  const legacyTexture = source === 'library' && textureUrl !== pattern.image
  const sourceLabel = legacyTexture ? '已保存纹理（旧记录）' : sourceNames[source]
  const hasSavedTexture = selection.session && selection.session.textureUrl !== pattern.image
  const returnParams = new URLSearchParams({ pattern: pattern.id, carrier, source: source === 'library' && !legacyTexture ? 'library' : 'session' })
  appearanceSearchParams(appearance).forEach((value, key) => returnParams.set(key, value))
  const shownWorld = world?.patternId === pattern.id ? world.value : undefined
  const currentProduct = PRODUCT_CATALOG.find(item => item.id === view)
  const currentCollection = view.startsWith('collection:') ? view.slice('collection:'.length) : undefined
  const viewLabel = [...views, ...collectionViews].find(item => item.id === view)?.label
  const stageTitle = currentProduct?.label ?? (currentCollection ? currentCollection + '展区' : '纹样 · 日常')
  const stageDescription = currentProduct?.material ?? (currentCollection
    ? PRODUCT_CATALOG.filter(item => item.category === currentCollection).length + ' 件文创 · 分区近看'
    : PRODUCT_CATALOG.length + ' 件文创 · 同一纹样的不同表达')

  return <div className="page-wrap museum-page">
    <header className="page-title-block split-title">
      <div><p className="eyebrow">CULTURAL PRODUCT GALLERY</p><h1>3D文创博物馆</h1></div>
      <p>从织物到器物，让侗绣纹样走进日常。中央展台呈现当前设计，{PRODUCT_CATALOG.length} 件文创分区陈列，可逐件近看材质与印花。</p>
    </header>
    <div className="museum-shell museum-shell-live">
      <aside className="museum-panel">
        <label className="select-label">展陈母纹<select aria-label="展陈母纹" value={pattern.id} onChange={event => choosePattern(event.target.value)}>
          {patterns.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}
        </select></label>
        <div className="museum-source-preview"><img src={textureUrl} alt="当前文创贴图" /><div><strong>{pattern.id}</strong><p>{sourceLabel}</p></div></div>
        {hasSavedTexture && <fieldset className="museum-source-options"><legend>贴图来源</legend>
          <button type="button" aria-pressed={textureUrl !== pattern.image} onClick={() => chooseSource('session')}>使用会话纹样</button>
          <button type="button" aria-pressed={textureUrl === pattern.image} onClick={() => chooseSource('library')}>使用母纹原图</button>
        </fieldset>}
        <dl className="museum-meta">
          <div><dt>展厅状态</dt><dd role="status">{sceneError ? '加载失败' : ready ? '已就绪' : '正在加载纹样…'}</dd></div>
          <div><dt>当前文创</dt><dd>{views.find(item => item.id === carrier)?.label}</dd></div>
          <div><dt>母纹名称</dt><dd>{pattern.name}</dd></div>
        </dl>
        <div className="museum-exhibit-list" aria-label="选择展厅视角">
          <button type="button" className="museum-overview-button" aria-pressed={view === 'overview'} disabled={!ready} onClick={() => chooseView('overview')}>展厅全景</button>
          {collections.map(category => <div className="museum-collection" key={category}><h2><button type="button" className="museum-collection-heading" aria-pressed={currentCollection === category} disabled={!ready} onClick={() => chooseView(`collection:${category}`)}>{category}展区</button></h2><div>
            {PRODUCT_CATALOG.filter(item => item.category === category).map(item => <button type="button" key={item.id} title={item.material} aria-pressed={view === item.id} disabled={!ready} onClick={() => chooseView(item.id)}>{item.label}{item.id === carrier && <span aria-hidden="true">·</span>}</button>)}
          </div></div>)}
        </div>
        <div className="museum-controls">
          <button className="button secondary" type="button" disabled={!ready} aria-pressed={rotating} onClick={toggleRotation}>{rotating ? '暂停展品旋转' : '自动旋转展品'}</button>
          <button className="button secondary" type="button" disabled={!ready} onClick={capture}>导出展厅截图</button>
          <Link className="button primary" to={`/workshop?${returnParams}`}>继续调整文创贴图</Link>
          <Link className="museum-detail-link" to={`/patterns/${pattern.id}`}>查看母纹资料</Link>
        </div>
        <p className="museum-hint">中央展品沿用贴图台的排版与材质设置，环绕展品采用各自的默认排版。</p>
        {notice && <p className="museum-notice" role="status">{notice}</p>}
        {live && <details className="museum-cloud"><summary>生成云端展厅</summary>
          <p>通过已配置的Marble服务生成额外的云端空间。</p>
          <button className="button secondary" type="button" disabled={busy} onClick={generateMarble}>{busy ? '云端生成中…' : '调用Marble生成展厅'}</button>
          {marbleError && <p role="alert">{marbleError}</p>}
          {shownWorld && <div className="museum-marble-result"><strong>{shownWorld.displayName}</strong><p>{shownWorld.assets.caption ?? shownWorld.message}</p>
            {shownWorld.assets.worldMarbleUrl && <a href={shownWorld.assets.worldMarbleUrl} target="_blank" rel="noreferrer">打开云端展厅</a>}
          </div>}
        </details>}
      </aside>
      <section className="museum-stage" aria-label="三维展厅">
        <div className="museum-stage-heading"><div><span>{currentProduct?.category ?? '侗绣文创展'}</span><strong>{stageTitle}</strong></div><p>{stageDescription}</p></div>
        <label className="museum-mobile-view">展厅视角<select aria-label="切换展厅视角" value={view} disabled={!ready} onChange={event => chooseView(event.target.value as MuseumView)}>
          <option value="overview">展厅全景</option>
          {collections.map(category => <optgroup key={category} label={category}>
            <option value={`collection:${category}`}>{category}展区</option>
            {PRODUCT_CATALOG.filter(item => item.category === category).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </optgroup>)}
        </select></label>
        <div className="museum-view-toolbar" aria-label="调整展厅视角">
          <button type="button" disabled={!ready} onClick={() => stepView(-1)}>上一件</button>
          <button type="button" disabled={!ready} onClick={() => stepView(1)}>下一件</button>
          <button type="button" disabled={!ready} onClick={() => runtimeRef.current?.rotate(-0.16)} aria-label="向左旋转视角">向左</button>
          <button type="button" disabled={!ready} onClick={() => runtimeRef.current?.rotate(0.16)} aria-label="向右旋转视角">向右</button>
          <button type="button" disabled={!ready} onClick={() => runtimeRef.current?.zoom(0.85)}>拉近</button>
          <button type="button" disabled={!ready} onClick={() => runtimeRef.current?.zoom(1.18)}>拉远</button>
          <button type="button" disabled={!ready} onClick={() => chooseView('overview')}>重置视角</button>
        </div>
        <div ref={hostRef} className="museum-canvas" role="img" aria-label={`${pattern.name}三维文创展厅`} />
        {!ready && <div className={`museum-loading ${sceneError ? 'is-error' : ''}`} role={sceneError ? 'alert' : 'status'}>
          {sceneError ? <><img src={pattern.image} alt="母纹原图参考" /><p>{sceneError}</p><button className="button secondary" type="button" onClick={() => setRetry(value => value + 1)}>重新加载展厅</button></> : <p>正在加载展厅与纹样…</p>}
        </div>}
        <p className="museum-view-caption"><span>{viewLabel}</span><span>拖拽旋转 · 滚轮或双指缩放</span></p>
      </section>
    </div>
  </div>
}
