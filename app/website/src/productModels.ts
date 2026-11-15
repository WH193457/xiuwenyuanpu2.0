import * as THREE from 'three'
import type { ProductAppearance, ProductCarrier } from './domain'
import { defaultProductAppearance } from './productCatalog'
import { ceramicMaterial, plainFabric, printedMaterial, weaveTexture, woodMaterial } from './productMaterials'
import { resolveProductColor, resolveProductDetailColor } from './productColors'
import { boundaryEdges, mesh, quadGeometry, refinePlanarGeometry, ribbon, roundedPanel, seam, surfaceGeometry } from './productGeometry'
import { buildTumbler, buildCoaster, buildBookmark } from './productEverydayModels'
import { buildFan, buildPhonecase, buildPouch } from './productAccessoryModels'

function lathe(points: number[][], height: number) {
  const curve = new THREE.SplineCurve(points.map(([radius, y]) => new THREE.Vector2(radius, y)))
  const profile = curve.getPoints(96).map(point => new THREE.Vector2(Math.max(0, point.x), point.y))
  const geometry = new THREE.LatheGeometry(profile, 96)
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  for (let index = 0; index < position.count; index++) uv.setY(index, THREE.MathUtils.clamp(position.getY(index) / height, 0, 1))
  geometry.rotateY(Math.PI)
  return geometry
}

function buildMug(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const height = 1.3
  const porcelain = ceramicMaterial(resolveProductColor(appearance.color))
  const detail = ceramicMaterial(resolveProductDetailColor(appearance))
  const outer = [[0, 0], [0.4, 0], [0.47, 0.035], [0.5, 0.15], [0.54, 0.7], [0.56, 1.23], [0.555, 1.3]]
  const inner = [[0.515, 1.3], [0.505, 1.24], [0.48, 0.25], [0.43, 0.16], [0, 0.16]]
  const print = printedMaterial(texture, appearance, 2 * Math.PI * 0.54, height,
    { width: 0.98, height: 0.89, y: 0.01 }, 'ceramic')
  group.add(mesh(lathe(outer, height), print, 'product-print'), mesh(lathe(inner, height), detail, 'mug-inner'))
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.52, 1.07, 0), new THREE.Vector3(0.83, 1.08, 0),
    new THREE.Vector3(0.98, 0.78, 0), new THREE.Vector3(0.88, 0.42, 0), new THREE.Vector3(0.51, 0.35, 0),
  ])
  const handle = mesh(new THREE.TubeGeometry(curve, 64, 0.067, 16, false), detail, 'mug-handle')
  const rim = mesh(new THREE.TorusGeometry(0.535, 0.021, 16, 96), detail, 'mug-rim')
  rim.rotation.x = Math.PI / 2
  rim.position.y = height
  for (const [x, y] of [[0.535, 1.07], [0.51, 0.35]]) {
    const join = mesh(new THREE.SphereGeometry(0.087, 24, 16), detail, 'mug-handle-join')
    join.scale.set(0.72, 1.3, 1.05)
    join.position.set(x, y, 0)
    group.add(join)
  }
  const foot = mesh(new THREE.TorusGeometry(0.415, 0.018, 8, 64), porcelain)
  foot.rotation.x = Math.PI / 2
  foot.position.y = 0.015
  group.add(handle, rim, foot)
  group.position.y = -height / 2
  return group
}

function buildVase(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const height = 2.1
  const porcelain = ceramicMaterial(resolveProductColor(appearance.color))
  const detail = ceramicMaterial(resolveProductDetailColor(appearance))
  const outer = [[0, 0], [0.34, 0], [0.5, 0.09], [0.64, 0.38], [0.71, 0.81], [0.66, 1.15], [0.46, 1.5], [0.27, 1.81], [0.25, 2.06], [0.28, 2.1]]
  const inner = [[0.235, 2.1], [0.21, 2.03], [0.23, 1.81], [0.42, 1.5], [0.6, 1.1], [0.65, 0.8], [0.58, 0.4], [0.4, 0.13], [0, 0.13]]
  group.add(
    mesh(lathe(outer, height), printedMaterial(texture, appearance, 2 * Math.PI * 0.65, height,
      { width: 1.15, height: 1.15, y: -0.15 }, 'ceramic'), 'product-print'),
    mesh(lathe(inner, height), detail, 'vase-inner'),
  )
  const rim = mesh(new THREE.TorusGeometry(0.2575, 0.023, 16, 96), detail, 'vase-rim')
  rim.rotation.x = Math.PI / 2
  rim.position.y = height
  const foot = mesh(new THREE.TorusGeometry(0.36, 0.023, 8, 64), porcelain)
  foot.rotation.x = Math.PI / 2
  foot.position.y = 0.022
  group.add(foot, rim)
  group.position.y = -1.05
  return group
}

function buildTote(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const weave = weaveTexture()
  const cloth = plainFabric(appearance, weave)
  const detail = plainFabric(appearance, weave, false, resolveProductDetailColor(appearance))
  const liningColor = new THREE.Color(resolveProductColor(appearance.color)).multiplyScalar(0.76)
  const lining = plainFabric(appearance, weave, false, `#${liningColor.getHexString()}`)
  const printed = printedMaterial(texture, appearance, 1.55, 1.67, { width: 1.08, height: 1.1, y: -0.02 }, 'fabric', weave)
  const surface = (u: number, v: number, side: number, inset = 0) => {
    const across = Math.sin(Math.PI * u)
    const vertical = Math.sin(Math.PI * v)
    const x = (u - 0.5) * (1.39 + 0.16 * v) + 0.012 * Math.sin(v * 7) * across
    const sag = 0.135 * Math.pow(across, 2) * Math.pow(v, 7)
    const y = -0.87 + 1.67 * v + 0.05 * Math.pow(Math.abs(u - 0.5) * 2, 8) - sag
    const fullness = 0.16 * Math.pow(Math.max(0, across * vertical), 0.9)
    const gathers = 0.025 * Math.sin(u * 27 + v * 3) * vertical * (0.3 + 0.7 * Math.pow(Math.abs(u - 0.5) * 2, 2))
    const cornerFold = -0.035 * Math.exp(-Math.pow((u - 0.13) / 0.07, 2) - Math.pow((v - 0.13) / 0.18, 2))
      - 0.035 * Math.exp(-Math.pow((u - 0.87) / 0.07, 2) - Math.pow((v - 0.13) / 0.18, 2))
    const opening = 0.095 + 0.055 * Math.pow(v, 4) + 0.02 * Math.sin(u * Math.PI * 3) * Math.pow(v, 5)
    return new THREE.Vector3(x, y, side * (opening + fullness + gathers + cornerFold - inset))
  }
  group.add(mesh(surfaceGeometry(56, 64, (u, v) => surface(u, v, 1)), printed, 'product-print'))
  group.add(mesh(surfaceGeometry(56, 64, (u, v) => surface(u, v, -1), undefined, true), cloth, 'tote-back'))
  for (const side of [-1, 1]) {
    group.add(mesh(surfaceGeometry(48, 56, (u, v) => surface(u, v, side, 0.014), undefined, side > 0), lining, 'tote-lining'))
    const facing = mesh(surfaceGeometry(48, 8, (u, v) => surface(u, 0.935 + v * 0.065, side).add(new THREE.Vector3(0, 0, side * 0.002))), detail, 'tote-binding')
    group.add(facing)
    group.add(mesh(surfaceGeometry(48, 4, (u, v) => surface(u, 1, side, v * 0.014)), detail, 'tote-opening-fold'))
    const hem = Array.from({ length: 33 }, (_, index) => surface(index / 32, 0.94, side).add(new THREE.Vector3(0, 0, side * 0.004)))
    group.add(seam(hem, detail, 0.003))
    const strap = new THREE.CatmullRomCurve3([
      surface(0.22, 0.88, side).add(new THREE.Vector3(0, 0, side * 0.012)),
      new THREE.Vector3(-0.41, 1.06, side * 0.16),
      new THREE.Vector3(-0.28, 1.4, side * 0.10),
      new THREE.Vector3(0.08, 1.51, side * 0.07),
      new THREE.Vector3(0.36, 1.18, side * 0.12),
      surface(0.78, 0.88, side).add(new THREE.Vector3(0, 0, side * 0.012)),
    ])
    const handle = ribbon(strap, 0.078, 0.012, detail)
    handle.name = 'tote-handle'
    group.add(handle)
    for (const u of [0.22, 0.78]) {
      const center = surface(u, 0.89, side)
      const patch = mesh(roundedPanel(0.104, 0.16, 0.006, 0.012), detail, 'tote-handle-tab')
      patch.position.copy(center).add(new THREE.Vector3(0, 0, side * 0.013))
      group.add(patch)
      for (const diagonal of [-1, 1]) {
        group.add(seam([
          center.clone().add(new THREE.Vector3(-0.035, -0.05 * diagonal, side * 0.027)),
          center.clone().add(new THREE.Vector3(0.035, 0.05 * diagonal, side * 0.027)),
        ], cloth, 0.002))
      }
    }
  }
  for (const side of [0, 1]) {
    group.add(mesh(surfaceGeometry(12, 56, (u, v) => {
      const front = surface(side, v, 1)
      front.x += (side === 0 ? 1 : -1) * 0.035 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI)
      return front.setZ(front.z * (u * 2 - 1))
    }), cloth, 'tote-gusset'))
  }
  group.add(mesh(surfaceGeometry(48, 8, (u, v) => {
    const front = surface(u, 0, 1)
    return front.setZ(front.z * (v * 2 - 1))
  }), lining, 'tote-bottom'))
  for (const u of [0.035, 0.965]) {
    group.add(seam(Array.from({ length: 32 }, (_, index) => surface(u, index / 31, 1).add(new THREE.Vector3(0, 0, 0.003))), cloth, 0.003))
  }
  return group
}

function buildTee(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const weave = weaveTexture()
  const cloth = plainFabric(appearance, weave)
  const detail = plainFabric(appearance, weave, false, resolveProductDetailColor(appearance))
  const innerColor = new THREE.Color(resolveProductColor(appearance.color)).multiplyScalar(0.82)
  const innerCloth = plainFabric(appearance, weave, false, `#${innerColor.getHexString()}`)
  const printed = printedMaterial(texture, appearance, 2.38, 2.04, { width: 0.84, height: 0.86, y: 0.12 }, 'fabric', weave)
  const outline = new THREE.Shape()
  outline.moveTo(-0.52, -1)
  outline.lineTo(0.52, -1)
  outline.quadraticCurveTo(0.58, -0.98, 0.57, -0.7)
  outline.lineTo(0.58, 0.30)
  outline.quadraticCurveTo(0.65, 0.27, 0.72, 0.23)
  outline.lineTo(0.92, 0.10)
  outline.quadraticCurveTo(0.96, 0.08, 0.99, 0.13)
  outline.lineTo(1.16, 0.49)
  outline.quadraticCurveTo(1.18, 0.53, 1.13, 0.57)
  outline.lineTo(0.78, 0.84)
  outline.quadraticCurveTo(0.66, 0.94, 0.35, 0.99)
  outline.lineTo(0.25, 0.99)
  outline.bezierCurveTo(0.23, 0.80, 0.18, 0.73, 0, 0.73)
  outline.bezierCurveTo(-0.18, 0.73, -0.23, 0.80, -0.25, 0.99)
  outline.lineTo(-0.35, 0.99)
  outline.quadraticCurveTo(-0.66, 0.94, -0.78, 0.84)
  outline.lineTo(-1.13, 0.57)
  outline.quadraticCurveTo(-1.18, 0.53, -1.16, 0.49)
  outline.lineTo(-0.99, 0.13)
  outline.quadraticCurveTo(-0.96, 0.08, -0.92, 0.10)
  outline.lineTo(-0.72, 0.23)
  outline.quadraticCurveTo(-0.65, 0.27, -0.58, 0.30)
  outline.lineTo(-0.57, -0.7)
  outline.quadraticCurveTo(-0.58, -0.98, -0.52, -1)
  outline.closePath()
  const depth = (x: number, y: number) => {
    const vertical = Math.max(0, Math.sin((y + 1) / 1.99 * Math.PI))
    const torso = 0.125 * Math.exp(-Math.pow((x - 0.016 * Math.sin(y * 3)) / 0.48, 4)) * vertical
    const sleeve = 0.075 * Math.exp(-((Math.abs(x) - 0.8) ** 2 / 0.12 + (y - 0.48) ** 2 / 0.12))
    const underarm = 0.018 * Math.sin((Math.abs(x) - 0.46 + 0.18 * (0.25 - y)) * 30)
      * Math.exp(-((Math.abs(x) - 0.46) ** 2 / 0.035 + (y - 0.08) ** 2 / 0.14))
    const lowerDrape = 0.017 * Math.sin(x * 17 + y * 1.6) * Math.exp(-((y + 0.65) ** 2 / 0.16)) * vertical
    return 0.035 + torso + sleeve + underarm + lowerDrape
  }

  const point = (x: number, y: number, side: number, inset = 0) => {
    const hemDrape = 0.038 * x * THREE.MathUtils.smoothstep(-y, 0.45, 0.9)
    return new THREE.Vector3(x, y + hemDrape, side * (depth(x, y) - inset))
  }
  const original = new THREE.ShapeGeometry(outline, 8)
  const base = refinePlanarGeometry(original, 0.045)
  original.dispose()
  // A separate back-neck outline preserves stable triangles without stretching
  // the slender front-neck triangles through a nonlinear XY deformation.
  const backOutline = outline.clone()
  for (const curve of backOutline.curves) {
    if (curve instanceof THREE.CubicBezierCurve) {
      for (const control of [curve.v0, curve.v1, curve.v2, curve.v3]) control.y = 0.99 - (0.99 - control.y) * 0.3
    }
  }
  const backOriginal = new THREE.ShapeGeometry(backOutline, 8)
  const backBase = refinePlanarGeometry(backOriginal, 0.045)
  backOriginal.dispose()
  for (const side of [1, -1]) {
    for (const inside of [false, true]) {
      const geometry = (side === 1 ? base : backBase).clone()
      const positions = geometry.getAttribute('position')
      const uv = geometry.getAttribute('uv')
      const normals = new Float32Array(positions.count * 3)
      const facing = side * (inside ? -1 : 1)
      for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index)
        const y = positions.getY(index)
        const position = point(x, y, side, inside ? 0.008 : 0)
        positions.setXYZ(index, position.x, position.y, position.z)
        uv.setXY(index, (x + 1.19) / 2.38, (y + 1) / 2.04)
        const dx = point(x + 0.002, y, side).sub(point(x - 0.002, y, side))
        const dy = point(x, y + 0.002, side).sub(point(x, y - 0.002, side))
        normals.set(dx.cross(dy).normalize().multiplyScalar(facing).toArray(), index * 3)
      }
      if (facing < 0) {
        const indices = geometry.getIndex()!
        for (let index = 0; index < indices.count; index += 3) {
          const first = indices.getX(index)
          indices.setX(index, indices.getX(index + 2))
          indices.setX(index + 2, first)
        }
      }
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
      const surface = mesh(geometry, inside ? innerCloth : side === 1 ? printed : cloth,
        inside ? 'shirt-inner' : side === 1 ? 'product-print' : 'shirt-back')
      surface.castShadow = !inside
      group.add(surface)
    }
  }
  const positions = base.getAttribute('position')
  const edges = boundaryEdges(base)
  const outwardDirections = new Map<number, THREE.Vector2>()
  for (const [a, b] of edges) {
    const tangent = new THREE.Vector2(positions.getX(b) - positions.getX(a), positions.getY(b) - positions.getY(a)).normalize()
    const outward = new THREE.Vector2(tangent.y, -tangent.x)
    for (const vertex of [a, b]) {
      const direction = outwardDirections.get(vertex) ?? new THREE.Vector2()
      outwardDirections.set(vertex, direction.add(outward))
    }
  }
  outwardDirections.forEach(direction => direction.normalize())
  const closedWalls: THREE.Vector3[][] = []
  const closedWallNormals: number[] = []
  const openingEdges: THREE.Vector3[][] = []
  const collarBands: THREE.Vector3[][] = []
  const cuffBands: THREE.Vector3[][] = []
  const hemBands: THREE.Vector3[][] = []
  for (const [a, b] of edges) {
    const start = new THREE.Vector2(positions.getX(a), positions.getY(a))
    const end = new THREE.Vector2(positions.getX(b), positions.getY(b))
    const center = start.clone().add(end).multiplyScalar(0.5)
    const isNeck = Math.abs(center.x) < 0.251 && center.y > 0.72
    const isCuff = Math.abs(center.x) > 0.975 && center.y > 0.115 && center.y < 0.535
    const isHem = center.y < -0.985
    if (!isNeck && !isCuff && !isHem) {
      const edgeRadius = (position: THREE.Vector2) => {
        const underarmPinch = Math.exp(-((Math.abs(position.x) - 0.60) ** 2 / 0.007 + (position.y - 0.29) ** 2 / 0.01))
        return depth(position.x, position.y) * 0.65 * (1 - 0.97 * underarmPinch)
      }
      const rounded = (position: THREE.Vector2, vertex: number, u: number) => {
        const outward = outwardDirections.get(vertex)!
        const radius = edgeRadius(position)
        return point(position.x, position.y, 1).lerp(point(position.x, position.y, -1), (1 - Math.cos(u * Math.PI)) / 2)
          .add(new THREE.Vector3(outward.x, outward.y, 0).multiplyScalar(Math.sin(u * Math.PI) * radius))
      }
      const normal = (position: THREE.Vector2, vertex: number, u: number) => {
        const outward = outwardDirections.get(vertex)!
        const side = u <= 0.5 ? 1 : -1
        const dx = point(position.x + 0.002, position.y, side).sub(point(position.x - 0.002, position.y, side))
        const dy = point(position.x, position.y + 0.002, side).sub(point(position.x, position.y - 0.002, side))
        return dx.cross(dy).normalize().multiplyScalar(side * Math.abs(Math.cos(u * Math.PI)) / depth(position.x, position.y))
          .add(new THREE.Vector3(outward.x, outward.y, 0).multiplyScalar(Math.sin(u * Math.PI) / edgeRadius(position))).normalize()
      }
      for (let step = 0; step < 8; step++) {
        const u = step / 8
        const v = (step + 1) / 8
        closedWalls.push([rounded(start, a, u), rounded(end, b, u), rounded(end, b, v), rounded(start, a, v)])
        for (const value of [normal(start, a, u), normal(end, b, u), normal(end, b, v), normal(start, a, v)]) closedWallNormals.push(...value.toArray())
      }
      continue
    }
    const bandWidth = isNeck ? 0.032 : 0.023
    const startInner = start.clone().addScaledVector(outwardDirections.get(a)!, -bandWidth)
    const endInner = end.clone().addScaledVector(outwardDirections.get(b)!, -bandWidth)
    const bands = isNeck ? collarBands : isCuff ? cuffBands : hemBands
    for (const side of [-1, 1]) {
      if (isNeck && side < 0) continue
      bands.push([
        point(start.x, start.y, side, -0.003), point(end.x, end.y, side, -0.003),
        point(endInner.x, endInner.y, side, -0.003),
        point(startInner.x, startInner.y, side, -0.003),
      ])
      openingEdges.push([
        point(start.x, start.y, side), point(end.x, end.y, side),
        point(end.x, end.y, side, 0.008), point(start.x, start.y, side, 0.008),
      ])
    }
  }
  const backPositions = backBase.getAttribute('position')
  const backNeckEdges = boundaryEdges(backBase).filter(([a, b]) =>
    Math.abs((backPositions.getX(a) + backPositions.getX(b)) / 2) < 0.251
      && (backPositions.getY(a) + backPositions.getY(b)) / 2 > 0.9)
  const backDirections = new Map<number, THREE.Vector2>()
  for (const [a, b] of backNeckEdges) {
    const tangent = new THREE.Vector2(backPositions.getX(b) - backPositions.getX(a), backPositions.getY(b) - backPositions.getY(a)).normalize()
    for (const vertex of [a, b]) {
      const direction = backDirections.get(vertex) ?? new THREE.Vector2()
      backDirections.set(vertex, direction.add(new THREE.Vector2(-tangent.y, tangent.x)))
    }
  }
  backDirections.forEach(direction => direction.normalize().multiplyScalar(0.032))
  for (const [a, b] of backNeckEdges) {
    const start = new THREE.Vector2(backPositions.getX(a), backPositions.getY(a))
    const end = new THREE.Vector2(backPositions.getX(b), backPositions.getY(b))
    const startInner = start.clone().add(backDirections.get(a)!)
    const endInner = end.clone().add(backDirections.get(b)!)
    collarBands.push([
      point(start.x, start.y, -1, -0.003), point(end.x, end.y, -1, -0.003),
      point(endInner.x, endInner.y, -1, -0.003), point(startInner.x, startInner.y, -1, -0.003),
    ])
    openingEdges.push([
      point(start.x, start.y, -1), point(end.x, end.y, -1),
      point(end.x, end.y, -1, 0.008), point(start.x, start.y, -1, 0.008),
    ])
  }
  base.dispose()
  backBase.dispose()
  const sewnSides = quadGeometry(closedWalls)
  const sideIndices = sewnSides.getIndex()!
  for (let index = 0; index < sideIndices.count; index += 3) {
    const first = sideIndices.getX(index)
    sideIndices.setX(index, sideIndices.getX(index + 2))
    sideIndices.setX(index + 2, first)
  }
  sewnSides.setAttribute('normal', new THREE.Float32BufferAttribute(closedWallNormals, 3))
  group.add(
    mesh(sewnSides, cloth, 'shirt-sewn-sides'),
    mesh(quadGeometry(openingEdges), cloth, 'shirt-open-edge-thickness'),
    mesh(quadGeometry(collarBands), detail, 'shirt-collar'),
    mesh(quadGeometry(cuffBands), detail, 'shirt-cuffs'),
    mesh(quadGeometry(hemBands), cloth, 'shirt-hem'),
  )
  for (const side of [-1, 1]) {
    group.add(seam(Array.from({ length: 40 }, (_, index) => {
      const x = -0.51 + index / 39 * 1.02
      return point(x, -0.96, side, -0.004)
    }), cloth, 0.0025))
  }
  return group
}

function buildCushion(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const weave = weaveTexture()
  const cloth = plainFabric(appearance, weave)
  const detail = plainFabric(appearance, weave, false, resolveProductDetailColor(appearance))
  const printed = printedMaterial(texture, appearance, 1.8, 1.8, { width: 1.5, height: 1.5 }, 'fabric', weave)
  const surface = (u: number, v: number, side: number) => {
    const x = u * 2 - 1
    const y = v * 2 - 1
    const fullness = Math.pow(Math.max(0, (1 - x * x) * (1 - y * y)), 0.63)
    const wrinkle = 0.012 * Math.sin(x * 42 + y * 6) * Math.pow(Math.abs(y), 6) * Math.sin(u * Math.PI)
    return new THREE.Vector3(0.9 * x * (1 - 0.045 * Math.pow(y, 10)), 0.9 * y * (1 - 0.045 * Math.pow(x, 10)), side * (0.025 + 0.29 * fullness + wrinkle))
  }
  group.add(mesh(surfaceGeometry(64, 64, (u, v) => surface(u, v, 1)), printed, 'product-print'))
  group.add(mesh(surfaceGeometry(64, 64, (u, v) => surface(u, v, -1), undefined, true), cloth))
  const outline: THREE.Vector3[] = []
  for (let index = 0; index < 32; index++) outline.push(surface(index / 32, 0, 0))
  for (let index = 0; index < 32; index++) outline.push(surface(1, index / 32, 0))
  for (let index = 0; index < 32; index++) outline.push(surface(1 - index / 32, 1, 0))
  for (let index = 0; index < 32; index++) outline.push(surface(0, 1 - index / 32, 0))
  const piping = seam(outline, detail, 0.028, true)
  piping.name = 'cushion-piping'
  group.add(piping)
  for (const side of [-1, 1]) {
    const stitch = outline.map(point => {
      const u = (point.x * 0.97 / 0.9 + 1) / 2
      const v = (point.y * 0.97 / 0.9 + 1) / 2
      return surface(u, v, side).add(new THREE.Vector3(0, 0, side * 0.002))
    })
    group.add(seam(stitch, cloth, 0.002, true))
  }
  const zipper = seam(Array.from({ length: 25 }, (_, index) => surface(0.26 + index / 24 * 0.48, 0.025, -1)), cloth, 0.005)
  zipper.name = 'cushion-hidden-zipper'
  const pull = mesh(new THREE.TorusGeometry(0.016, 0.003, 6, 16), new THREE.MeshStandardMaterial({ color: 0x9a9689, metalness: 0.7, roughness: 0.4 }))
  pull.scale.y = 1.8
  pull.position.copy(surface(0.73, 0.025, -1)).add(new THREE.Vector3(0, -0.018, -0.006))
  group.add(zipper, pull)
  return group
}

function buildScarf(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const weave = weaveTexture(true)
  const printed = printedMaterial(texture, appearance, 1.55, 2.18, { width: 0.75, height: 0.75 }, 'silk', weave)
  const cloth = plainFabric(appearance, weave, true, resolveProductDetailColor(appearance))
  const surface = (u: number, v: number) => {
    const fall = 1 - v
    return new THREE.Vector3(
      (u - 0.5) * (1.5 + 0.06 * fall) + 0.025 * Math.sin(fall * 5),
      -1.09 + v * 2.18 + 0.08 * Math.sin(u * Math.PI * 2) * Math.pow(fall, 2),
      0.115 * Math.sin(u * Math.PI * 5 + fall * 0.65) * (0.35 + 0.65 * fall) + 0.023 * Math.sin(v * 12 + u * 2),
    )
  }
  group.add(mesh(surfaceGeometry(80, 96, surface), printed, 'product-print'))
  for (const u of [0.012, 0.988]) {
    const hem = seam(Array.from({ length: 32 }, (_, index) => surface(u, index / 31)), cloth, 0.006)
    hem.name = 'scarf-rolled-hem'
    group.add(hem)
  }
  for (const v of [0.01, 0.99]) {
    const hem = seam(Array.from({ length: 32 }, (_, index) => surface(index / 31, v)), cloth, 0.006)
    hem.name = 'scarf-rolled-hem'
    group.add(hem)
  }
  const rail = mesh(new THREE.CylinderGeometry(0.019, 0.019, 1.67, 12), new THREE.MeshStandardMaterial({ color: 0x8d7852, roughness: 0.32, metalness: 0.7 }))
  rail.rotation.z = Math.PI / 2
  rail.position.set(0, 1.1, 0.018)
  group.add(rail)
  return group
}

function buildNotebook(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const weave = weaveTexture()
  const coverMaterial = plainFabric(appearance, weave)
  const detail = plainFabric(appearance, weave, false, resolveProductDetailColor(appearance))
  const printed = printedMaterial(texture, appearance, 1.45, 1.95, { width: 1.05, height: 1.4 }, 'fabric', weave)
  const coverGeometry = roundedPanel(1.45, 1.95, 0.035, 0.055)
  const positions = coverGeometry.getAttribute('position')
  const uv = coverGeometry.getAttribute('uv')
  for (let index = 0; index < positions.count; index++) uv.setXY(index, (positions.getX(index) + 0.725) / 1.45, (positions.getY(index) + 0.975) / 1.95)
  const front = mesh(coverGeometry, printed, 'product-print')
  front.position.z = 0.145
  const back = mesh(roundedPanel(1.45, 1.95, 0.035, 0.055), coverMaterial, 'notebook-back')
  back.position.z = -0.145
  const paperMaterial = new THREE.MeshStandardMaterial({ color: 0xf4efde, roughness: 0.96 })
  const pages = mesh(roundedPanel(1.33, 1.82, 0.225, 0.018), paperMaterial, 'notebook-pages')
  pages.position.x = 0.026
  const spine = mesh(surfaceGeometry(32, 32, (u, v) => new THREE.Vector3(
    -0.68 - 0.07 * Math.sin(Math.PI * u), -0.972 + v * 1.944, 0.151 * Math.cos(Math.PI * u),
  )), detail, 'notebook-spine')
  group.add(front, back, pages, spine)
  const pageLine = new THREE.MeshStandardMaterial({ color: 0xccc4b2, roughness: 1 })
  for (let index = 0; index < 23; index++) {
    const z = -0.108 + index * 0.0098
    const line = mesh(new THREE.BoxGeometry(0.0015, 1.77, 0.0008), pageLine)
    line.position.set(0.699, 0, z)
    group.add(line)
    for (const side of [-1, 1]) {
      const top = mesh(new THREE.BoxGeometry(1.27, 0.0015, 0.0008), pageLine)
      top.position.set(0.026, side * 0.919, z)
      group.add(top)
    }
  }
  for (const side of [-1, 1]) {
    const hinge = seam([new THREE.Vector3(-0.618, -0.92, side * 0.173), new THREE.Vector3(-0.618, 0.92, side * 0.173)], detail, 0.003)
    group.add(hinge)
    const headband = seam(Array.from({ length: 15 }, (_, index) => new THREE.Vector3(-0.635 - 0.023 * Math.sin(index / 14 * Math.PI), side * 0.922, -0.107 + index / 14 * 0.214)), detail, 0.007)
    group.add(headband)
  }
  const elasticMaterial = plainFabric(appearance, weave, false, resolveProductDetailColor(appearance, '#444b43'))
  const elasticPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.56, -0.96, 0.18), new THREE.Vector3(0.56, 0.96, 0.18),
    new THREE.Vector3(0.56, 0.994, 0.14), new THREE.Vector3(0.56, 0.994, -0.14),
    new THREE.Vector3(0.56, 0.96, -0.18), new THREE.Vector3(0.56, -0.96, -0.18),
    new THREE.Vector3(0.56, -0.994, -0.14), new THREE.Vector3(0.56, -0.994, 0.14),
  ], true, 'catmullrom', 0.05)
  const elastic = mesh(surfaceGeometry(4, 128, (u, v) => elasticPath.getPoint(v).add(new THREE.Vector3((u - 0.5) * 0.043, 0, 0))), elasticMaterial, 'notebook-elastic')
  const bookmark = mesh(surfaceGeometry(8, 20, (u, v) => new THREE.Vector3(
    -0.44 + u * 0.068, -1.13 + v * 0.34 + 0.024 * (1 - Math.abs(2 * u - 1)) * Math.pow(1 - v, 12),
    0.015 + 0.018 * Math.sin(v * Math.PI),
  )), plainFabric(appearance, weave, false, resolveProductDetailColor(appearance, '#b59a61')), 'notebook-bookmark')
  group.add(elastic, bookmark)
  return group
}

function buildPoster(texture: THREE.Texture, appearance: ProductAppearance) {
  const group = new THREE.Group()
  const frameMaterial = woodMaterial(resolveProductDetailColor(appearance, '#654c37'))
  const backingMaterial = new THREE.MeshStandardMaterial({ color: 0x8a7964, roughness: 0.96 })
  const back = mesh(roundedPanel(1.75, 2.25, 0.04, 0.018), backingMaterial, 'poster-back')
  const board = mesh(new THREE.PlaneGeometry(1.58, 2.08), printedMaterial(texture, appearance, 1.58, 2.08,
    { width: 1.35, height: 1.82 }, 'paper'), 'product-print')
  board.position.z = 0.034
  group.add(back, board)
  const outer = [new THREE.Vector2(-0.89, -1.14), new THREE.Vector2(0.89, -1.14), new THREE.Vector2(0.89, 1.14), new THREE.Vector2(-0.89, 1.14)]
  const inner = [new THREE.Vector2(-0.785, -1.035), new THREE.Vector2(0.785, -1.035), new THREE.Vector2(0.785, 1.035), new THREE.Vector2(-0.785, 1.035)]
  for (let edge = 0; edge < 4; edge++) {
    const next = (edge + 1) % 4
    const shape = new THREE.Shape([outer[edge], outer[next], inner[next], inner[edge]])
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 3, curveSegments: 1 })
    const position = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    for (let vertex = 0; vertex < position.count; vertex++) {
      uv.setXY(vertex, edge % 2 === 0 ? position.getY(vertex) : position.getX(vertex), edge % 2 === 0 ? position.getX(vertex) : position.getY(vertex))
    }
    geometry.translate(0, 0, 0.018)
    group.add(mesh(geometry, frameMaterial, 'poster-frame'))
  }
  const stand = mesh(roundedPanel(0.18, 0.87, 0.035, 0.018), frameMaterial, 'poster-stand')
  stand.position.set(0, -0.64, -0.28)
  stand.rotation.x = 0.48
  const hinge = mesh(new THREE.BoxGeometry(0.12, 0.055, 0.018), new THREE.MeshStandardMaterial({ color: 0x918470, metalness: 0.75, roughness: 0.4 }))
  hinge.position.set(0, -0.24, -0.062)
  group.add(stand, hinge)
  return group
}

const builders: Record<ProductCarrier, (texture: THREE.Texture, appearance: ProductAppearance) => THREE.Group> = {
  mug: buildMug, vase: buildVase, tote: buildTote, tee: buildTee,
  cushion: buildCushion, scarf: buildScarf, notebook: buildNotebook, poster: buildPoster,
  tumbler: buildTumbler, coaster: buildCoaster, bookmark: buildBookmark,
  fan: buildFan, phonecase: buildPhonecase, pouch: buildPouch,
}

export function buildProduct(kind: ProductCarrier, texture: THREE.Texture, appearance = defaultProductAppearance(kind)) {
  const group = builders[kind](texture, appearance)
  group.userData.carrier = kind
  group.userData.appearance = { ...appearance }
  return group
}

export function prepareProductTexture(texture: THREE.Texture, _carrier: ProductCarrier) {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.anisotropy = 8
  texture.rotation = 0
  texture.center.set(0.5, 0.5)
  texture.repeat.set(1, 1)
  texture.offset.set(0, 0)
  texture.needsUpdate = true
  return texture
}

export function addProductStudio(scene: THREE.Scene, groundY = -1) {
  scene.background = new THREE.Color('#e6e5df')
  const hemisphere = new THREE.HemisphereLight(0xfffcf7, 0x777e7c, 0.4)
  const key = new THREE.DirectionalLight(0xfff5e9, 1.8)
  key.position.set(-3.5, 6, 4)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = key.shadow.camera.bottom = -3
  key.shadow.camera.right = key.shadow.camera.top = 3
  key.shadow.normalBias = 0.018
  key.shadow.bias = -0.0002
  const fill = new THREE.DirectionalLight(0xdce9f0, 0.35)
  fill.position.set(4, 2, 3)
  const rim = new THREE.DirectionalLight(0xffe4c1, 0.55)
  rim.position.set(1.5, 4, -3)
  scene.add(hemisphere, key, fill, rim)
  const ground = mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0xd6d5ce, roughness: 0.95 }))
  ground.castShadow = false
  ground.rotation.x = -Math.PI / 2
  ground.position.y = groundY - 0.012
  scene.add(ground)
  return { key, ground }
}
