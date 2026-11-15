import type { ReferenceImage } from './domain'

export async function readReferenceFile(file: File, maximumMegabytes = 5): Promise<ReferenceImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择PNG、JPEG或WebP图片。')
  if (file.size > maximumMegabytes * 1024 * 1024) throw new Error(`参考图请控制在${maximumMegabytes}MB以内。`)
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败。'))
    reader.readAsDataURL(file)
  })
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight })
    element.onerror = () => reject(new Error('图片内容无法解码。'))
    element.src = image
  })
  if (dimensions.width * dimensions.height > 16_000_000) throw new Error('参考图像素过大，请缩小到1600万像素以内。')
  return { id: crypto.randomUUID(), name: file.name, image, ...dimensions }
}
