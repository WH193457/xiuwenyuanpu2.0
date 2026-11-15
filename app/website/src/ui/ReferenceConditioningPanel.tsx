import { useEffect, useRef, useState } from 'react'
import type { Pattern, PatternElement, ReferenceEditor, ReferenceSettings } from '../domain'
import { initialReferenceEditor, invalidateReference, isReferenceAccepted, isReferencePreparationCurrent, referenceAcceptanceKey, referencePreparationKey, referencePreparationRequest } from '../referenceConditioning'
import { readReferenceFile } from '../referenceImage'
import { generationService } from '../services'

interface Props {
  pattern: Pattern
  element?: PatternElement
  value: ReferenceEditor
  onChange: (value: ReferenceEditor) => void
  onAccept: (value: ReferenceEditor) => Promise<void>
  onBusy: (busy: boolean) => void
  available: boolean
  disabled: boolean
}

export function ReferenceConditioningPanel({ pattern, element, value, onChange, onAccept, onBusy, available, disabled }: Props) {
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const preparationKey = referencePreparationKey(value, pattern.id, element)
  const latestKey = useRef(preparationKey)
  latestKey.current = preparationKey
  const fresh = isReferencePreparationCurrent(value, pattern.id, element)
  const accepted = isReferenceAccepted(value, pattern.id, element)
  const locked = disabled || preparing
  const sourceImage = value.source === 'upload' ? value.upload?.image : value.source === 'element' ? element?.image : pattern.image
  const settings = value.settings

  const change = (changes: Partial<ReferenceEditor>) => {
    onChange(invalidateReference(value, changes))
    setError('')
  }
  const changeSettings = (changes: Partial<ReferenceSettings>) => change({ settings: { ...settings, ...changes } })

  const upload = async (file: File) => {
    setError('')
    setPreparing(true)
    onBusy(true)
    try {
      const image = await readReferenceFile(file, 8)
      if (mounted.current) onChange(invalidateReference(value, { source: 'upload', upload: image }))
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '结构参考图片读取失败。')
    } finally {
      if (mounted.current) { setPreparing(false); onBusy(false) }
    }
  }

  const prepare = async () => {
    setError('')
    setPreparing(true)
    onBusy(true)
    try {
      const request = referencePreparationRequest(value, pattern.id, element)
      const preparation = await generationService.prepareReference(request)
      if (!mounted.current || latestKey.current !== preparationKey) return
      const uploadedImage = 'image_data_url' in request ? {
        id: value.upload?.id ?? preparation.reference_id, name: request.image_name, image: request.image_data_url,
        width: preparation.source.width, height: preparation.source.height, sha256: preparation.source.sha256,
      } : undefined
      const next = { ...value, preparation: { ...preparation, uploadedImage }, preparedKey: preparationKey,
        acceptedKey: undefined, conditioning: undefined }
      if (!isReferencePreparationCurrent(next, pattern.id, element)) throw new Error('返回的结构参考与当前来源或设置不一致，请重新准备。')
      onChange(next)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '结构参考准备失败。')
    } finally {
      if (mounted.current) { setPreparing(false); onBusy(false) }
    }
  }

  const accept = async () => {
    if (!fresh || !value.preparation) return
    const next = { ...value, acceptedKey: referenceAcceptanceKey(value, pattern.id, element), conditioning: {
      reference_id: value.preparation.reference_id, reference_sha256: value.preparation.reference_sha256,
      method: value.method, strength: value.strength, control_scale: value.controlScale, embroidery_detail: value.embroideryDetail,
    } }
    setError('')
    try { await onAccept(next) } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '结构参考采用失败，请重试。')
    }
  }

  return <section className="co-reference-conditioning" aria-label="结构与配色参考">
    <div className="co-section-heading"><h2>结构与配色参考</h2>
      <label className="reference-enable"><input type="checkbox" aria-label="启用结构与配色参考" checked={value.enabled} disabled={locked}
        onChange={event => onChange({ ...value, enabled: event.target.checked })} />启用结构与配色参考</label></div>
    <p className="co-help">使用参考轮廓和指定配色约束生成，语义画布仍可编辑。更换主体时请同步更换参考图。</p>
    <p className="co-help">请核对语义画布中的主体、构图与配色和参考一致。</p>
    {!available && <p className="concept-warning" role="status">结构参考模型暂不可用，请检查本机生成服务与ControlNet权重。</p>}
    {!value.enabled && <p className="co-help">当前使用语义画布生成。{value.conditioning ? '已采纳的结构参考已停用，可重新启用。' : '启用后准备参考图，核对并采用后生效。'}</p>}
    {value.enabled && <>
      <fieldset disabled={locked} className="co-fieldset reference-settings">
        <div className="reference-source-settings">
          <label className="co-input-label">结构参考来源<select aria-label="结构参考来源" value={value.source}
            onChange={event => change({ source: event.target.value as ReferenceEditor['source'] })}>
            <option value="pattern">当前母纹 · {pattern.id}</option>
            <option value="element" disabled={!element}>当前纹样元{element ? ` · ${element.name}` : '（请先选择纹样元）'}</option>
            <option value="upload">上传图片</option>
          </select></label>
          {value.source === 'upload' && <label className="co-input-label">上传结构参考图<input type="file" aria-label="上传结构参考图" accept="image/png,image/jpeg,image/webp"
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file) }} />
            <span className="co-help">PNG、JPEG或WebP，最大8MB。{value.upload?.name}</span></label>}
          {sourceImage && <div className="reference-source-preview"><img src={sourceImage} alt="结构参考原图" />
            <span aria-hidden="true" style={{ left: `${settings.crop[0] * 100}%`, top: `${settings.crop[1] * 100}%`,
              width: `${Math.max(0, settings.crop[2] - settings.crop[0]) * 100}%`, height: `${Math.max(0, settings.crop[3] - settings.crop[1]) * 100}%` }} /></div>}
          <div className="reference-crop" role="group" aria-label="裁切边界百分比">{['左边界', '上边界', '右边界', '下边界'].map((label, index) =>
            <label className="co-input-label" key={label}>{label} %<input aria-label={`裁切${label}百分比`} type="number" min="0" max="100" step="1"
              value={Math.round(settings.crop[index] * 100)} onChange={event => {
                const crop = [...settings.crop] as ReferenceSettings['crop']
                crop[index] = Math.min(100, Math.max(0, Number(event.target.value))) / 100
                changeSettings({ crop })
              }} /></label>)}</div>
          <p className="co-help">百分比相对于原图。调整四条边界以保留主体，避开实物背景和外框。</p>
        </div>
        <div className="reference-mask-settings">
          <label className="co-input-label">主体提取方式<select aria-label="主体提取方式" value={settings.mask_mode}
            onChange={event => changeSettings({ mask_mode: event.target.value as ReferenceSettings['mask_mode'], threshold: event.target.value === 'saturated' ? 80 : 180 })}>
            <option value="dark">保留深色区域</option><option value="light">保留浅色区域</option><option value="saturated">保留鲜艳颜色</option><option value="alpha">使用原图透明通道</option>
          </select></label>
          <label className="co-input-label">提取阈值 {settings.threshold}<input aria-label="提取阈值" type="range" min="0" max="255" step="1"
            value={settings.threshold} disabled={settings.mask_mode === 'alpha'} onChange={event => changeSettings({ threshold: Number(event.target.value) })} /></label>
          <label className="co-input-label">主体配色<select aria-label="主体配色" value={settings.palette_mode}
            onChange={event => changeSettings({ palette_mode: event.target.value as ReferenceSettings['palette_mode'] })}>
            <option value="source">沿用参考主体颜色</option><option value="solid">指定主体单色</option>
          </select></label>
          <div className="reference-colors"><label className="co-input-label">主体颜色<input type="color" aria-label="主体颜色" value={settings.foreground_color}
            disabled={settings.palette_mode === 'source'} onChange={event => changeSettings({ foreground_color: event.target.value })} /></label>
            <label className="co-input-label">背景颜色<input type="color" aria-label="背景颜色" value={settings.background_color}
              onChange={event => changeSettings({ background_color: event.target.value })} /></label></div>
          <label className="co-input-label">参考布局<select aria-label="参考布局" value={settings.layout}
            onChange={event => changeSettings({ layout: event.target.value as ReferenceSettings['layout'] })}>
            <option value="centered">主体居中</option><option value="horizontal-band">横向边带</option><option value="preserve">保留裁切区域布局</option>
          </select></label>
          <label className="co-input-label">四周留白 {Math.round(settings.margin * 100)}%<input aria-label="四周留白" type="range" min="5" max="30" step="1"
            value={Math.round(settings.margin * 100)} onChange={event => changeSettings({ margin: Number(event.target.value) / 100 })} /></label>
          <label className="co-input-label">参考材质<select aria-label="参考材质" value={settings.texture_mode}
            onChange={event => changeSettings({ texture_mode: event.target.value as ReferenceSettings['texture_mode'] })}>
            <option value="source">沿用参考纹理</option><option value="stitched">针线材质引导</option>
          </select></label>
          <p className="co-help">针线材质引导会在重绘前加入细线和织物纹理。</p>
          <label className="co-input-label">参考生成方式<select aria-label="参考生成方式" value={value.method}
            onChange={event => change({ method: event.target.value as ReferenceEditor['method'] })}>
            <option value="canny-img2img">轮廓约束与参考图重绘</option><option value="img2img">参考图重绘</option>
          </select></label>
          <label className="co-input-label">重绘强度 {value.strength.toFixed(2)}<input aria-label="重绘强度" type="range" min="0.25" max="0.85" step="0.05"
            value={value.strength} onChange={event => change({ strength: Number(event.target.value) })} /></label>
          <label className="co-input-label">轮廓约束强度 {value.controlScale.toFixed(2)}<input aria-label="轮廓约束强度" type="range" min="0" max="2" step="0.05"
            disabled={value.method === 'img2img'} value={value.controlScale} onChange={event => change({ controlScale: Number(event.target.value) })} /></label>
          <label className="reference-enable"><input type="checkbox" aria-label="增强针线质感" checked={value.embroideryDetail}
            onChange={event => change({ embroideryDetail: event.target.checked })} />增强针线质感</label>
          <p className="co-help">在生成提示词中加入针脚和线材描述。</p>
        </div>
      </fieldset>
      <div className="co-actions"><button type="button" className="button secondary" disabled={locked || !available}
        onClick={() => void prepare()}>{preparing ? '正在准备参考图…' : '准备结构参考'}</button>
        <button type="button" className="button primary" disabled={locked || !available || !fresh || accepted} onClick={() => void accept()}>采用此结构与配色</button>
        <button type="button" className="co-text-button" disabled={locked} onClick={() => { onChange(initialReferenceEditor()); setError('') }}>清除结构参考</button></div>
      <p className="co-help" role="status">{accepted ? '已采用结构与配色，可预览提示词并生成。' : value.preparation && !fresh ? '准备状态已过期，请重新准备并采用后生成。' : fresh ? '请核对底图、轮廓和蒙版，点击采用后生成。' : '请准备结构参考并确认采用后生成。'}</p>
      {error && <p className="co-error" role="alert">{error}</p>}
      {value.preparation && <div className={`reference-previews${fresh ? '' : ' is-stale'}`}>
        {[['配色底图', value.preparation.init_image], ['结构控制图', value.preparation.control_image], ['主体蒙版', value.preparation.mask_image]].map(([label, image]) =>
          <figure key={label}><img src={image} alt={label} /><figcaption>{label}</figcaption></figure>)}
      </div>}
      {value.preparation?.warnings.map((warning, index) => <p className="concept-warning" key={index}>{warning}</p>)}
    </>}
    {!value.enabled && value.preparation && <button type="button" className="co-text-button" disabled={locked}
      onClick={() => onChange(initialReferenceEditor())}>清除结构参考</button>}
  </section>
}
