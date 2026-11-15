import type { ProductAppearance, ProductCarrier } from './domain'

export const PRODUCT_CATALOG: { id: ProductCarrier; label: string; category: string; tip: string; material: string }[] = [
  { id: 'mug', label: '马克杯', category: '器物', tip: '釉面环绕印花', material: '釉面陶瓷' },
  { id: 'vase', label: '陶瓷花器', category: '器物', tip: '曲面连续纹样', material: '细釉陶瓷' },
  { id: 'tumbler', label: '随行保温杯', category: '器物', tip: '杯身环绕印花', material: '涂层金属' },
  { id: 'tote', label: '帆布袋', category: '织物', tip: '织物曲面印花', material: '棉麻帆布' },
  { id: 'tee', label: '文化衫', category: '织物', tip: '胸前贴合印花', material: '柔软棉布' },
  { id: 'cushion', label: '织纹抱枕', category: '织物', tip: '软包曲面纹样', material: '织纹棉麻' },
  { id: 'scarf', label: '丝巾', category: '织物', tip: '垂坠满幅纹样', material: '柔光丝织物' },
  { id: 'notebook', label: '精装笔记本', category: '案头', tip: '封面纹样设计', material: '布面精装纸本' },
  { id: 'poster', label: '装裱画', category: '案头', tip: '留白装裱画面', material: '木框与棉纸' },
  { id: 'coaster', label: '陶瓷杯垫', category: '案头', tip: '圆面纹样与软木底衬', material: '釉面陶瓷与软木' },
  { id: 'bookmark', label: '织纹书签', category: '案头', tip: '竖幅纹样与流苏', material: '织物与金属扣' },
  { id: 'fan', label: '折扇', category: '随身', tip: '折面纹样与竹木扇骨', material: '绢面与竹木' },
  { id: 'phonecase', label: '手机壳', category: '随身', tip: '背壳印花与镜头开孔', material: '哑光保护壳' },
  { id: 'pouch', label: '拉链收纳包', category: '随身', tip: '弧面印花与金属拉链', material: '棉麻织物' },
]

export const PRODUCT_CATEGORIES = [...new Set(PRODUCT_CATALOG.map(product => product.category))]

export function defaultProductAppearance(carrier: ProductCarrier): ProductAppearance {
  return {
    scale: 1, offsetX: 0, offsetY: 0, rotation: 0,
    repeat: carrier === 'mug' || carrier === 'vase' || carrier === 'scarf' || carrier === 'tumbler',
    removeBackground: false, color: 'ivory', detailColor: 'auto',
  }
}
