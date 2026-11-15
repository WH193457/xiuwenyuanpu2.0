import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { Link, useLoaderData, useSearchParams } from 'react-router'
import type { Pattern } from '../domain'
import { Icon } from './Icon'
import { ColorDots, PatternCard, categoryMeta, colorMap } from './shared'

export function PatternsPage() {
  const patterns = useLoaderData() as Pattern[]
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<Pattern[]>([])
  const [view, setView] = useState<'catalog' | 'spectrum'>('catalog')
  const search = params.get('q') ?? ''
  const category = params.get('category') ?? '全部'
  const composition = params.get('composition') ?? '全部'
  const color = params.get('color') ?? '全部'
  const categories = Object.keys(categoryMeta)
  const compositions = [...new Set(patterns.map(p => p.composition))]
  const colors = [...new Set(patterns.flatMap(p => p.colors))]

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (!value || value === '全部') next.delete(key); else next.set(key, value)
    setParams(next, { replace: true })
  }
  const filtered = useMemo(() => patterns.filter(pattern => {
    const haystack = [pattern.id, pattern.name, pattern.category, ...pattern.main_elements, ...pattern.generation_keywords].join(' ').toLowerCase()
    return (!search || haystack.includes(search.toLowerCase())) && (category === '全部' || pattern.category === category) && (composition === '全部' || pattern.composition === composition) && (color === '全部' || pattern.colors.includes(color))
  }), [patterns, search, category, composition, color])
  const toggleSelected = (pattern: Pattern) => setSelected(current => current.some(p => p.id === pattern.id) ? current.filter(p => p.id !== pattern.id) : current.length < 3 ? [...current, pattern] : [...current.slice(1), pattern])

  return <div className="page-wrap library-page">
    <header className="page-title-block">
      <p className="eyebrow">PATTERN ARCHIVE · 001—080</p>
      <h1>侗绣纹样图录</h1>
      <p>从形态、构图与色彩进入纹样。资料层级与原始标注保持一致，共收录 {patterns.length} 件。</p>
    </header>
    <div className="library-tools">
      <label className="search-field"><Icon name="search" size={19}/><input value={search} onChange={e=>update('q',e.target.value)} placeholder="搜索编号、名称或纹样元素"/><span>{String(filtered.length).padStart(2,'0')} 件</span></label>
      <div className="view-switch" aria-label="视图切换"><button className={view==='catalog'?'active':''} onClick={()=>setView('catalog')}><Icon name="grid" size={17}/>图录</button><button className={view==='spectrum'?'active':''} onClick={()=>setView('spectrum')}><Icon name="palette" size={17}/>色谱</button></div>
    </div>
    <div className="filter-row">
      <label>门类<select value={category} onChange={e=>update('category',e.target.value)}><option>全部</option>{categories.map(item=><option key={item}>{item}</option>)}</select></label>
      <label>构图<select value={composition} onChange={e=>update('composition',e.target.value)}><option>全部</option>{compositions.map(item=><option key={item}>{item}</option>)}</select></label>
      <label>主色<select value={color} onChange={e=>update('color',e.target.value)}><option>全部</option>{colors.map(item=><option key={item}>{item}</option>)}</select></label>
      {(category!=='全部'||composition!=='全部'||color!=='全部'||search) && <button className="clear-filter" onClick={()=>setParams({})}><Icon name="close" size={14}/>清除筛选</button>}
    </div>

    {view === 'catalog' ? <motion.div className="pattern-grid" layout>{filtered.map(pattern => <PatternCard key={pattern.id} pattern={pattern} onSelect={toggleSelected} selected={selected.some(item=>item.id===pattern.id)}/>)}</motion.div> : <div className="spectrum-view">
      {colors.map(colorName => { const items = filtered.filter(p=>p.colors.includes(colorName)); return items.length ? <section key={colorName}><header><i style={{background:colorMap[colorName]}}/><h2>{colorName}</h2><span>{items.length} 件纹样</span></header><div>{items.slice(0,12).map(p=><Link to={`/patterns/${p.id}`} key={p.id}><img src={p.thumbnail ?? p.image} alt={p.name}/><span>{p.id}</span></Link>)}</div></section> : null })}
    </div>}
    {!filtered.length && <div className="empty-state"><span className="seal-large">空</span><h2>暂未找到对应纹样</h2><p>尝试减少筛选条件，或按纹样编号搜索。</p><button className="button secondary" onClick={()=>setParams({})}>查看全部纹样</button></div>}

    <AnimatePresence>{selected.length > 0 && <motion.aside className="reference-tray" initial={{y:120,opacity:0}} animate={{y:0,opacity:1}} exit={{y:120,opacity:0}}><div><span>创生参考</span><strong>{selected.length} / 3</strong></div>{selected.map(item=><button key={item.id} onClick={()=>toggleSelected(item)}><img src={item.thumbnail ?? item.image} alt=""/><span>{item.id}</span></button>)}<Link to={`/create?patterns=${selected.map(p=>p.id).join(',')}`}>带入工坊<Icon name="arrow" size={17}/></Link></motion.aside>}</AnimatePresence>
  </div>
}
