import type { ProductAppearance, ProductCarrier, ProductColor } from './domain'

export const PRODUCT_COLOR_PRESETS: { id: ProductColor; label: string; color: string }[] = [
  { id: 'ivory', label: '米白', color: '#eee7d8' },
  { id: 'indigo', label: '靛青', color: '#243e50' },
  { id: 'terracotta', label: '陶红', color: '#b9674e' },
  { id: '#faf8f2', label: '瓷白', color: '#faf8f2' },
  { id: '#303436', label: '炭黑', color: '#303436' },
  { id: '#79958b', label: '青瓷', color: '#79958b' },
  { id: '#52624b', label: '苔绿', color: '#52624b' },
  { id: '#95acb4', label: '雾蓝', color: '#95acb4' },
  { id: '#b9a17c', label: '燕麦', color: '#b9a17c' },
  { id: '#79553d', label: '栗棕', color: '#79553d' },
  { id: '#8a3e49', label: '酒红', color: '#8a3e49' },
  { id: '#c89b4e', label: '姜黄', color: '#c89b4e' },
]

export const PRODUCT_COLOR_PARTS: Record<ProductCarrier, { body: string; detail: string }> = {
  mug: { body: '杯身', detail: '杯把与内釉' },
  vase: { body: '瓶身', detail: '瓶口与内釉' },
  tote: { body: '包身', detail: '提带与包边' },
  tee: { body: '衣身', detail: '领口与袖边' },
  cushion: { body: '枕面', detail: '滚边' },
  scarf: { body: '巾面', detail: '卷边' },
  notebook: { body: '封面', detail: '书脊与绑带' },
  poster: { body: '衬纸', detail: '画框' },
  tumbler: { body: '杯身', detail: '杯盖与底圈' },
  coaster: { body: '垫面', detail: '外缘' },
  bookmark: { body: '书签面', detail: '流苏与织边' },
  fan: { body: '扇面', detail: '扇骨' },
  phonecase: { body: '背壳', detail: '边框与镜头圈' },
  pouch: { body: '包身', detail: '拉链与提环' },
}

export function resolveProductColor(color: ProductColor): string {
  return PRODUCT_COLOR_PRESETS.find(preset => preset.id === color)?.color
    ?? (/^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#eee7d8')
}

export function resolveProductDetailColor(appearance: ProductAppearance, fallback?: string): string {
  return appearance.detailColor && appearance.detailColor !== 'auto'
    ? resolveProductColor(appearance.detailColor)
    : fallback ?? resolveProductColor(appearance.color)
}
