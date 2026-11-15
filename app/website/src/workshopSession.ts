import { z } from 'zod'
import { PRODUCT_CARRIERS, type Pattern, type ProductAppearance, type ProductCarrier, type WorkshopSession } from './domain'
import { defaultProductAppearance } from './productCatalog'

export const WORKSHOP_SESSION_KEY = 'xiuwen-workshop-session-v1'
export const ProductCarrierSchema = z.enum(PRODUCT_CARRIERS)
const ProductColorSchema = z.union([
  z.enum(['ivory', 'indigo', 'terracotta']),
  z.string().regex(/^#[0-9a-f]{6}$/i).transform(value => value.toLowerCase() as `#${string}`),
])
export const ProductAppearanceSchema = z.object({
  scale: z.number().finite().min(0.35).max(1.8),
  offsetX: z.number().finite().min(-0.5).max(0.5),
  offsetY: z.number().finite().min(-0.5).max(0.5),
  rotation: z.number().finite().min(-180).max(180),
  repeat: z.boolean(), removeBackground: z.boolean(),
  color: ProductColorSchema,
  detailColor: z.union([ProductColorSchema, z.literal('auto')]).default('auto').catch('auto'),
})

const appearanceKeys: Record<keyof ProductAppearance, string> = {
  scale: 'printScale', offsetX: 'printX', offsetY: 'printY', rotation: 'printRotation',
  repeat: 'printRepeat', removeBackground: 'printRemoveBackground', color: 'productColor',
  detailColor: 'productDetailColor',
}

export function appearanceSearchParams(appearance: ProductAppearance): URLSearchParams {
  return new URLSearchParams(Object.entries(appearanceKeys).map(([key, name]) => [name, String(appearance[key as keyof ProductAppearance] ?? 'auto')]))
}

function resolveAppearance(params: URLSearchParams, carrier: ProductCarrier, saved?: ProductAppearance): ProductAppearance {
  const defaults = defaultProductAppearance(carrier)
  const candidate: Record<string, unknown> = { ...defaults, ...saved }
  for (const [key, name] of Object.entries(appearanceKeys)) {
    if (!params.has(name)) continue
    const value = params.get(name)!
    if (key === 'color' || key === 'detailColor') candidate[key] = value
    else if (key === 'repeat' || key === 'removeBackground') candidate[key] = value === 'true' ? true : value === 'false' ? false : undefined
    else candidate[key] = value.trim() ? Number(value) : undefined
  }
  // Validate fields independently so one damaged URL value cannot discard the other design settings.
  return Object.fromEntries(Object.entries(ProductAppearanceSchema.shape).map(([key, schema]) => {
    const parsed = schema.safeParse(candidate[key])
    return [key, parsed.success ? parsed.data : defaults[key as keyof ProductAppearance]]
  })) as unknown as ProductAppearance
}

const WorkshopSessionSchema: z.ZodType<WorkshopSession> = z.object({
  patternId: z.string().min(1).max(256),
  patternName: z.string().min(1).max(512),
  textureUrl: z.string().min(1).max(16 * 1024 * 1024).refine(value =>
    /^(?:data:image\/(?:png|jpeg|webp);base64,|https?:\/\/|\/(?!\/))/i.test(value)),
  carrier: ProductCarrierSchema.catch('mug'),
  appearance: ProductAppearanceSchema.optional().catch(undefined),
  source: z.enum(['create', 'library', 'sam3']),
  createdAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
})

export function readWorkshopSession(): WorkshopSession | undefined {
  try {
    const raw = sessionStorage.getItem(WORKSHOP_SESSION_KEY)
    if (!raw) return undefined
    return WorkshopSessionSchema.safeParse(JSON.parse(raw)).data
  } catch {
    return undefined
  }
}

export function saveWorkshopSession(session: WorkshopSession): void {
  const parsed = WorkshopSessionSchema.safeParse(session)
  if (!parsed.success) throw new Error('贴图记录不完整，请重新选择纹样与载体。')
  try {
    sessionStorage.setItem(WORKSHOP_SESSION_KEY, JSON.stringify(parsed.data))
  } catch (error) {
    throw new Error('浏览器未能保存贴图记录，请检查存储空间或权限。', { cause: error })
  }
}

export function resolveWorkshopSelection(
  patterns: Pattern[],
  params: URLSearchParams,
  session?: WorkshopSession,
  fallbackCarrier: ProductCarrier = 'mug',
) {
  const requestedId = params.has('pattern') ? params.get('pattern') : session?.patternId
  const pattern = patterns.find(item => item.id === requestedId) ?? patterns[0]
  const matchingSession = requestedId === pattern?.id && session?.patternId === pattern?.id ? session : undefined
  const requestedCarrier = ProductCarrierSchema.safeParse(params.get('carrier'))
  const carrier = params.has('carrier')
    ? requestedCarrier.success ? requestedCarrier.data : fallbackCarrier
    : matchingSession?.carrier ?? fallbackCarrier
  const useSession = params.get('source') !== 'library' && Boolean(matchingSession)
  return {
    pattern,
    carrier,
    textureUrl: useSession ? matchingSession!.textureUrl : pattern?.image,
    source: useSession ? matchingSession!.source : 'library' as WorkshopSession['source'],
    appearance: resolveAppearance(params, carrier, useSession && matchingSession?.carrier === carrier ? matchingSession.appearance : undefined),
    session: matchingSession,
  }
}
