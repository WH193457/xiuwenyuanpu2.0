import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Pattern, ProductAppearance, ProductCarrier } from './domain'
import { PRODUCT_CATALOG, defaultProductAppearance } from './productCatalog'
import { buildProduct, prepareProductTexture } from './productModels'

export type MuseumView = 'overview' | ProductCarrier | `collection:${string}`
export type MuseumExhibit = { pattern: Pattern; textureUrl: string; featuredCarrier: ProductCarrier; appearance: ProductAppearance }
export type MuseumRuntime = {
  ready: Promise<void>
  setView: (view: MuseumView) => void
  setRotating: (rotating: boolean) => void
  rotate: (radians: number) => void
  zoom: (factor: number) => void
  capture: () => string
  dispose: () => void
}

function material(color: number, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...options })
}

function box(width: number, height: number, depth: number, surface: THREE.Material, radius = 0.04) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, depth, 2, radius), surface)
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}

function textTexture(title: string, subtitle = '', dark = false) {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const context = canvas.getContext('2d')!
  context.fillStyle = dark ? '#183b40' : '#f4efe3'
  context.fillRect(0, 0, 1024, 256)
  context.fillStyle = dark ? '#ede3cf' : '#263f3c'
  context.textAlign = 'center'
  context.font = '500 70px "Microsoft YaHei", sans-serif'
  context.fillText(title, 512, subtitle ? 112 : 155, 920)
  if (subtitle) {
    context.fillStyle = dark ? '#c6b188' : '#78817a'
    context.font = '32px "Microsoft YaHei", sans-serif'
    context.fillText(subtitle, 512, 183, 920)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function contactTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')!
  const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(31,28,22,.5)')
  gradient.addColorStop(0.45, 'rgba(31,28,22,.26)')
  gradient.addColorStop(1, 'rgba(31,28,22,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(canvas)
}

function addGallery(scene: THREE.Scene, textures: Set<THREE.Texture>) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 512
  const context = canvas.getContext('2d')!
  context.fillStyle = '#d8d1c0'
  context.fillRect(0, 0, 512, 512)
  for (let index = 0; index < 2400; index++) {
    context.fillStyle = index % 2 ? 'rgba(255,253,240,.13)' : 'rgba(105,93,72,.055)'
    context.fillRect((index * 73.37) % 512, (index * 137.91) % 512, 1 + index % 3, 1)
  }
  const stone = new THREE.CanvasTexture(canvas)
  stone.colorSpace = THREE.SRGBColorSpace
  stone.wrapS = stone.wrapT = THREE.RepeatWrapping
  stone.repeat.set(7, 7)
  textures.add(stone)
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(11.5, 11.5, 0.18, 96), material(0xffffff, { map: stone, roughness: 0.88 }))
  floor.scale.z = 0.97
  floor.position.set(0, -0.1, -1.2)
  floor.receiveShadow = true
  const edge = new THREE.Mesh(new THREE.CylinderGeometry(11.52, 11.52, 0.035, 96, 1, true), material(0xb49b69, { metalness: 0.55, roughness: 0.38 }))
  edge.scale.z = 0.97
  edge.position.set(0, -0.025, -1.2)
  const center = box(5.4, 5.75, 0.25, material(0x193a40), 0.14)
  center.position.set(0, 2.87, -9.4)
  scene.add(floor, edge, center)
  for (const direction of [-1, 1]) {
    const wall = box(5.7, 4.7, 0.22, material(0xf1ece0), 0.12)
    wall.position.set(direction * 5.45, 2.35, -8.95)
    wall.rotation.y = direction * -0.16
    scene.add(wall)
    const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.075, 4.65, 0.18), material(0x9c7852), 21)
    const transform = new THREE.Object3D()
    for (let index = 0; index < 21; index++) {
      transform.position.set(direction * (3.1 + index * 0.22), 2.35, -8.7 + index * 0.035)
      transform.updateMatrix()
      slats.setMatrixAt(index, transform.matrix)
    }
    slats.castShadow = true
    const rail = box(5.2, 0.07, 0.1, material(0xc2a775, { metalness: 0.5, roughness: 0.4 }), 0.02)
    rail.position.set(direction * 5.35, 4.81, -8.5)
    const light = new THREE.Mesh(new THREE.PlaneGeometry(5.05, 0.035), new THREE.MeshBasicMaterial({ color: 0xffe5af }))
    light.position.set(direction * 5.35, 4.75, -8.44)
    scene.add(slats, rail, light)
  }
  const titleTexture = textTexture('纹样 · 日常', '侗绣文创展', true)
  textures.add(titleTexture)
  const title = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 1.075), new THREE.MeshBasicMaterial({ map: titleTexture, toneMapped: false }))
  title.position.set(0, 4.95, -9.26)
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.08, 2.095, 96), material(0xb89c68, { metalness: 0.45 }))
  ring.rotation.x = -Math.PI / 2
  ring.position.set(0, 0.004, 5.1)
  scene.add(title, ring)
}

function addMotherArtwork(scene: THREE.Scene, texture: THREE.Texture, pattern: Pattern, textures: Set<THREE.Texture>) {
  const frame = box(2.6, 2.6, 0.1, material(0xbc9d69, { metalness: 0.5, roughness: 0.4 }))
  frame.position.set(0, 3.0, -9.22)
  const mount = new THREE.Mesh(new THREE.PlaneGeometry(2.43, 2.43), material(0xeee7d7))
  mount.position.set(0, 3.0, -9.158)
  const image = texture.image as { width: number; height: number }
  const aspect = image.width / image.height
  const width = Math.min(2.18, 2.18 * aspect)
  const art = new THREE.Mesh(new THREE.PlaneGeometry(width, width / aspect), new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }))
  art.position.set(0, 3.0, -9.147)
  const captionTexture = textTexture(pattern.id, '母纹原图', true)
  textures.add(captionTexture)
  const caption = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.425), new THREE.MeshBasicMaterial({ map: captionTexture, toneMapped: false }))
  caption.position.set(0, 1.4, -9.24)
  scene.add(frame, mount, art, caption)
}

const collections = [...new Set(PRODUCT_CATALOG.map(item => item.category))]

function exhibitPosition(category: string, index: number) {
  const collectionIndex = collections.indexOf(category)
  const side = collectionIndex % 2 === 0 ? -1 : 1
  const row = Math.floor(collectionIndex / 2) * 2 + Math.floor(index / 2)
  return { x: side * (3.65 + index % 2 * 3.15), z: 3.2 - row * 3.4, height: 0.72 + row * 0.38 }
}

const exhibitColors: Record<ProductCarrier, Pick<ProductAppearance, 'color' | 'detailColor'>> = {
  mug: { color: 'ivory', detailColor: '#79958b' },
  vase: { color: '#79958b', detailColor: 'ivory' },
  tote: { color: '#b9a17c', detailColor: '#79553d' },
  tee: { color: 'indigo', detailColor: 'ivory' },
  cushion: { color: 'terracotta', detailColor: 'ivory' },
  scarf: { color: '#52624b', detailColor: '#c6ae79' },
  notebook: { color: '#8a3e49', detailColor: '#c6ae79' },
  poster: { color: 'ivory', detailColor: '#79553d' },
  tumbler: { color: '#79958b', detailColor: '#303436' },
  coaster: { color: 'ivory', detailColor: '#79553d' },
  bookmark: { color: '#8a3e49', detailColor: '#c89b4e' },
  fan: { color: 'ivory', detailColor: '#79553d' },
  phonecase: { color: '#95acb4', detailColor: 'indigo' },
  pouch: { color: '#b9a17c', detailColor: '#8a3e49' },
}

/** Keep the current design on the central island and group the surrounding collection by category. */
export function mountMuseumScene(host: HTMLDivElement, exhibit: MuseumExhibit, onError: (message: string) => void, onInteraction: () => void): MuseumRuntime {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.9
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none'
  host.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xe6e3dc)
  const environmentRoom = new RoomEnvironment()
  const generator = new THREE.PMREMGenerator(renderer)
  const environment = generator.fromScene(environmentRoom, 0.06)
  scene.environment = environment.texture
  scene.environmentIntensity = 0.35
  environmentRoom.dispose()
  generator.dispose()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 120)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.1
  controls.enablePan = false
  controls.minPolarAngle = Math.PI * 0.13
  controls.maxPolarAngle = Math.PI * 0.47
  controls.minAzimuthAngle = -Math.PI * 0.38
  controls.maxAzimuthAngle = Math.PI * 0.38
  const textures = new Set<THREE.Texture>()
  const products = new Map<ProductCarrier, THREE.Group>()
  const centers = new Map<ProductCarrier, THREE.Vector3>()
  const productSizes = new Map<ProductCarrier, THREE.Vector3>()
  const displays = new Map<ProductCarrier, THREE.Object3D[]>()
  const abort = new AbortController()
  let disposed = false
  let rotating = false
  let ready = false
  let raf = 0
  let previousTime = 0
  let currentView: MuseumView = 'overview'

  const hemisphere = new THREE.HemisphereLight(0xfff9ee, 0x7b8387, 0.55)
  const key = new THREE.DirectionalLight(0xfff2dc, 2.0)
  key.position.set(-3, 11, 7)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = key.shadow.camera.bottom = -13
  key.shadow.camera.right = key.shadow.camera.top = 13
  key.shadow.normalBias = 0.015
  key.shadow.bias = -0.00015
  key.shadow.radius = 3
  const fill = new THREE.DirectionalLight(0xe2efff, 0.5)
  fill.position.set(7, 6, 3)
  const rim = new THREE.DirectionalLight(0xffe2bd, 0.55)
  rim.position.set(-1, 7, -6)
  scene.add(hemisphere, key, fill, rim)
  addGallery(scene, textures)

  const schedule = () => { if (!disposed && !document.hidden && !raf) raf = requestAnimationFrame(draw) }
  const draw = (time: number) => {
    raf = 0
    if (disposed || document.hidden) return
    const elapsed = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0
    previousTime = time
    if (rotating) for (const product of products.values()) product.rotation.y += elapsed * 0.25
    const moving = controls.update()
    renderer.render(scene, camera)
    if (rotating || moving) schedule()
  }
  const setView = (view: MuseumView) => {
    currentView = view
    controls.enableDamping = false
    controls.update()
    for (const product of products.values()) product.rotation.y = 0
    const category = view.startsWith('collection:') ? view.slice('collection:'.length) : undefined
    for (const item of PRODUCT_CATALOG) {
      const visible = view === 'overview' || item.id === view || item.category === category
      for (const object of displays.get(item.id) ?? []) object.visible = visible
    }
    const target = centers.get(view as ProductCarrier)
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2)
    if (category) {
      const bounds = new THREE.Box3()
      for (const item of PRODUCT_CATALOG.filter(item => item.category === category)) {
        const product = products.get(item.id)
        if (product) bounds.expandByObject(product)
      }
      bounds.getCenter(controls.target)
      const size = bounds.getSize(new THREE.Vector3())
      const distance = Math.max(size.y / 2 + size.z * 0.28 + 0.5, (size.x / 2 + 0.55) / camera.aspect) / Math.tan(halfFov) + size.z * 0.5
      camera.position.copy(controls.target).add(new THREE.Vector3(0, distance * 0.55, distance))
      controls.minDistance = distance * 0.6
      controls.maxDistance = distance * 1.8
    } else if (view === 'overview' || !target) {
      controls.target.set(0, 1.8, -1.4)
      const distance = Math.max(26, 10.3 / (Math.tan(halfFov) * camera.aspect))
      camera.position.copy(controls.target).add(new THREE.Vector3(0, distance * 0.65, distance))
      controls.minDistance = distance * 0.55
      controls.maxDistance = distance * 1.7
    } else {
      controls.target.copy(target)
      const size = productSizes.get(view as ProductCarrier)!
      const distance = Math.max(size.y / 2 + 0.2, (size.x / 2 + 0.26) / camera.aspect) / Math.tan(halfFov) + size.z / 2
      camera.position.copy(target).add(new THREE.Vector3(distance * 0.14, distance * 0.12, distance * 1.13))
      controls.minDistance = distance * 0.6
      controls.maxDistance = Math.max(12, distance * 2.4)
    }
    controls.update()
    controls.enableDamping = true
    schedule()
  }
  const resize = () => {
    if (disposed) return
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    setView(currentView)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  const interaction = () => { rotating = false; onInteraction(); schedule() }
  const visibility = () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; previousTime = 0 }
    else schedule()
  }
  const contextLost = (event: Event) => {
    event.preventDefault()
    cancelAnimationFrame(raf)
    raf = 0
    onError('三维显示连接中断，请点击重新加载展厅。')
  }
  controls.addEventListener('change', schedule)
  controls.addEventListener('start', interaction)
  renderer.domElement.addEventListener('webglcontextlost', contextLost)
  document.addEventListener('visibilitychange', visibility)
  resize()

  const loadTexture = (url: string) => new Promise<THREE.Texture>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      abort.signal.removeEventListener('abort', fail)
      reject(new Error('纹样图片加载失败，请重试或选择其他母纹。'))
    }
    timeout = setTimeout(fail, 20_000)
    abort.signal.addEventListener('abort', fail, { once: true })
    const texture = new THREE.TextureLoader().load(url, loaded => {
      clearTimeout(timeout)
      abort.signal.removeEventListener('abort', fail)
      if (disposed || settled) { loaded.dispose(); return }
      settled = true
      loaded.colorSpace = THREE.SRGBColorSpace
      resolve(loaded)
    }, undefined, fail)
    textures.add(texture)
  })
  const loading = Promise.all([loadTexture(exhibit.textureUrl), loadTexture(exhibit.pattern.image)]).then(([motif, wall]) => {
    if (disposed) return
    addMotherArtwork(scene, wall, exhibit.pattern, textures)
    const contact = contactTexture()
    textures.add(contact)
    const arranged = [PRODUCT_CATALOG.find(item => item.id === exhibit.featuredCarrier)!, ...PRODUCT_CATALOG.filter(item => item.id !== exhibit.featuredCarrier)]
    const categoryCounts = new Map<string, number>()
    arranged.forEach((item, index) => {
      const featured = index === 0
      const categoryIndex = categoryCounts.get(item.category) ?? 0
      const { x, z, height } = featured ? { x: 0, z: 5.1, height: 1.02 } : exhibitPosition(item.category, categoryIndex)
      if (!featured) categoryCounts.set(item.category, categoryIndex + 1)
      const texture = prepareProductTexture(motif.clone(), item.id)
      textures.add(texture)
      const appearance = featured ? exhibit.appearance : { ...defaultProductAppearance(item.id), ...exhibitColors[item.id] }
      const product = buildProduct(item.id, texture, appearance)
      product.userData.productCarrier = item.id
      const bounds = new THREE.Box3().setFromObject(product)
      const size = bounds.getSize(new THREE.Vector3())
      product.scale.setScalar(Math.min((featured ? 2.45 : 1.9) / size.y, (featured ? 2.7 : 2.15) / size.x, (featured ? 2.7 : 2.05) / size.z))
      bounds.setFromObject(product)
      const center = bounds.getCenter(new THREE.Vector3())
      product.position.add(new THREE.Vector3(x - center.x, height - bounds.min.y + 0.035, z - center.z))
      scene.add(product)
      products.set(item.id, product)
      bounds.setFromObject(product)
      centers.set(item.id, bounds.getCenter(new THREE.Vector3()))
      productSizes.set(item.id, bounds.getSize(new THREE.Vector3()))
      const pedestal = featured
        ? new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.65, height, 64), material(0x23464a))
        : box(2.55, height, 2.25, material(index % 2 ? 0xe8e1d3 : 0xc7b79b), 0.08)
      pedestal.position.set(x, height / 2, z)
      pedestal.receiveShadow = pedestal.castShadow = true
      const top = featured
        ? new THREE.Mesh(new THREE.CylinderGeometry(1.66, 1.66, 0.045, 64), material(0xb29a74, { roughness: 0.62 }))
        : box(2.57, 0.035, 2.27, material(0xf4edde), 0.015)
      top.position.set(x, height + 0.002, z)
      const contactSize = bounds.getSize(new THREE.Vector3())
      const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(2.4, contactSize.x * 1.2), Math.max(0.55, Math.min(1.9, contactSize.z * 1.5))), new THREE.MeshBasicMaterial({ map: contact, transparent: true, depthWrite: false, opacity: 0.7, toneMapped: false }))
      contactShadow.rotation.x = -Math.PI / 2
      contactShadow.position.set(x, height + 0.028, z)
      const labelTexture = textTexture(item.label, featured ? '当前设计 · ' + item.material : item.material, featured)
      textures.add(labelTexture)
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.425), new THREE.MeshBasicMaterial({ map: labelTexture, toneMapped: false }))
      label.position.set(x, height * 0.52, z + (featured ? 1.653 : 1.134))
      scene.add(pedestal, top, contactShadow, label)
      displays.set(item.id, [product, pedestal, top, contactShadow, label])
    })
    ready = true
    setView(currentView)
  })

  const dispose = () => {
    if (disposed) return
    disposed = true
    abort.abort()
    cancelAnimationFrame(raf)
    observer.disconnect()
    controls.dispose()
    document.removeEventListener('visibilitychange', visibility)
    renderer.domElement.removeEventListener('webglcontextlost', contextLost)
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    scene.traverse(object => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) geometries.add(mesh.geometry)
      const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
      for (const value of values) {
        materials.add(value)
        for (const property of Object.values(value)) if (property instanceof THREE.Texture) textures.add(property)
      }
    })
    geometries.forEach(geometry => geometry.dispose())
    materials.forEach(value => value.dispose())
    textures.forEach(texture => texture.dispose())
    environment.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }
  return {
    ready: loading,
    setView,
    setRotating: value => { rotating = value; previousTime = 0; schedule() },
    rotate: radians => {
      camera.position.sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), radians).add(controls.target)
      controls.update()
      schedule()
    },
    zoom: factor => {
      const offset = camera.position.clone().sub(controls.target)
      offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance))
      camera.position.copy(controls.target).add(offset)
      controls.update()
      schedule()
    },
    capture: () => {
      if (!ready || disposed) throw new Error('展厅尚未就绪，请稍后导出。')
      renderer.render(scene, camera)
      return renderer.domElement.toDataURL('image/png')
    },
    dispose,
  }
}
