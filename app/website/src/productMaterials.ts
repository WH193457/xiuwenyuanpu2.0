import * as THREE from 'three'
import type { ProductAppearance } from './domain'
import { resolveProductColor } from './productColors'

export const PRODUCT_COLORS = { ivory: '#eee7d8', indigo: '#243e50', terracotta: '#b9674e' }
type PrintArea = { width: number; height: number; x?: number; y?: number }

function canvas(width: number, height: number) {
  const value = document.createElement('canvas')
  value.width = Math.max(1, Math.round(width))
  value.height = Math.max(1, Math.round(height))
  return value
}

/** Remove only edge-connected pale pixels, keeping enclosed white embroidery details. */
function sourceImage(texture: THREE.Texture, removeBackground: boolean) {
  const image = texture.image as HTMLImageElement | HTMLCanvasElement
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height
  const ratio = Math.min(1, 1024 / Math.max(width, height))
  const source = canvas(width * ratio, height * ratio)
  const context = source.getContext('2d')!
  context.drawImage(image, 0, 0, source.width, source.height)
  if (!removeBackground) return source
  const pixels = context.getImageData(0, 0, source.width, source.height)
  const count = source.width * source.height
  const visited = new Uint8Array(count)
  const queue = new Uint32Array(count)
  let head = 0
  let tail = 0
  const visit = (index: number) => {
    if (visited[index]) return
    visited[index] = 1
    const pixel = index * 4
    const r = pixels.data[pixel]
    const g = pixels.data[pixel + 1]
    const b = pixels.data[pixel + 2]
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const spread = Math.max(r, g, b) - Math.min(r, g, b)
    // Warm paper and its neutral shadow connect to the outside. Cyan/red thread remains bounded.
    const pale = luminance > 166 && spread < 58 && r >= g - 8 && g >= b - 8
    if (pixels.data[pixel + 3] < 12 || pale) queue[tail++] = index
  }
  for (let x = 0; x < source.width; x++) { visit(x); visit(count - source.width + x) }
  for (let y = 0; y < source.height; y++) { visit(y * source.width); visit(y * source.width + source.width - 1) }
  while (head < tail) {
    const index = queue[head++]
    pixels.data[index * 4 + 3] = 0
    const x = index % source.width
    if (x > 0) visit(index - 1)
    if (x < source.width - 1) visit(index + 1)
    if (index >= source.width) visit(index - source.width)
    if (index + source.width < count) visit(index + source.width)
  }
  // Preserve antialiased thread edges while fading the last neutral paper-shadow pixel.
  const feather = (index: number) => {
    const pixel = index * 4
    if (!pixels.data[pixel + 3]) return
    const r = pixels.data[pixel]
    const g = pixels.data[pixel + 1]
    const b = pixels.data[pixel + 2]
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const neutral = Math.max(r, g, b) - Math.min(r, g, b) < 58 && r >= g - 8 && g >= b - 8
    if (neutral && luminance > 135) pixels.data[pixel + 3] = Math.min(pixels.data[pixel + 3], Math.round(255 * THREE.MathUtils.clamp((166 - luminance) / 31, 0, 1)))
  }
  for (let index = 0; index < tail; index++) {
    const pixel = queue[index]
    const x = pixel % source.width
    if (x > 0) feather(pixel - 1)
    if (x < source.width - 1) feather(pixel + 1)
    if (pixel >= source.width) feather(pixel - source.width)
    if (pixel + source.width < count) feather(pixel + source.width)
  }
  context.putImageData(pixels, 0, 0)
  return source
}

export function weaveTexture(silk = false) {
  const image = canvas(128, 128)
  const context = image.getContext('2d')!
  const pixels = context.createImageData(128, 128)
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const warp = Math.pow(0.5 + 0.5 * Math.cos(x * Math.PI / 4), 2)
    const weft = Math.pow(0.5 + 0.5 * Math.cos(y * Math.PI / 4), 2)
    const overUnder = Math.cos(x * Math.PI / 8) * Math.cos(y * Math.PI / 8)
    const fiber = Math.sin(x * Math.PI / 2 + Math.sin(y * Math.PI / 16))
    const value = 98 + 43 * warp + 37 * weft + 13 * overUnder + 4 * fiber
    const index = (y * 128 + x) * 4
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value
    pixels.data[index + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  const texture = new THREE.CanvasTexture(image)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(silk ? 20 : 12, silk ? 20 : 12)
  texture.anisotropy = 8
  return texture
}

type ProductSurface = 'fabric' | 'silk' | 'ceramic' | 'paper'

function surfaceFinish(kind: ProductSurface, bump?: THREE.Texture): THREE.MeshPhysicalMaterialParameters {
  const image = canvas(128, 128)
  const context = image.getContext('2d')!
  const pixels = context.createImageData(128, 128)
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const grain = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    const noise = grain - Math.floor(grain)
    const yarn = Math.sin(x * Math.PI / 4) * Math.cos(y * Math.PI / 4)
    const value = kind === 'ceramic' ? 218 + 25 * noise : 225 + 15 * noise + 10 * yarn
    const index = (y * 128 + x) * 4
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value
    pixels.data[index + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  const roughness = new THREE.CanvasTexture(image)
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping
  roughness.repeat.set(kind === 'ceramic' ? 6 : 12, kind === 'ceramic' ? 6 : 12)
  roughness.anisotropy = 8
  const ceramic = kind === 'ceramic'
  const silk = kind === 'silk'
  return {
    roughness: ceramic ? 0.25 : silk ? 0.44 : 0.96,
    roughnessMap: roughness,
    clearcoat: ceramic ? 0.65 : 0,
    clearcoatRoughness: 0.16,
    sheen: silk ? 0.65 : kind === 'fabric' ? 0.18 : 0,
    sheenColor: new THREE.Color('#eee8dd'),
    sheenRoughness: silk ? 0.48 : 0.9,
    bumpMap: bump ?? roughness,
    bumpScale: ceramic ? 0.0012 : silk ? 0.001 : kind === 'paper' ? 0.0008 : 0.0028,
    side: THREE.DoubleSide,
  }
}

export function ceramicMaterial(color: string) {
  return new THREE.MeshPhysicalMaterial({ color, ...surfaceFinish('ceramic') })
}

export function woodMaterial(color: string) {
  const image = canvas(128, 256)
  const context = image.getContext('2d')!
  const pixels = context.createImageData(128, 256)
  for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) {
    const bend = 1.8 * Math.sin(y / 75) + 0.7 * Math.sin(y / 29)
    const grain = Math.pow(0.5 + 0.5 * Math.sin((x + bend) * 1.8), 12)
    const fine = Math.sin(x * 9.31 + y * 0.14)
    const value = 245 - 33 * grain + 4 * fine
    const index = (y * 128 + x) * 4
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value
    pixels.data[index + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  const map = new THREE.CanvasTexture(image)
  map.colorSpace = THREE.SRGBColorSpace
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.anisotropy = 8
  const bump = map.clone()
  bump.colorSpace = THREE.NoColorSpace
  return new THREE.MeshPhysicalMaterial({ color, map, bumpMap: bump, bumpScale: 0.0015,
    roughness: 0.52, clearcoat: 0.18, clearcoatRoughness: 0.4 })
}

export function plainFabric(appearance: ProductAppearance, bump?: THREE.Texture, silk = false, colorOverride?: string) {
  return new THREE.MeshPhysicalMaterial({
    color: colorOverride ?? resolveProductColor(appearance.color),
    ...surfaceFinish(silk ? 'silk' : 'fabric', bump),
  })
}

/** Print into the object's own UV space so geometry and artwork share every fold. */
export function printedMaterial(
  source: THREE.Texture, appearance: ProductAppearance, width: number, height: number,
  print: PrintArea, kind: ProductSurface, bump?: THREE.Texture,
) {
  const pixelsPerUnit = 1024 / Math.max(width, height)
  const image = canvas(width * pixelsPerUnit, height * pixelsPerUnit)
  const context = image.getContext('2d')!
  const base = resolveProductColor(appearance.color)
  context.fillStyle = base
  context.fillRect(0, 0, image.width, image.height)
  const motif = sourceImage(source, appearance.removeBackground)
  const aspect = motif.width / motif.height
  const maxWidth = print.width * pixelsPerUnit
  const maxHeight = print.height * pixelsPerUnit
  const printWidth = Math.min(maxWidth, maxHeight * aspect) * appearance.scale
  const printHeight = printWidth / aspect
  const centerX = image.width * (0.5 + appearance.offsetX) + (print.x ?? 0) * pixelsPerUnit
  const centerY = image.height * (0.5 - appearance.offsetY) - (print.y ?? 0) * pixelsPerUnit
  context.save()
  if (kind === 'ceramic') {
    context.beginPath()
    context.rect(0, (height / 2 - (print.y ?? 0) - print.height / 2) * pixelsPerUnit, image.width, maxHeight)
    context.clip()
  }
  context.translate(centerX, centerY)
  context.rotate(-THREE.MathUtils.degToRad(appearance.rotation))
  if (appearance.repeat) {
    const pattern = context.createPattern(motif, 'repeat')!
    pattern.setTransform(new DOMMatrix().translate(-printWidth / 2, -printHeight / 2).scale(printWidth / motif.width, printHeight / motif.height))
    context.fillStyle = pattern
    const reach = Math.hypot(image.width, image.height) * 2
    context.fillRect(-reach, -reach, reach * 2, reach * 2)
  } else context.drawImage(motif, -printWidth / 2, -printHeight / 2, printWidth, printHeight)
  context.restore()
  const map = new THREE.CanvasTexture(image)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8
  const material = new THREE.MeshPhysicalMaterial({
    map, color: 0xffffff, ...surfaceFinish(kind, bump),
  })
  material.userData.print = { ...appearance, sourceWidth: motif.width, sourceHeight: motif.height, surfaceWidth: width, surfaceHeight: height }
  return material
}
