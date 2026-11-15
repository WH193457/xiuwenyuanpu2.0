import { motion } from 'motion/react'
import { Link } from 'react-router'
import type { Pattern } from '../domain'
import { Icon } from './Icon'

export const categoryMeta: Record<string, { short: string; english: string }> = {
  '动物与神兽': { short: '灵', english: 'FAUNA' },
  '复合纹样／待定': { short: '合', english: 'COMPOSITE' },
  '几何与边饰': { short: '序', english: 'GEOMETRY' },
  '人物与生活场景': { short: '人', english: 'LIFE' },
  '植物花卉': { short: '生', english: 'FLORA' },
  '自然天象': { short: '象', english: 'NATURE' },
}

export const colorMap: Record<string, string> = {
  红: '#a93f33', 粉: '#d8918f', 浅粉: '#e7b6ad', 玫红: '#b34662',
  黑: '#342f2b', 白: '#eee9de', 米白: '#e6d7b8', 米黄: '#cfb883',
  黄: '#d1a83e', 金黄: '#b98923', 橙: '#c66b35', 褐: '#79583d',
  蓝: '#325f79', 深蓝: '#263f59', 浅蓝: '#84afbb', 蓝绿: '#397b77',
  绿: '#4e7554', 紫: '#6c526f',
}

export function Ornament({ label }: { label?: string }) {
  return <div className="ornament" aria-hidden="true"><i/><b>◇</b>{label && <span>{label}</span>}<b>◇</b><i/></div>
}

export function SectionHead({ eyebrow, title, intro, action }: { eyebrow: string; title: string; intro?: string; action?: { label: string; to: string } }) {
  return <div className="section-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{intro && <p>{intro}</p>}</div>{action && <Link className="text-link" to={action.to}>{action.label}<Icon name="arrow" size={18}/></Link>}</div>
}

export function ColorDots({ colors, large = false }: { colors: string[]; large?: boolean }) {
  return <div className={`color-dots ${large ? 'large' : ''}`} aria-label={`配色：${colors.join('、')}`}>{colors.map((color, index) => <i key={`${color}-${index}`} title={color} style={{ background: colorMap[color] ?? '#9b7a4b' }} />)}</div>
}

export function PatternCard({ pattern, selected = false, onSelect }: { pattern: Pattern; selected?: boolean; onSelect?: (pattern: Pattern) => void }) {
  return <motion.article className={`pattern-card ${selected ? 'selected' : ''}`} layout>
    <Link to={`/patterns/${pattern.id}`} className="pattern-card-image" aria-label={`查看${pattern.name}`}>
      <motion.img layoutId={`pattern-${pattern.id}`} src={pattern.thumbnail ?? pattern.image} alt={pattern.name} loading="lazy" />
      <span className="pattern-index">{pattern.id}</span>
      {selected && <span className="selected-seal">选</span>}
    </Link>
    <div className="pattern-card-copy">
      <div><span>{pattern.category}</span><ColorDots colors={pattern.colors.slice(0, 5)} /></div>
      <h3><Link to={`/patterns/${pattern.id}`}>{pattern.name.replace(/（暂定）/g, '')}</Link></h3>
      <p>{pattern.composition} · {pattern.symmetry_repeat}</p>
      {onSelect && <button className="icon-select" onClick={() => onSelect(pattern)} aria-label={selected ? '移出参考纹样' : '加入参考纹样'}><Icon name={selected ? 'minus' : 'plus'} size={16}/>{selected ? '已选' : '参考'}</button>}
    </div>
  </motion.article>
}

export function Stamp({ children, subtle = false }: { children: React.ReactNode; subtle?: boolean }) {
  return <span className={`stamp ${subtle ? 'subtle' : ''}`}>{children}</span>
}
