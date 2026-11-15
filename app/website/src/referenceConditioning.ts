import type { GenerationResult, PatternElement, ReferenceEditor, ReferencePreparationRequest, ReferenceSettings } from './domain'

export function initialReferenceEditor(): ReferenceEditor {
  return {
    enabled: false, source: 'pattern', settings: {
      crop: [0, 0, 1, 1], mask_mode: 'dark', threshold: 180, palette_mode: 'source',
      foreground_color: '#C63D3D', background_color: '#F5F0E6', layout: 'centered',
      margin: 0.12, width: 512, height: 512, texture_mode: 'stitched',
    }, method: 'canny-img2img', strength: 0.55, controlScale: 0.8, embroideryDetail: true,
  }
}

export function referencePreparationKey(state: ReferenceEditor, patternId: string, element?: PatternElement) {
  const sourceId = state.source === 'pattern' ? patternId : state.source === 'element' ? element?.id : state.upload?.id
  return JSON.stringify({ source: state.source, patternId, sourceId, settings: state.settings })
}

export function referenceAcceptanceKey(state: ReferenceEditor, patternId: string, element?: PatternElement) {
  return JSON.stringify({ preparation: referencePreparationKey(state, patternId, element), method: state.method,
    strength: state.strength, controlScale: state.controlScale, embroideryDetail: state.embroideryDetail })
}

function settingsValues(settings: ReferenceSettings) {
  return [settings.crop, settings.mask_mode, settings.threshold, settings.palette_mode,
    settings.foreground_color.toUpperCase(), settings.background_color.toUpperCase(),
    settings.layout, settings.margin, settings.width, settings.height, settings.texture_mode ?? 'source']
}

function upgradePreparationKey(key: string | undefined) {
  if (!key) return key
  try {
    const parsed = JSON.parse(key)
    if (parsed.settings && typeof parsed.settings === 'object' && !('texture_mode' in parsed.settings)) {
      parsed.settings.texture_mode = 'source'
      return JSON.stringify(parsed)
    }
  } catch { /* Invalid saved keys remain invalid and cannot be adopted. */ }
  return key
}

export function upgradeLegacyReferenceEditor(state: ReferenceEditor): ReferenceEditor {
  let acceptedKey = state.acceptedKey
  if (acceptedKey) {
    try {
      const parsed = JSON.parse(acceptedKey)
      if (typeof parsed.preparation === 'string') {
        parsed.preparation = upgradePreparationKey(parsed.preparation)
        acceptedKey = JSON.stringify(parsed)
      }
    } catch { /* Preserve malformed keys so the normal readiness check blocks them. */ }
  }
  return { ...state, preparedKey: upgradePreparationKey(state.preparedKey), acceptedKey }
}

export function isReferencePreparationCurrent(state: ReferenceEditor, patternId: string, element?: PatternElement) {
  const preparation = state.preparation
  if (!preparation || state.preparedKey !== referencePreparationKey(state, patternId, element)
    || JSON.stringify(settingsValues(preparation.settings)) !== JSON.stringify(settingsValues(state.settings))) return false
  if (state.source === 'pattern') return preparation.source.kind === 'pattern' && preparation.source.id === patternId
  if (state.source === 'element' && element && /^DXE\d{3}$/.test(element.id)) {
    return preparation.source.kind === 'element' && preparation.source.id === element.id
  }
  const sourceImage = state.source === 'element' ? element?.image : state.upload?.image
  return preparation.source.kind === 'upload' && Boolean(sourceImage)
    && preparation.uploadedImage?.image === sourceImage && preparation.uploadedImage?.sha256 === preparation.source.sha256
}

export function isReferenceAccepted(state: ReferenceEditor, patternId: string, element?: PatternElement) {
  return Boolean(state.preparation && state.conditioning
    && isReferencePreparationCurrent(state, patternId, element)
    && state.acceptedKey === referenceAcceptanceKey(state, patternId, element)
    && state.conditioning.reference_id === state.preparation.reference_id
    && state.conditioning.reference_sha256 === state.preparation.reference_sha256
    && state.conditioning.method === state.method && state.conditioning.strength === state.strength
    && state.conditioning.control_scale === state.controlScale && state.conditioning.embroidery_detail === state.embroideryDetail)
}

export function invalidateReference(state: ReferenceEditor, changes: Partial<ReferenceEditor>): ReferenceEditor {
  return { ...state, ...changes, preparedKey: undefined, acceptedKey: undefined, conditioning: undefined }
}

export function referencePreparationRequest(state: ReferenceEditor, patternId: string, element?: PatternElement): ReferencePreparationRequest {
  const [left, top, right, bottom] = state.settings.crop
  if (left >= right || top >= bottom) throw new Error('裁切区域的右边界和下边界需要分别大于左边界和上边界。')
  if (state.source === 'pattern') return { ...state.settings, pattern_id: patternId }
  if (state.source === 'element') {
    if (!element) throw new Error('请先在纹样元参考中选择一个纹样元。')
    if (/^DXE\d{3}$/.test(element.id)) return { ...state.settings, element_id: element.id }
    if (element.image.startsWith('data:image/')) return { ...state.settings, image_data_url: element.image, image_name: element.name }
    throw new Error('当前纹样元缺少可用图像，请选择资料库纹样元或上传图片。')
  }
  if (!state.upload) throw new Error('请先上传结构参考图片。')
  return { ...state.settings, image_data_url: state.upload.image, image_name: state.upload.name }
}

export function referenceEditorFromResult(result: GenerationResult): ReferenceEditor {
  const state = initialReferenceEditor()
  const preparation = result.referencePreparation
  const conditioning = result.referenceConditioning
  if (!preparation || !conditioning) return state
  const next: ReferenceEditor = {
    ...state, enabled: true, source: preparation.source.kind, upload: preparation.uploadedImage,
    settings: preparation.settings, preparation, conditioning, method: conditioning.method,
    strength: conditioning.strength, controlScale: conditioning.control_scale, embroideryDetail: conditioning.embroidery_detail,
  }
  next.preparedKey = referencePreparationKey(next, result.pattern.id, result.element)
  next.acceptedKey = referenceAcceptanceKey(next, result.pattern.id, result.element)
  return next
}
