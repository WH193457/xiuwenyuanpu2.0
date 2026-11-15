import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ProductAppearance } from './domain'
import { mesh, roundedPanel, roundedRect, seam, surfaceGeometry } from './productGeometry'
import { ceramicMaterial, plainFabric, printedMaterial, weaveTexture, woodMaterial } from './productMaterials'
import { resolveProductColor, resolveProductDetailColor } from './productColors'

export function buildFan(texture: THREE.Texture, appearance: ProductAppearance): THREE.Group {
  const group = new THREE.Group()
  const radius = 1.64
  const innerRadius = 0.60
  const halfAngle = 1.12
  const ribCount = 21
  const pivotY = -0.83
  const width = 2 * radius * Math.sin(halfAngle)
  const lowerY = innerRadius * Math.cos(halfAngle)
  const height = radius - lowerY
  const wood = woodMaterial(resolveProductDetailColor(appearance, '#9b754b'))
  const weave = weaveTexture(true)
  const paper = plainFabric(appearance, weave, true)
  const printed = printedMaterial(texture, appearance, width, height,
    { width: 1.48, height: 0.90, y: 0.12 }, 'silk', weave)
  const foldedPoint = (u: number, v: number) => {
    const angle = -halfAngle + u * halfAngle * 2
    const distance = innerRadius + v * (radius - innerRadius)
    const pleat = -Math.cos(u * (ribCount - 1) * Math.PI * 2)
    return new THREE.Vector3(
      Math.sin(angle) * distance,
      Math.cos(angle) * distance + pivotY,
      pleat * 0.033 * distance / radius,
    )
  }
  // Map the unfolded sector continuously, then retain hard normals at each radial paper fold.
  const fanGeometry = surfaceGeometry((ribCount - 1) * 2, 12, foldedPoint,
    position => new THREE.Vector2(position.x / width + 0.5, (position.y - pivotY - lowerY) / height)).toNonIndexed()
  fanGeometry.computeVertexNormals()
  group.add(mesh(fanGeometry, printed, 'product-print'))
  const backGeometry = fanGeometry.clone()
  backGeometry.translate(0, 0, -0.006)
  group.add(mesh(backGeometry, paper, 'fan-paper-back'))

  const ribs: THREE.BufferGeometry[] = []
  for (let index = 0; index < ribCount; index++) {
    const angle = -halfAngle + index / (ribCount - 1) * halfAngle * 2
    const guard = index === 0 || index === ribCount - 1
    const ribWidth = guard ? 0.050 : 0.026
    const rib = roundedPanel(ribWidth, radius - 0.025, 0.014, ribWidth * 0.35)
    rib.translate(0, (radius - 0.025) / 2, 0)
    const position = rib.getAttribute('position')
    const uv = rib.getAttribute('uv')
    for (let vertex = 0; vertex < position.count; vertex++) {
      const distance = position.getY(vertex)
      position.setZ(vertex, position.getZ(vertex) - 0.033 * distance / radius - 0.018)
      uv.setXY(vertex, position.getX(vertex) / ribWidth + 0.5, distance / radius * 2)
    }
    rib.rotateZ(-angle)
    rib.translate(0, pivotY, 0)
    rib.computeVertexNormals()
    ribs.push(rib)
  }
  const ribGeometry = mergeGeometries(ribs)!
  ribs.forEach(geometry => geometry.dispose())
  group.add(mesh(ribGeometry, wood, 'fan-ribs'))
  const brass = new THREE.MeshStandardMaterial({ color: '#9d8053', metalness: 0.78, roughness: 0.32 })
  const pin = mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.075, 32), brass, 'fan-pivot')
  pin.rotation.x = Math.PI / 2
  pin.position.set(0, pivotY + 0.018, -0.01)
  group.add(pin)
  for (const z of [-0.052, 0.032]) {
    const washer = mesh(new THREE.TorusGeometry(0.043, 0.005, 8, 32), brass)
    washer.position.set(0, pivotY + 0.018, z)
    group.add(washer)
  }
  return group
}

export function buildPhonecase(texture: THREE.Texture, appearance: ProductAppearance): THREE.Group {
  const group = new THREE.Group()
  const width = 1.16
  const height = 2.26
  const cameraX = -0.265
  const cameraY = 0.73
  const body = ceramicMaterial(resolveProductColor(appearance.color))
  const detail = ceramicMaterial(resolveProductDetailColor(appearance))
  // Bias steep trim faces behind the opaque back panel to prevent edge-on depth slivers.
  detail.polygonOffset = true
  detail.polygonOffsetFactor = 1
  detail.polygonOffsetUnits = 1
  for (const material of [body, detail]) {
    material.roughness = 0.48
    material.clearcoat = 0.12
    material.clearcoatRoughness = 0.3
  }
  const cameraOpening = () => new THREE.Path(roundedRect(0.45, 0.54, 0.115).getPoints(8)
    .map(point => point.add(new THREE.Vector2(cameraX, cameraY))))
  // Seat the back panel inside the bumper so differently colored side walls never overlap.
  const backShape = roundedRect(width - 0.024, height - 0.024, 0.152)
  backShape.holes.push(cameraOpening())
  const backing = new THREE.ExtrudeGeometry(backShape, {
    depth: 0.032, bevelEnabled: true, bevelSize: 0.005, bevelThickness: 0.005, bevelSegments: 3, curveSegments: 8,
  })
  backing.translate(0, 0, 0.075)
  group.add(mesh(backing, body, 'phonecase-back-shell'))

  const printShape = roundedRect(width - 0.024, height - 0.024, 0.152)
  printShape.holes.push(cameraOpening())
  const printGeometry = new THREE.ShapeGeometry(printShape, 8)
  const position = printGeometry.getAttribute('position')
  const uv = printGeometry.getAttribute('uv')
  for (let vertex = 0; vertex < position.count; vertex++) {
    uv.setXY(vertex, position.getX(vertex) / width + 0.5, position.getY(vertex) / height + 0.5)
  }
  printGeometry.translate(0, 0, 0.113)
  const printed = printedMaterial(texture, appearance, width, height,
    { width: 0.90, height: 1.28, y: -0.27 }, 'ceramic')
  printed.roughness = 0.48
  printed.clearcoat = 0.12
  printed.clearcoatRoughness = 0.3
  const backPrint = mesh(printGeometry, printed, 'product-print')
  // The solid shell casts the silhouette, avoiding a second shadow from its flush printed face.
  backPrint.castShadow = false
  group.add(backPrint)

  const rimShape = roundedRect(width, height, 0.16)
  rimShape.holes.push(new THREE.Path(roundedRect(width - 0.108, height - 0.108, 0.115).getPoints(8)))
  const rimGeometry = new THREE.ExtrudeGeometry(rimShape, {
    depth: 0.22, bevelEnabled: true, bevelSize: 0.005, bevelThickness: 0.005, bevelSegments: 3, curveSegments: 8,
  })
  rimGeometry.translate(0, 0, -0.115)
  group.add(mesh(rimGeometry, detail, 'phonecase-rim'))

  const guardShape = roundedRect(0.51, 0.60, 0.143)
  guardShape.holes.push(new THREE.Path(roundedRect(0.45, 0.54, 0.115).getPoints(8)))
  const guard = mesh(new THREE.ExtrudeGeometry(guardShape, {
    depth: 0.039, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 2, curveSegments: 8,
  }), detail, 'phonecase-camera-guard')
  guard.position.set(cameraX, cameraY, 0.111)
  group.add(guard)
  for (const [x, y, length] of [[-0.585, 0.39, 0.14], [-0.585, 0.17, 0.14], [0.585, 0.34, 0.27]]) {
    const button = mesh(roundedPanel(0.067, length, 0.018, 0.028), detail, 'phonecase-button')
    button.rotation.y = Math.PI / 2
    button.position.set(x, y, -0.012)
    group.add(button)
  }
  return group
}

export function buildPouch(texture: THREE.Texture, appearance: ProductAppearance): THREE.Group {
  const group = new THREE.Group()
  const weave = weaveTexture()
  const cloth = plainFabric(appearance, weave)
  const detail = plainFabric(appearance, weave, false, resolveProductDetailColor(appearance))
  const printed = printedMaterial(texture, appearance, 1.95, 1.28,
    { width: 1.28, height: 0.88 }, 'fabric', weave)
  const surface = (u: number, v: number, side: number) => {
    const x = u * 2 - 1
    const y = v * 2 - 1
    const fullness = Math.pow(Math.max(0, Math.sin(u * Math.PI) * Math.sin(v * Math.PI)), 0.72)
    const wrinkle = 0.011 * Math.sin(u * 26 + v * 5) * fullness * Math.pow(Math.abs(x), 3)
    return new THREE.Vector3(
      (u - 0.5) * (1.75 + 0.20 * v) * (1 - 0.045 * Math.pow(Math.abs(y), 10)),
      -0.64 + 1.28 * v - 0.055 * Math.pow(Math.abs(x), 10) * y,
      side * (0.10 + 0.16 * fullness + wrinkle),
    )
  }
  group.add(mesh(surfaceGeometry(64, 48, (u, v) => surface(u, v, 1)), printed, 'product-print'))
  group.add(mesh(surfaceGeometry(64, 48, (u, v) => surface(u, v, -1), undefined, true), cloth, 'pouch-back'))
  const boundaries = [
    (t: number) => surface(t, 0, 1),
    (t: number) => surface(1, t, 1),
    (t: number) => surface(1 - t, 1, 1),
    (t: number) => surface(0, 1 - t, 1),
  ]
  for (const boundary of boundaries) {
    group.add(mesh(surfaceGeometry(48, 8, (u, v) => {
      const point = boundary(u)
      return point.setZ(point.z * (v * 2 - 1))
    }), cloth, 'pouch-gusset'))
  }
  for (const side of [-1, 1]) {
    const outline: THREE.Vector3[] = []
    for (let index = 0; index < 32; index++) outline.push(surface(0.025 + index / 32 * 0.95, 0.025, side))
    for (let index = 0; index < 32; index++) outline.push(surface(0.975, 0.025 + index / 32 * 0.95, side))
    for (let index = 0; index < 32; index++) outline.push(surface(0.975 - index / 32 * 0.95, 0.975, side))
    for (let index = 0; index < 32; index++) outline.push(surface(0.025, 0.975 - index / 32 * 0.95, side))
    group.add(seam(outline.map(point => point.add(new THREE.Vector3(0, 0, side * 0.002))), detail, 0.003, true))
  }
  const zipperY = (x: number) => 0.64 - 0.055 * Math.pow(Math.abs(x / 0.931), 10)
  group.add(mesh(surfaceGeometry(64, 4, (u, v) => {
    const x = (u - 0.5) * 1.77
    return new THREE.Vector3(x, zipperY(x) + 0.005, (v - 0.5) * 0.112)
  }), detail, 'pouch-zipper-tape'))
  const metal = new THREE.MeshStandardMaterial({
    color: resolveProductDetailColor(appearance, '#8a7857'), metalness: 0.65, roughness: 0.38,
  })
  const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.020, 0.015, 0.027), metal, 72)
  teeth.name = 'pouch-zipper'
  teeth.castShadow = true
  teeth.receiveShadow = true
  const toothTransform = new THREE.Object3D()
  for (let index = 0; index < 72; index++) {
    const x = -0.80 + index / 71 * 1.60
    toothTransform.position.set(x, zipperY(x) + 0.016, index % 2 ? 0.010 : -0.010)
    toothTransform.updateMatrix()
    teeth.setMatrixAt(index, toothTransform.matrix)
  }
  teeth.instanceMatrix.needsUpdate = true
  group.add(teeth)
  const slider = mesh(roundedPanel(0.125, 0.084, 0.037, 0.025), metal, 'pouch-zipper-slider')
  slider.rotation.x = Math.PI / 2
  slider.position.set(0.63, zipperY(0.63) + 0.027, 0)
  group.add(slider)
  const pullShape = roundedRect(0.082, 0.15, 0.028)
  pullShape.holes.push(new THREE.Path(roundedRect(0.043, 0.091, 0.017).getPoints(12)))
  const pull = mesh(new THREE.ExtrudeGeometry(pullShape, {
    depth: 0.012, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 2, curveSegments: 12,
  }), metal, 'pouch-zipper-pull')
  pull.position.set(0.63, 0.53, 0.24)
  pull.rotation.x = -0.25
  group.add(pull)
  group.add(seam([
    new THREE.Vector3(0.63, 0.67, 0.026), new THREE.Vector3(0.63, 0.675, 0.095),
    new THREE.Vector3(0.63, 0.62, 0.19), new THREE.Vector3(0.63, 0.595, 0.23),
  ], metal, 0.008))
  for (const x of [-0.875, 0.875]) {
    const stop = mesh(roundedPanel(0.115, 0.09, 0.018, 0.022), detail, 'pouch-zipper-end-tab')
    stop.rotation.x = Math.PI / 2
    stop.position.set(x, zipperY(x) + 0.014, 0)
    group.add(stop)
  }
  return group
}
