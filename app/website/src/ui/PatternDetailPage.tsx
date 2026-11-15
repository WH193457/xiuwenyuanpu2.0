import { motion } from 'motion/react'
import { Link, useLoaderData } from 'react-router'
import type { Pattern, PatternElement } from '../domain'
import { splitMeaning } from '../domain'
import { Icon } from './Icon'
import { ColorDots, Ornament, Stamp } from './shared'

export function PatternDetailPage() {
  const { pattern, elements } = useLoaderData() as { pattern: Pattern; elements: PatternElement[] }
  const meaning = splitMeaning(pattern.meaning)
  return <div className="page-wrap detail-page">
    <div className="breadcrumb"><Link to="/patterns">纹样库</Link><Icon name="chevron" size={13}/><span>{pattern.id}</span></div>
    <section className="detail-plate">
      <div className="plate-image"><motion.img layoutId={`pattern-${pattern.id}`} src={pattern.image} alt={pattern.name}/><span className="plate-index">图版<br/><b>{pattern.id.replace('DX','')}</b></span><div className="zoom-note">原图实色 · 100%</div></div>
      <div className="plate-copy">
        <div className="plate-heading"><p className="eyebrow">DONG EMBROIDERY PLATE · {pattern.id}</p><h1>{pattern.name}</h1><p>{pattern.visual_description}</p></div>
        <dl className="metadata"><div><dt>门类</dt><dd>{pattern.category}</dd></div><div><dt>构图</dt><dd>{pattern.composition}</dd></div><div><dt>秩序</dt><dd>{pattern.symmetry_repeat}</dd></div><div><dt>主纹样元</dt><dd>{pattern.main_elements.join(' · ')}</dd></div><div><dt>辅助元素</dt><dd>{pattern.secondary_elements.join(' · ') || '—'}</dd></div><div><dt>配色</dt><dd><ColorDots colors={pattern.colors} large/>{pattern.colors.join(' · ')}</dd></div></dl>
        <div className={`meaning-card ${meaning.level}`}><div>{meaning.level === 'supported' ? <Stamp>据</Stamp> : meaning.level === 'cautious' ? <Stamp subtle>慎</Stamp> : <span className="note-mark">批</span>}<div><span>文化说明层级</span><strong>{meaning.label}</strong></div></div><p>{meaning.content}</p>{pattern.source_ids.length > 0 && <small>关联资料：{pattern.source_ids.join('、')}</small>}</div>
        <div className="detail-actions"><Link className="button secondary" to={`/deconstruct?pattern=${pattern.id}`}>智能拆解此纹样<Icon name="spark" size={18}/></Link><Link className="button primary" to={`/create?patterns=${pattern.id}`}>以此纹样开始创生<Icon name="arrow" size={18}/></Link></div>
      </div>
    </section>

    <section className="element-section">
      <Ornament label="纹样元解构"/>
      <div className="section-head compact"><div><p className="eyebrow">ELEMENT PROVENANCE</p><h2>从完整纹样回看构成基因</h2><p>青色绣线表示纹样元与母纹之间的来源关系，不代表未经资料验证的文化寓意。</p></div></div>
      <div className="deconstruction">
        <div className="source-pattern"><img src={pattern.image} alt={`${pattern.name}母纹`}/><span>母纹 · {pattern.id}</span></div>
        <svg className="stitch-connect" viewBox="0 0 240 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 50c50 0 55-34 110-34s56 68 130 68"/><circle cx="5" cy="50" r="4"/><circle cx="235" cy="84" r="4"/></svg>
        <div className="element-list">{elements.length ? elements.map(element=><motion.article key={element.id} initial={{x:-20,opacity:0}} whileInView={{x:0,opacity:1}} viewport={{once:true}}><img src={element.image} alt={element.name}/><div><span>{element.id} · {element.type}</span><h3>{element.name}</h3><p>提取位置：{element.position}<br/>建议用途：{element.use}</p></div></motion.article>) : <article className="element-placeholder"><div className="element-outline">{pattern.main_elements.slice(0,2).map((item,i)=><i key={item} style={{rotate:`${i*45}deg`}}/>)}</div><div><span>结构标注 · 待精裁</span><h3>{pattern.main_elements.join(' · ')}</h3><p>已记录结构元素，独立透明纹样元将在下一轮数据处理中补充。</p></div></article>}</div>
      </div>
    </section>

    <section className="keyword-strip"><span>生成关键词</span><div>{pattern.generation_keywords.map(word=><i key={word}>{word}</i>)}</div><p>原始文件：{pattern.original_file}</p></section>
  </div>
}
