import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link, useLoaderData } from 'react-router'
import type { Pattern } from '../domain'
import { Icon } from './Icon'
import { Ornament, PatternCard, SectionHead, categoryMeta } from './shared'

const marqueeIds = [
  'DX001','DX004','DX009','DX012','DX017','DX020','DX023','DX028','DX031','DX036','DX041','DX045',
  'DX048','DX052','DX056','DX060','DX063','DX066','DX069','DX072','DX075','DX077','DX079','DX080',
]

function MarqueeCard({ pattern, interactive }: { pattern: Pattern; interactive: boolean }) {
  const image = <><img src={pattern.thumbnail ?? pattern.image} alt={interactive ? pattern.name : ''}/><span className="flow-card-meta"><b>{pattern.id}</b><i>{pattern.name.replace(/（暂定）/g, '')}</i></span></>
  return interactive
    ? <Link className="flow-card" to={`/patterns/${pattern.id}`} aria-label={`查看${pattern.name}`}>{image}</Link>
    : <div className="flow-card" aria-hidden="true">{image}</div>
}

function MarqueeRow({ patterns, direction, interactive }: { patterns: Pattern[]; direction: 'a' | 'b'; interactive: boolean }) {
  return <div className={`flow-row flow-row-${direction}`}>
    {[0, 1].map(copy => <div className="flow-group" key={copy} aria-hidden={copy === 1 || !interactive ? true : undefined}>
      {patterns.map(pattern => <MarqueeCard key={`${copy}-${pattern.id}`} pattern={pattern} interactive={interactive && copy === 0}/>) }
    </div>)}
  </div>
}

function MarqueeLayer({ rows, digital = false }: { rows: [Pattern[], Pattern[]]; digital?: boolean }) {
  return <div className={`flow-layer ${digital ? 'flow-digital' : 'flow-traditional'}`} aria-hidden={digital ? true : undefined}>
    <MarqueeRow patterns={rows[0]} direction="a" interactive={!digital}/>
    <MarqueeRow patterns={rows[1]} direction="b" interactive={!digital}/>
  </div>
}

function PatternMarquee({ patterns }: { patterns: Pattern[] }) {
  const reduce = useReducedMotion()
  const selected = marqueeIds.map(id => patterns.find(pattern => pattern.id === id)).filter(Boolean) as Pattern[]
  const rows: [Pattern[], Pattern[]] = [selected.slice(0, 12), selected.slice(12, 24)]
  const [paused, setPaused] = useState(() => sessionStorage.getItem('xiuwen-marquee-paused') === 'true')
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const manualToggle = () => setPaused(current => {
    sessionStorage.setItem('xiuwen-marquee-paused', String(!current))
    return !current
  })
  const isPaused = paused || hovered || focused || hidden

  return <motion.div
    className={`translation-hero flow-hero ${reduce ? 'is-reduced' : ''} ${isPaused ? 'is-paused' : ''}`}
    initial={{ clipPath: reduce ? 'none' : 'inset(0 50% 0 50%)', opacity: reduce ? 1 : .65 }}
    animate={{ clipPath: 'inset(0 0% 0 0%)', opacity: 1 }}
    transition={{ duration: reduce ? .1 : .55, ease: [.22, 1, .36, 1] }}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    onFocusCapture={(event) => { if ((event.target as HTMLElement).closest('.flow-card')) setFocused(true) }}
    onBlurCapture={(event) => { if (!(event.relatedTarget as HTMLElement | null)?.closest?.('.flow-card')) setFocused(false) }}
  >
    <div className="hero-corners" aria-hidden="true"><i/><i/><i/><i/></div>
    <header className="flow-head"><div><span>活态纹谱</span><b>FORM FLOWS INTO ELEMENT</b></div><button type="button" onClick={manualToggle} aria-pressed={paused} aria-label={paused ? '继续纹样流动' : '暂停纹样流动'}><Icon name={paused ? 'play' : 'pause'} size={15}/>{paused ? '继续' : '暂停'}</button></header>
    <div className="flow-viewport">
      <div className="flow-canvas">
        <MarqueeLayer rows={rows}/>
        <MarqueeLayer rows={rows} digital/>
        <div className="flow-grid" aria-hidden="true"/>
        <div className="translation-gate" aria-hidden="true">
          <span>原纹</span>
          <svg viewBox="0 0 72 560"><path className="gate-thread" d="M36 548C8 493 62 447 35 389S61 277 36 218 58 101 36 14"/><path className="gate-needle" d="M37 337 32 157M32 157c1-13 12-13 12 0l-7 180"/><ellipse cx="37" cy="178" rx="5" ry="11"/></svg>
          <span>元谱</span>
        </div>
        <div className="flow-nodes" aria-hidden="true"><i/><i/><i/><i/><i/><i/><i/></div>
      </div>
    </div>
    <footer className="flow-foot"><span>真实侗绣图像</span><i/><b>纹样经过绣针，进入数字解构状态</b><i/><span>形 · 意 · 元 · 生</span></footer>
  </motion.div>
}

export function HomePage() {
  const patterns = useLoaderData() as Pattern[]
  const categoryPatterns = Object.keys(categoryMeta).map((category) => patterns.find((p) => p.category === category)).filter(Boolean) as Pattern[]
  return <>
    <section className="home-hero page-frame">
      <div className="home-intro">
        <p className="eyebrow">DONG EMBROIDERY · DIGITAL ATLAS</p>
        <h1><span>绣纹</span><span>元谱</span><em>2.0</em></h1>
        <p className="brush-line">一针见形，一谱生新</p>
        <p className="hero-lead">以真实侗绣纹样为底本，梳理形、意与纹样元之间的关系，让传统纹样在数字语境中被看见、被理解，也被重新使用。</p>
        <div className="hero-actions">
          <Link className="button primary" to="/patterns">进入纹样库<Icon name="arrow" size={18}/></Link>
          <Link className="button secondary" to="/dynamic">流动纹谱</Link>
          <Link className="button secondary" to="/workshop">文创贴图</Link>
        </div>
        <dl className="hero-note"><div><dt>80</dt><dd>件入谱纹样</dd></div><div><dt>15</dt><dd>个核心纹样元</dd></div><div><dt>06</dt><dd>类形意谱系</dd></div></dl>
      </div>
      <div className="hero-visual">
        <PatternMarquee patterns={patterns}/>
      </div>
      <div className="scroll-cue">向下阅谱 <span>↓</span></div>
    </section>

    <section className="section pattern-albums">
      <SectionHead eyebrow="六类纹样册页 · SIX FAMILIES" title="从纹样看见侗绣的秩序" intro="按图像主体与构成关系整理。分类帮助检索，不替代纹样所处的真实文化语境。" action={{label:'浏览全部 80 件',to:'/patterns'}} />
      <div className="album-grid">
        {categoryPatterns.map((pattern, index) => <Link to={`/patterns?category=${encodeURIComponent(pattern.category)}`} className="album" key={pattern.category}>
          <span className="album-number">0{index + 1}</span><img src={pattern.thumbnail ?? pattern.image} alt={pattern.name}/><div><b>{categoryMeta[pattern.category].short}</b><h3>{pattern.category.replace('／待定','')}</h3><p>{categoryMeta[pattern.category].english}</p></div>
        </Link>)}
      </div>
    </section>

    <section className="research-strip">
      <div className="section"><Ornament label="研究路径"/><div className="research-copy"><div><p className="eyebrow">FROM FORM TO RE-CREATION</p><h2>形 · 意 · 元 · 生</h2><p className="brush-line">不止收藏图像，也记录理解的边界</p></div><p>每一件纹样都从视觉结构出发，关联纹样元与资料依据。创生时保留来源关系，让新的设计仍能回到它的母纹。</p></div>
        <ol className="research-steps">
          {[['形','观察纹样','记录主体、构图、色彩与重复方式'],['意','辨明语境','区分资料支持、谨慎表述与设计意向'],['元','提取基因','从完整纹样中建立可追溯的纹样元'],['生','演化应用','组合母纹、构图和载体形成设计提案']].map(([char,title,copy],i)=><li key={char}><span>0{i+1}</span><b>{char}</b><div><h3>{title}</h3><p>{copy}</p></div></li>)}
        </ol>
      </div>
    </section>

    <section className="section featured-patterns">
      <SectionHead eyebrow="代表纹样 · SELECTED PLATES" title="先读纹，再论意" intro="每条解释都标注证据层级；对尚无专属寓意资料的纹样，不依据外形附会。" />
      <div className="featured-grid">{['DX017','DX060','DX036'].map(id => patterns.find(p => p.id === id)).filter(Boolean).map(p => <PatternCard key={p!.id} pattern={p!}/>)}</div>
      <div className="closing-note"><span className="seal-large">元</span><p className="brush-line">让千年文脉，在智能时代继续生长</p><Link className="text-link" to="/create">以纹样开启一次创生 <Icon name="arrow" size={18}/></Link></div>
    </section>
  </>
}
