import * as THREE from 'three'

/** Shared-edge refinement keeps a curved garment continuous across its original triangulation. */
export function refinePlanarGeometry(source: THREE.BufferGeometry, maxEdge = 0.065) {
  const positions = Array.from(source.getAttribute('position').array)
  let triangles = Array.from(source.getIndex()!.array)
  const maxSquared = maxEdge * maxEdge
  for (let iteration = 0; iteration < 16; iteration++) {
    const midpoints = new Map<string, number>()
    const midpoint = (a: number, b: number) => {
      const dx = positions[a * 3] - positions[b * 3]
      const dy = positions[a * 3 + 1] - positions[b * 3 + 1]
      if (dx * dx + dy * dy <= maxSquared) return -1
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      const saved = midpoints.get(key)
      if (saved !== undefined) return saved
      const index = positions.length / 3
      positions.push((positions[a * 3] + positions[b * 3]) / 2, (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2, 0)
      midpoints.set(key, index)
      return index
    }
    const next: number[] = []
    let changed = false
    for (let index = 0; index < triangles.length; index += 3) {
      const a = triangles[index]
      const b = triangles[index + 1]
      const c = triangles[index + 2]
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      const mask = Number(ab >= 0) + Number(bc >= 0) * 2 + Number(ca >= 0) * 4
      changed ||= mask > 0
      switch (mask) {
        case 0: next.push(a, b, c); break
        case 1: next.push(a, ab, c, ab, b, c); break
        case 2: next.push(b, bc, a, bc, c, a); break
        case 4: next.push(c, ca, b, ca, a, b); break
        case 3: next.push(b, bc, ab, a, ab, c, ab, bc, c); break
        case 6: next.push(c, ca, bc, b, bc, a, bc, ca, a); break
        case 5: next.push(a, ab, ca, c, ca, b, ca, ab, b); break
        case 7: next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca); break
      }
    }
    triangles = next
    if (!changed) break
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2))
  geometry.setIndex(triangles)
  return geometry
}

export function surfaceGeometry(
  columns: number, rows: number,
  point: (u: number, v: number) => THREE.Vector3,
  uv: (position: THREE.Vector3, u: number, v: number) => THREE.Vector2 = (_position, u, v) => new THREE.Vector2(u, v),
  reverse = false,
) {
  const positions: number[] = []
  const coordinates: number[] = []
  const indices: number[] = []
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const u = column / columns
    const v = row / rows
    const position = point(u, v)
    const coordinate = uv(position, u, v)
    positions.push(position.x, position.y, position.z)
    coordinates.push(coordinate.x, coordinate.y)
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const a = row * (columns + 1) + column
    const b = a + 1
    const c = a + columns + 1
    const d = c + 1
    if (reverse) indices.push(a, c, b, b, c, d)
    else indices.push(a, b, c, b, d, c)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(coordinates, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, name = '') {
  const value = new THREE.Mesh(geometry, material)
  value.name = name
  value.castShadow = true
  value.receiveShadow = true
  return value
}

/** Directed boundary edges follow the same winding as the indexed source surface. */
export function boundaryEdges(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex()!
  const counts = new Map<string, { edge: [number, number]; count: number }>()
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const a = index.getX(triangle + corner)
      const b = index.getX(triangle + (corner + 1) % 3)
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { edge: [a, b], count: 1 })
    }
  }
  return [...counts.values()].filter(entry => entry.count === 1).map(entry => entry.edge)
}

/** Collect narrow sewn strips into one mesh without capping the openings between them. */
export function quadGeometry(quads: THREE.Vector3[][]) {
  const positions: number[] = []
  const coordinates: number[] = []
  const indices: number[] = []
  for (const quad of quads) {
    const base = positions.length / 3
    quad.forEach(point => positions.push(point.x, point.y, point.z))
    coordinates.push(0, 0, 1, 0, 1, 1, 0, 1)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(coordinates, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function seam(points: THREE.Vector3[], material: THREE.Material, thickness = 0.008, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed)
  return mesh(new THREE.TubeGeometry(curve, Math.max(32, points.length * 5), thickness, 6, closed), material)
}

export function ribbon(curve: THREE.CatmullRomCurve3, width: number, thickness: number, material: THREE.Material) {
  const geometry = surfaceGeometry(8, 64, (u, v) => {
    const point = curve.getPoint(v)
    const tangent = curve.getTangent(v)
    const normal = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize()
    const angle = u * Math.PI * 2
    return point.addScaledVector(normal, Math.cos(angle) * width / 2).add(new THREE.Vector3(0, 0, Math.sin(angle) * thickness / 2))
  })
  return mesh(geometry, material)
}

export function roundedRect(width: number, height: number, radius: number) {
  const shape = new THREE.Shape()
  const x = -width / 2
  const y = -height / 2
  shape.moveTo(x + radius, y)
  shape.lineTo(x + width - radius, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + radius)
  shape.lineTo(x + width, y + height - radius)
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  shape.lineTo(x + radius, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - radius)
  shape.lineTo(x, y + radius)
  shape.quadraticCurveTo(x, y, x + radius, y)
  return shape
}

export function roundedPanel(width: number, height: number, depth: number, radius: number) {
  const geometry = new THREE.ExtrudeGeometry(roundedRect(width, height, radius), {
    depth, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 3, curveSegments: 12,
  })
  geometry.translate(0, 0, -depth / 2)
  return geometry
}
