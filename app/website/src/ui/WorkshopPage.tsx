import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useLocation, useNavigationType, useSearchParams } from 'react-router'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Pattern, ProductAppearance, ProductCarrier, WorkshopSession } from '../domain'
import { appearanceSearchParams, readWorkshopSession, resolveWorkshopSelection, saveWorkshopSession } from '../workshopSession'
import { PRODUCT_CATALOG, PRODUCT_CATEGORIES, defaultProductAppearance } from '../productCatalog'
import { PRODUCT_COLOR_PARTS, PRODUCT_COLOR_PRESETS, resolveProductColor, resolveProductDetailColor } from '../productColors'
import { buildProduct, prepareProductTexture, addProductStudio } from '../productModels'
import { Icon } from './Icon'
import './workshop.css'

type ProductView = 'front' | 'back' | 'perspective'
type PreviewRuntime = {
  setView: (view: ProductView) => void
  setRotating: (value: boolean) => void
  updateProduct: (carrier: ProductCarrier, appearance: ProductAppearance) => void
  capture: () => void
}

function disposeResources(root: THREE.Object3D, loadedTexture?: THREE.Texture) {
  const textures = new Set<THREE.Texture>()
  const materials = new Set<THREE.Material>()
  const geometries = new Set<THREE.BufferGeometry>()
  if (loadedTexture) textures.add(loadedTexture)
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const material of list) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  textures.forEach(texture => texture.dispose())
  materials.forEach(material => material.dispose())
  geometries.forEach(geometry => geometry.dispose())
}

export function WorkshopPage() {
  const patterns = useLoaderData() as Pattern[]
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigationType = useNavigationType()
  const [draftParams, setDraftParams] = useState(params)
  const latestParams = useRef(params)
  const requestedSearches = useRef(new Set<string>())
  const [session, setSession] = useState(readWorkshopSession)
  const selection = useMemo(() => resolveWorkshopSelection(patterns, draftParams, session), [patterns, draftParams, session])
  const { pattern, carrier, textureUrl, source, appearance } = selection
  const appearanceKey = JSON.stringify(appearance)
  const current = useRef({ pattern, carrier, appearance })
  if (draftParams.toString() === latestParams.current.toString()) current.current = { pattern, carrier, appearance }
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<PreviewRuntime | undefined>(undefined)
  const [panel, setPanel] = useState<'products' | 'appearance' | 'colors'>('products')
  const [category, setCategory] = useState('all')
  const [rotating, setRotating] = useState(false)
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [previewError, setPreviewError] = useState('')
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState('')
  const [retry, setRetry] = useState(0)
  const hasSavedTexture = selection.session && selection.session.textureUrl !== pattern?.image
  const sourceLabel = textureUrl === pattern?.image ? '母纹原图'
    : source === 'create' ? '创生工坊所选候选' : source === 'sam3' ? 'SAM3提取纹样元' : '已保存纹理（旧记录）'
  const productInfo = PRODUCT_CATALOG.find(item => item.id === carrier)!
  const colorParts = PRODUCT_COLOR_PARTS[carrier]
  const customDetailColor = appearance.detailColor !== 'auto' && !PRODUCT_COLOR_PRESETS.some(item => item.id === appearance.detailColor)

  useLayoutEffect(() => {
    const search = params.toString()
    const latest = latestParams.current.toString()
    // Intermediate router commits must not replace a more recent local edit.
    if (navigationType === 'POP' || !requestedSearches.current.has(search) || search === latest) {
      latestParams.current = params
      setDraftParams(params)
      requestedSearches.current.clear()
    } else requestedSearches.current.delete(search)
  }, [params, location.key, navigationType])

  useEffect(() => {
    setNotice('')
    setStorageError('')
  }, [pattern?.id, carrier, textureUrl, appearanceKey])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !textureUrl) return
    setRenderState('loading')
    setPreviewError('')
    setRotating(false)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch {
      setRenderState('error')
      setPreviewError('浏览器未能启用三维显示。可查看左侧纹样，或重新加载预览。')
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.setAttribute('aria-label', '可拖动旋转的文创模型')
    host.replaceChildren(renderer.domElement)
    const scene = new THREE.Scene()
    const room = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const environment = pmrem.fromScene(room, 0.04)
    scene.environment = environment.texture
    scene.environmentIntensity = 0.45
    room.dispose()
    pmrem.dispose()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 60)
    const studio = addProductStudio(scene)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.enablePan = false
    controls.maxPolarAngle = Math.PI * 0.8
    let product: THREE.Group | undefined
    let sourceTexture: THREE.Texture | undefined
    let productTexture: THREE.Texture | undefined
    let disposed = false
    let contextAvailable = true
    let isRotating = false
    let frame = 0
    let previousTime = 0
    let currentView: ProductView = 'perspective'
    let currentCarrier = current.current.carrier
    let appliedAppearance = ''
    const bounds = new THREE.Box3()
    const center = new THREE.Vector3()
    const size = new THREE.Vector3()

    const schedule = () => {
      if (!disposed && contextAvailable && !document.hidden && !frame) frame = requestAnimationFrame(draw)
    }
    const draw = (time: number) => {
      frame = 0
      if (disposed || !contextAvailable || document.hidden) return
      const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0
      previousTime = time
      if (product && isRotating) product.rotation.y += delta * 0.28
      const moving = controls.update()
      renderer.render(scene, camera)
      if (isRotating || moving) schedule()
    }
    const setView = (view: ProductView) => {
      if (!product) return
      controls.enableDamping = false
      controls.update()
      controls.enableDamping = true
      currentView = view
      product.rotation.y = 0
      bounds.setFromObject(product).getCenter(center)
      bounds.getSize(size)
      controls.target.copy(center)
      const halfExtent = Math.max(size.y / 2, size.x / (2 * camera.aspect))
      const distance = (halfExtent / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) + size.z / 2) * 1.2
      const direction = view === 'front' ? new THREE.Vector3(0, 0.04, 1)
        : view === 'back' ? new THREE.Vector3(0, 0.04, -1) : new THREE.Vector3(0.42, ['mug', 'vase', 'tumbler'].includes(currentCarrier) ? 0.38 : 0.2, 1)
      camera.position.copy(center).add(direction.normalize().multiplyScalar(distance))
      controls.minDistance = distance * 0.58
      controls.maxDistance = distance * 2.8
      controls.update()
      schedule()
    }
    const resize = () => {
      renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false)
      camera.aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight)
      camera.updateProjectionMatrix()
      if (product) setView(currentView)
      schedule()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const setAutoRotation = (value: boolean) => {
      isRotating = value
      previousTime = 0
      schedule()
    }
    const onInteraction = () => { setAutoRotation(false); setRotating(false) }
    controls.addEventListener('change', schedule)
    controls.addEventListener('start', onInteraction)
    const onVisibility = () => {
      cancelAnimationFrame(frame)
      frame = 0
      previousTime = 0
      schedule()
    }
    const onContextLost = (event: Event) => {
      event.preventDefault()
      contextAvailable = false
      isRotating = false
      cancelAnimationFrame(frame)
      frame = 0
      setRotating(false)
      setRenderState('error')
      setPreviewError('三维显示连接已中断，请重新加载预览。')
    }
    document.addEventListener('visibilitychange', onVisibility)
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)

    const updateProduct = (nextCarrier: ProductCarrier, nextAppearance: ProductAppearance) => {
      if (!sourceTexture || disposed || !contextAvailable) return
      const nextKey = JSON.stringify(nextAppearance)
      if (product && currentCarrier === nextCarrier && appliedAppearance === nextKey) return
      const nextTexture = prepareProductTexture(sourceTexture.clone(), nextCarrier)
      try {
        const nextProduct = buildProduct(nextCarrier, nextTexture, nextAppearance)
        const changedCarrier = nextCarrier !== currentCarrier
        if (product) { scene.remove(product); disposeResources(product, productTexture) }
        productTexture = nextTexture
        product = nextProduct
        currentCarrier = nextCarrier
        appliedAppearance = nextKey
        scene.add(product)
        bounds.setFromObject(product)
        studio.ground.position.y = bounds.min.y - 0.012
        setAutoRotation(false)
        setRotating(false)
        if (changedCarrier || !runtimeRef.current) setView('perspective')
        schedule()
        setRenderState('ready')
        setPreviewError('')
      } catch {
        nextTexture.dispose()
        setRenderState('error')
        setPreviewError('模型贴图处理失败，请重新加载预览或更换纹样。')
      }
    }
    const loadingTimer = window.setTimeout(() => {
      if (!disposed && !sourceTexture) { setRenderState('error'); setPreviewError('纹样加载超时，请检查图片后重新加载。') }
    }, 20_000)
    new THREE.TextureLoader().load(textureUrl, loaded => {
      window.clearTimeout(loadingTimer)
      if (disposed || !contextAvailable) { loaded.dispose(); return }
      sourceTexture = loaded
      updateProduct(current.current.carrier, current.current.appearance)
      runtimeRef.current = {
        setView,
        setRotating: setAutoRotation,
        updateProduct,
        capture: () => {
          try {
            updateProduct(current.current.carrier, current.current.appearance)
            renderer.render(scene, camera)
            renderer.domElement.toBlob(blob => {
              if (disposed) return
              if (!blob) { setNotice('预览图导出失败，请重新加载图片后再试。'); return }
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = current.current.pattern?.id + '-' + currentCarrier + '-文创预览.png'
              link.click()
              window.setTimeout(() => URL.revokeObjectURL(url), 1000)
            }, 'image/png')
          } catch { setNotice('预览图导出失败，请重新加载图片后再试。') }
        },
      }
    }, undefined, () => {
      window.clearTimeout(loadingTimer)
      if (!disposed) { setRenderState('error'); setPreviewError('纹样图片加载失败，请更换纹样或重新加载。') }
    })
    return () => {
      disposed = true
      runtimeRef.current = undefined
      window.clearTimeout(loadingTimer)
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      controls.removeEventListener('change', schedule)
      controls.removeEventListener('start', onInteraction)
      controls.dispose()
      disposeResources(scene, productTexture)
      sourceTexture?.dispose()
      environment.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [textureUrl, retry])

  useEffect(() => {
    // Reuse the loaded source and WebGL context while combining rapid slider changes.
    const timer = window.setTimeout(() => runtimeRef.current?.updateProduct(carrier, current.current.appearance), 100)
    return () => window.clearTimeout(timer)
  }, [carrier, appearanceKey])

  const selectionParams = (nextAppearance?: ProductAppearance) => {
    const latest = resolveWorkshopSelection(patterns, latestParams.current, session)
    const next = new URLSearchParams(latestParams.current)
    next.set('pattern', latest.pattern?.id ?? '')
    next.set('carrier', latest.carrier)
    next.set('source', latest.textureUrl === latest.pattern?.image ? 'library' : 'session')
    for (const [key, value] of appearanceSearchParams(nextAppearance ?? latest.appearance)) next.set(key, value)
    return next
  }
  const updateParams = (next: URLSearchParams, replace = false) => {
    latestParams.current = next
    requestedSearches.current.add(next.toString())
    const nextSelection = resolveWorkshopSelection(patterns, next, session)
    current.current = { pattern: nextSelection.pattern, carrier: nextSelection.carrier, appearance: nextSelection.appearance }
    setDraftParams(next)
    setParams(next, { replace, preventScrollReset: true })
  }
  const changeSelection = (values: Record<string, string>) => {
    const latest = resolveWorkshopSelection(patterns, latestParams.current, session)
    if (values.carrier === latest.carrier && Object.keys(values).length === 1) return
    const nextAppearance = values.carrier
      ? { ...defaultProductAppearance(values.carrier as ProductCarrier), color: latest.appearance.color, detailColor: latest.appearance.detailColor }
      : latest.appearance
    const next = selectionParams(nextAppearance)
    for (const [key, value] of Object.entries(values)) next.set(key, value)
    updateParams(next)
  }
  const changeAppearance = (patch: Partial<ProductAppearance>) => {
    const latest = resolveWorkshopSelection(patterns, latestParams.current, session)
    updateParams(selectionParams({ ...latest.appearance, ...patch }), true)
  }
  const persist = () => {
    const latest = resolveWorkshopSelection(patterns, latestParams.current, session)
    if (!latest.pattern || !latest.textureUrl) return false
    const next: WorkshopSession = {
      patternId: latest.pattern.id, patternName: latest.pattern.name, textureUrl: latest.textureUrl,
      carrier: latest.carrier, source: latest.source, appearance: latest.appearance,
      createdAt: new Date().toISOString(),
    }
    try {
      saveWorkshopSession(next)
      setSession(next)
      setStorageError('')
      setNotice('贴图方案已保存，含载体、主体与部件配色、纹样排版。')
      return true
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '贴图方案保存失败，请重试。')
      return false
    }
  }
  const viewProduct = (view: ProductView) => {
    runtimeRef.current?.updateProduct(current.current.carrier, current.current.appearance)
    setRotating(false)
    runtimeRef.current?.setRotating(false)
    runtimeRef.current?.setView(view)
  }
  const toggleRotation = () => {
    runtimeRef.current?.updateProduct(current.current.carrier, current.current.appearance)
    runtimeRef.current?.setRotating(!rotating)
    setRotating(!rotating)
  }

  if (!pattern) return <div className="page-wrap"><p role="alert">尚未加载纹样资料。</p></div>

  return <div className="page-wrap workshop-page">
    <header className="page-title-block split-title">
      <div><p className="eyebrow">CULTURAL PRODUCT STUDIO</p><h1>文创贴图台</h1></div>
      <p>选择文创载体，调整纹样比例与位置。布面和器皿呈现各自的纹理与光泽，完成后可带入博物馆展陈。</p>
    </header>
    <div className="workshop-shell">
      <aside className="workshop-panel">
        <h2>纹样来源</h2>
        <label className="select-label">母纹<select aria-label="文创母纹" value={pattern.id} onChange={event => changeSelection({ pattern: event.target.value, source: 'library' })}>
          {patterns.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}
        </select></label>
        <figure className="workshop-reference">
          <img src={textureUrl} alt="当前贴图纹样" />
          <figcaption><strong>{pattern.id}</strong><span>{sourceLabel}</span></figcaption>
        </figure>
        {hasSavedTexture && <fieldset className="workshop-source-options"><legend>贴图来源</legend>
          <label><input type="radio" name="workshop-source" checked={textureUrl === pattern.image} onChange={() => changeSelection({ source: 'library' })} />母纹原图</label>
          <label><input type="radio" name="workshop-source" checked={textureUrl !== pattern.image} onChange={() => changeSelection({ source: 'session' })} />已保存的创作纹理</label>
        </fieldset>}
        <div className="workshop-tabs" role="tablist" aria-label="文创设计设置">
          <button id="workshop-products-tab" role="tab" aria-selected={panel === 'products'} aria-controls="workshop-products-panel" onClick={() => setPanel('products')}>选择文创</button>
          <button id="workshop-colors-tab" role="tab" aria-selected={panel === 'colors'} aria-controls="workshop-colors-panel" onClick={() => setPanel('colors')}>物品配色</button>
          <button id="workshop-appearance-tab" role="tab" aria-selected={panel === 'appearance'} aria-controls="workshop-appearance-panel" onClick={() => setPanel('appearance')}>调整贴图</button>
        </div>
        {panel === 'products' ? <div id="workshop-products-panel" role="tabpanel" aria-labelledby="workshop-products-tab" className="workshop-products-panel">
          <label className="select-label">文创类别<select aria-label="文创类别" value={category} onChange={event => setCategory(event.target.value)}>
            <option value="all">全部款式（{PRODUCT_CATALOG.length}）</option>
            {PRODUCT_CATEGORIES.map(item => <option key={item} value={item}>{item}</option>)}
          </select></label>
          <div className="carrier-grid" aria-label="文创载体">
            {PRODUCT_CATALOG.filter(item => category === 'all' || item.category === category).map(item => <button key={item.id} type="button" aria-pressed={carrier === item.id} className={carrier === item.id ? 'active' : ''}
              onClick={() => changeSelection({ carrier: item.id })}><b>{item.label}</b><span>{item.material}</span></button>)}
          </div>
          <p className="workshop-note">{productInfo.tip}</p>
        </div> : panel === 'colors' ? <div id="workshop-colors-panel" role="tabpanel" aria-labelledby="workshop-colors-tab" className="workshop-colors-panel">
          <p className="workshop-color-note">原图边缘连通的浅色背景可在“调整贴图”中去除，以显示物品底色。</p>
          <fieldset className="workshop-colors"><legend>{colorParts.body}</legend>
            <div className="workshop-color-presets">{PRODUCT_COLOR_PRESETS.map(color => <button key={color.id} type="button" aria-label={color.label + '底色'} aria-pressed={resolveProductColor(appearance.color).toLowerCase() === color.color.toLowerCase()} onClick={() => changeAppearance({ color: color.id })}>
              <span style={{ background: color.color }} /><b>{color.label}</b>
            </button>)}</div>
            <label className="workshop-custom-color"><span>自定义主色</span><input aria-label="自定义物品主色" type="color" value={resolveProductColor(appearance.color)} onChange={event => changeAppearance({ color: event.target.value as ProductAppearance['color'] })} /><output>{resolveProductColor(appearance.color).toUpperCase()}</output></label>
          </fieldset>
          <fieldset className="workshop-detail-colors"><legend>{colorParts.detail}</legend>
            <select aria-label="部件颜色" value={appearance.detailColor} onChange={event => changeAppearance({ detailColor: event.target.value as ProductAppearance['detailColor'] })}>
              <option value="auto">自动搭配材质</option>
              {PRODUCT_COLOR_PRESETS.map(color => <option key={color.id} value={color.id}>{color.label}</option>)}
              {customDetailColor && <option value={appearance.detailColor}>自定义颜色</option>}
            </select>
            <label className="workshop-custom-color"><span>自定义部件色</span><input aria-label="自定义部件颜色" type="color" value={resolveProductDetailColor(appearance)} onChange={event => changeAppearance({ detailColor: event.target.value as ProductAppearance['detailColor'] })} /><output>{appearance.detailColor === 'auto' ? '自动' : resolveProductDetailColor(appearance).toUpperCase()}</output></label>
          </fieldset>
          <button className="workshop-reset" type="button" onClick={() => changeAppearance({ color: 'ivory', detailColor: 'auto' })}>重置物品配色</button>
        </div> : <div id="workshop-appearance-panel" role="tabpanel" aria-labelledby="workshop-appearance-tab" className="workshop-appearance-panel">
          <label className="workshop-range"><span>纹样缩放<output>{Math.round(appearance.scale * 100)}%</output></span><input aria-label="纹样缩放" type="range" min="0.35" max="1.8" step="0.05" value={appearance.scale} onChange={event => changeAppearance({ scale: Number(event.target.value) })} /></label>
          <label className="workshop-range"><span>水平位置<output>{Math.round(appearance.offsetX * 100)}%</output></span><input aria-label="水平位置" type="range" min="-0.5" max="0.5" step="0.01" value={appearance.offsetX} onChange={event => changeAppearance({ offsetX: Number(event.target.value) })} /></label>
          <label className="workshop-range"><span>垂直位置<output>{Math.round(appearance.offsetY * 100)}%</output></span><input aria-label="垂直位置" type="range" min="-0.5" max="0.5" step="0.01" value={appearance.offsetY} onChange={event => changeAppearance({ offsetY: Number(event.target.value) })} /></label>
          <label className="workshop-range"><span>纹样旋转<output>{appearance.rotation}°</output></span><input aria-label="纹样旋转" type="range" min="-180" max="180" step="5" value={appearance.rotation} onChange={event => changeAppearance({ rotation: Number(event.target.value) })} /></label>
          <label className="workshop-check"><input type="checkbox" checked={appearance.repeat} onChange={event => changeAppearance({ repeat: event.target.checked })} />连续纹样</label>
          <label className="workshop-check"><input type="checkbox" checked={appearance.removeBackground} onChange={event => changeAppearance({ removeBackground: event.target.checked })} />去除浅色底色</label>
          <p className="workshop-control-note">去底处理适用于边缘连通的浅色背景，可随时切回原图效果。</p>
          <button className="workshop-reset" type="button" onClick={() => changeAppearance({ ...defaultProductAppearance(carrier), color: appearance.color, detailColor: appearance.detailColor })}>重置贴图参数</button>
        </div>}
        <div className="workshop-actions">
          <button className="button secondary" type="button" onClick={persist}>保存贴图方案</button>
          <Link className="button primary" to={'/museum?' + selectionParams().toString()}
            onClick={event => { if (textureUrl !== pattern.image && !persist()) event.preventDefault() }}>进入 3D 博物馆 <Icon name="arrow" size={18} /></Link>
        </div>
        {notice && <p className="workshop-feedback" role="status">{notice}</p>}
        {storageError && <p className="workshop-error" role="alert">{storageError}</p>}
      </aside>
      <section className="workshop-stage" aria-label="文创三维预览">
        <div className="workshop-product-heading"><div><span>{productInfo.category}</span><h2>{productInfo.label}</h2></div><p>{productInfo.material}</p></div>
        <div className="workshop-toolbar" aria-label="模型查看控制">
          <button type="button" disabled={renderState !== 'ready'} onClick={() => viewProduct('front')}>正面</button>
          <button type="button" disabled={renderState !== 'ready'} onClick={() => viewProduct('back')}>背面</button>
          <button type="button" disabled={renderState !== 'ready'} onClick={() => viewProduct('perspective')}>重置视角</button>
          <button type="button" disabled={renderState !== 'ready'} aria-pressed={rotating} onClick={toggleRotation}>{rotating ? '暂停旋转' : '自动旋转'}</button>
          <button type="button" disabled={renderState !== 'ready'} onClick={() => runtimeRef.current?.capture()}>下载预览图</button>
        </div>
        <div ref={hostRef} className="workshop-canvas" role="img" data-render-state={renderState} aria-label={pattern.name + '文创三维预览'} />
        {renderState !== 'ready' && <div className="workshop-overlay" role={renderState === 'error' ? 'alert' : 'status'}>
          <p>{renderState === 'loading' ? '正在载入纹样与产品模型…' : previewError}</p>
          {renderState === 'error' && <button className="button secondary" type="button" onClick={() => setRetry(value => value + 1)}>重新加载预览</button>}
        </div>}
        <div className="workshop-caption"><span>{pattern.name}</span><small>拖动旋转 · 滚轮或双指缩放</small></div>
      </section>
    </div>
  </div>
}
