import * as THREE from 'three'
import type { ProductAppearance } from './domain'
import { resolveProductColor, resolveProductDetailColor } from './productColors'
import { mesh, roundedPanel, roundedRect, seam } from './productGeometry'
import { ceramicMaterial, plainFabric, printedMaterial, weaveTexture } from './productMaterials'

function turnedGeometry(profile: number[][], height: number) {
  const curve = new THREE.SplineCurve(profile.map(([radius, y]) => new THREE.Vector2(radius, y)))
  const points = curve.getPoints(128).map(point => new THREE.Vector2(Math.max(0, point.x), point.y))
  const geometry = new THREE.LatheGeometry(points, 96)
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  for (let vertex = 0; vertex < position.count; vertex++) uv.setY(vertex, position.getY(vertex) / height)
  geometry.rotateY(Math.PI)
  return geometry
}

export function buildTumbler(texture: THREE.Texture, appearance: ProductAppearance): THREE.Group {
  const group = new THREE.Group()
  const bodyColor = resolveProductColor(appearance.color)
  const detailColor = resolveProductDetailColor(appearance, '#414a48')
  const print = printedMaterial(texture, appearance, 2 * Math.PI * 0.465, 2,
    { width: 1.04, height: 1.2, y: -0.04 }, 'ceramic')
  print.roughness = 0.48
  print.clearcoat = 0.2
  print.metalness = 0.08
  const body = mesh(turnedGeometry([
    [0, 0], [0.36, 0], [0.416, 0.045], [0.448, 0.14], [0.463, 0.5],
    [0.473, 1.55], [0.459, 1.77], [0.402, 1.92], [0.36, 1.98],
  ], 2), print, 'product-print')
  const lidMaterial = new THREE.MeshPhysicalMaterial({ color: detailColor, roughness: 0.48, clearcoat: 0.15, clearcoatRoughness: 0.35 })
  const lid = mesh(turnedGeometry([
    [0, 1.995], [0.35, 1.995], [0.381, 2.02], [0.388, 2.06],
    [0.388, 2.18], [0.37, 2.215], [0.30, 2.225], [0, 2.225],
  ], 2.3), lidMaterial, 'tumbler-lid')
  const metal = new THREE.MeshStandardMaterial({ color: 0xa4afb0, roughness: 0.3, metalness: 0.85 })
  const collar = mesh(new THREE.CylinderGeometry(0.367, 0.369, 0.035, 96), metal, 'tumbler-neck-band')
  collar.position.y = 1.987
  const gasketColor = new THREE.Color(detailColor).multiplyScalar(0.45)
  const gasketMaterial = new THREE.MeshStandardMaterial({ color: gasketColor, roughness: 0.88 })
  const gasket = mesh(new THREE.TorusGeometry(0.377, 0.007, 8, 96), gasketMaterial, 'tumbler-lid-gasket')
  gasket.rotation.x = Math.PI / 2
  gasket.position.y = 2.025
  const recess = mesh(roundedPanel(0.25, 0.43, 0.008, 0.105), gasketMaterial, 'tumbler-drinking-recess')
  recess.rotation.x = -Math.PI / 2
  recess.position.set(0, 2.231, 0.05)
  const slider = mesh(roundedPanel(0.212, 0.26, 0.016, 0.087), lidMaterial, 'tumbler-slider')
  slider.rotation.x = -Math.PI / 2
  slider.position.set(0, 2.243, 0.091)
  const gripMaterial = new THREE.MeshStandardMaterial({ color: detailColor, roughness: 0.8 })
  for (const z of [0.035, 0.07, 0.105]) {
    const grip = mesh(new THREE.CapsuleGeometry(0.006, 0.12, 3, 8), gripMaterial)
    grip.rotation.z = Math.PI / 2
    grip.position.set(0, 2.263, z)
    group.add(grip)
  }
  const base = mesh(new THREE.CylinderGeometry(0.371, 0.371, 0.023, 96), gasketMaterial, 'tumbler-base-pad')
  base.position.y = -0.002
  const baseRing = mesh(new THREE.TorusGeometry(0.416, 0.012, 12, 96), lidMaterial, 'tumbler-base-ring')
  baseRing.rotation.x = Math.PI / 2
  baseRing.position.y = 0.054
  const shoulder = mesh(new THREE.TorusGeometry(0.361, 0.007, 8, 96), ceramicMaterial(bodyColor))
  shoulder.rotation.x = Math.PI / 2
  shoulder.position.y = 1.971
  group.add(body, lid, collar, gasket, recess, slider, base, baseRing, shoulder)
  group.position.y = -1.12
  return group
}

export function buildCoaster(texture: THREE.Texture, appearance: ProductAppearance): THREE.Group {
  const group = new THREE.Group()
  const diameter = 1.9
  const geometry = turnedGeometry([
    [0, -0.035], [0.85, -0.035], [0.924, -0.025], [0.949, 0.003],
    [0.938, 0.039], [0.9, 0.057], [0.82, 0.047], [0, 0.047],
  ], 1)
  geometry.rotateX(Math.PI / 2)
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  for (let vertex = 0; vertex < position.count; vertex++) {
    uv.setXY(vertex, position.getX(vertex) / diameter + 0.5, position.getY(vertex) / diameter + 0.5)
  }
  const print = printedMaterial(texture, appearance, diameter, diameter,
    { width: 1.48, height: 1.48 }, 'ceramic')
  print.roughness = 0.52
  print.clearcoat = 0.18
  print.clearcoatRoughness = 0.38
  print.envMapIntensity = 0.5
  const body = mesh(geometry, print, 'product-print')
  const rim = mesh(new THREE.TorusGeometry(0.916, 0.022, 16, 128),
    ceramicMaterial(resolveProductDetailColor(appearance)), 'coaster-rim')
  rim.position.z = 0.055
  const cork = document.createElement('canvas')
  cork.width = cork.height = 128
  const context = cork.getContext('2d')!
  const pixels = context.createImageData(128, 128)
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const grain = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    const variation = (grain - Math.floor(grain) - 0.5) * 47
    const fleck = Math.sin(x * 0.7 + y * 0.2) * Math.sin(y * 0.82 - x * 0.31) < -0.65 ? -30 : 0
    const offset = (y * 128 + x) * 4
    pixels.data[offset] = 164 + variation + fleck
    pixels.data[offset + 1] = 126 + variation + fleck
    pixels.data[offset + 2] = 83 + variation + fleck
    pixels.data[offset + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  const corkMap = new THREE.CanvasTexture(cork)
  corkMap.colorSpace = THREE.SRGBColorSpace
  corkMap.wrapS = corkMap.wrapT = THREE.RepeatWrapping
  corkMap.repeat.set(3, 3)
  const corkBump = corkMap.clone()
  corkBump.colorSpace = THREE.NoColorSpace
  const corkMaterial = new THREE.MeshStandardMaterial({ map: corkMap, bumpMap: corkBump, bumpScale: 0.003, roughness: 0.98 })
  const backing = mesh(new THREE.CylinderGeometry(0.886, 0.878, 0.042, 96, 1), corkMaterial, 'coaster-cork')
  backing.rotation.x = Math.PI / 2
  backing.position.z = -0.058
  group.add(body, rim, backing)
  group.rotation.x = -0.18
  return group
}

export function buildBookmark(texture: THREE.Texture, appearance: ProductAppearance): THREE.Group {
  const group = new THREE.Group()
  const weave = weaveTexture()
  const silk = weaveTexture(true)
  const detailColor = resolveProductDetailColor(appearance, '#a67c44')
  const binding = plainFabric(appearance, weave, false, detailColor)
  const cordMaterial = plainFabric(appearance, silk, true, detailColor)
  const shape = roundedRect(0.58, 2.1, 0.045)
  const hole = new THREE.Path()
  hole.absellipse(0, 0.855, 0.041, 0.041, 0, Math.PI * 2, true)
  shape.holes.push(hole)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.022, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.003, bevelSegments: 2, curveSegments: 16,
  })
  geometry.translate(0, 0, -0.011)
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  for (let vertex = 0; vertex < position.count; vertex++) {
    uv.setXY(vertex, position.getX(vertex) / 0.58 + 0.5, position.getY(vertex) / 2.1 + 0.5)
  }
  const body = mesh(geometry, printedMaterial(texture, appearance, 0.58, 2.1,
    { width: 0.45, height: 1.6, y: -0.05 }, 'fabric', weave), 'product-print')
  group.add(body)
  const edge = roundedRect(0.556, 2.076, 0.04).getPoints(16).slice(0, -1)
  for (const side of [-1, 1]) {
    const border = seam(edge.map(point => new THREE.Vector3(point.x, point.y, side * 0.016)), binding, 0.004, true)
    border.name = 'bookmark-woven-edge'
    const eyelet = mesh(new THREE.TorusGeometry(0.041, 0.008, 10, 48),
      new THREE.MeshStandardMaterial({ color: detailColor, metalness: 0.55, roughness: 0.38 }), 'bookmark-eyelet')
    eyelet.position.set(0, 0.855, side * 0.015)
    group.add(border, eyelet)
  }
  const cord = seam([
    new THREE.Vector3(0, 0.855, 0.028), new THREE.Vector3(0.018, 1.13, 0.045),
    new THREE.Vector3(0.21, 1.27, 0.033), new THREE.Vector3(0.39, 1.16, 0.022),
  ], cordMaterial, 0.009)
  const returnCord = seam([
    new THREE.Vector3(0, 0.855, -0.026), new THREE.Vector3(-0.018, 1.12, -0.028),
    new THREE.Vector3(0.19, 1.252, 0.013), new THREE.Vector3(0.39, 1.16, 0.022),
  ], cordMaterial, 0.009)
  const knot = mesh(new THREE.SphereGeometry(0.033, 20, 12), cordMaterial, 'bookmark-tassel')
  knot.scale.set(0.86, 1.18, 0.86)
  knot.position.set(0.392, 1.14, 0.022)
  const bindingRing = mesh(new THREE.TorusGeometry(0.027, 0.004, 8, 24), binding)
  bindingRing.rotation.x = Math.PI / 2
  bindingRing.position.set(0.395, 1.111, 0.022)
  group.add(cord, returnCord, knot, bindingRing)
  for (let strand = 0; strand < 22; strand++) {
    const angle = strand / 22 * Math.PI * 2
    const endY = 0.58 + 0.035 * Math.sin(strand * 2.1)
    const points = [
      new THREE.Vector3(0.395 + 0.018 * Math.cos(angle), 1.11, 0.022 + 0.018 * Math.sin(angle)),
      new THREE.Vector3(0.415 + 0.026 * Math.cos(angle), 0.94, 0.026 + 0.025 * Math.sin(angle)),
      new THREE.Vector3(0.47 + 0.041 * Math.cos(angle), 0.72, 0.037 + 0.035 * Math.sin(angle)),
      new THREE.Vector3(0.48 + 0.047 * Math.cos(angle), endY, 0.044 + 0.039 * Math.sin(angle)),
    ]
    group.add(seam(points, cordMaterial, 0.0034))
  }
  group.position.set(-0.09, -0.09, 0)
  return group
}
