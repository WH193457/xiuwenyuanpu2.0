import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { evaluationRepository } from '../services'
import { Icon } from './Icon'
import { Ornament, Stamp } from './shared'

const axes = ['文化适切','形态传承','视觉协调','创新表达','应用可行']

export function EvaluatePage() {
  const [workName,setWorkName] = useState('DX060 创生提案')
  const [scores,setScores] = useState([4,4,3,4,3])
  const [note,setNote] = useState('')
  const [saved,setSaved] = useState(false)
  const changeScore = (index:number,value:number) => setScores(current=>current.map((score,i)=>i===index?value:score))
  const save = async () => { await evaluationRepository.save({workName,scores,note}); setSaved(true); window.setTimeout(()=>setSaved(false),1800) }
  return <div className="page-wrap evaluate-page">
    <header className="page-title-block split-title"><div><p className="eyebrow">DESIGN REVIEW · LOCAL RECORD</p><h1>成果评阅册</h1></div><p>用一致的维度记录创生成果。评分保存于当前浏览器，仅用于首期流程演示。</p></header>
    <div className="review-sheet">
      <section className="review-form"><div className="sheet-mark">评阅<br/><b>01</b></div><label className="title-input"><span>作品名称</span><input value={workName} onChange={e=>setWorkName(e.target.value)}/></label><div className="score-fields">{axes.map((axis,index)=><div key={axis}><header><span>0{index+1}</span><label htmlFor={`score-${index}`}>{axis}</label><strong>{scores[index]}.0</strong></header><input id={`score-${index}`} type="range" min="1" max="5" step="1" value={scores[index]} onChange={e=>changeScore(index,Number(e.target.value))}/><div className="range-labels"><span>需调整</span><span>成熟</span></div></div>)}</div><label className="review-note"><span>评阅批注</span><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="记录需要保留、调整或继续考证的部分…" rows={5}/></label><button className="button primary" onClick={save}>保存本次评阅<Icon name="arrow" size={17}/></button></section>
      <section className="review-visual"><p className="eyebrow">FIVE-DIMENSION PROFILE</p><h2>综合评阅图</h2><Radar scores={scores}/><dl><div><dt>综合得分</dt><dd>{(scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1)}</dd></div><div><dt>较强维度</dt><dd>{axes[scores.indexOf(Math.max(...scores))]}</dd></div></dl><div className="review-guidance"><Stamp subtle>则</Stamp><p>文化适切性优先于形式新奇度。对资料不足的寓意，应保留“设计意向”标识，不转写为确定文化结论。</p></div></section>
    </div>
    <section className="evaluation-scale"><Ornament label="评阅说明"/><div>{[['文化适切','是否尊重资料边界与使用语境'],['形态传承','母纹特征是否清晰可追溯'],['视觉协调','构图、色彩与载体是否统一'],['创新表达','是否产生有效的新组合'],['应用可行','是否适合继续深化与制作']].map(([name,copy],i)=><article key={name}><span>0{i+1}</span><h3>{name}</h3><p>{copy}</p></article>)}</div></section>
    <AnimatePresence>{saved && <motion.div className="save-stamp" initial={{scale:1.8,rotate:-12,opacity:0}} animate={{scale:1,rotate:-5,opacity:1}} exit={{scale:.9,opacity:0}} transition={{type:'spring',stiffness:260,damping:18}}><span>已录</span><small>LOCAL</small></motion.div>}</AnimatePresence>
  </div>
}

function Radar({scores}:{scores:number[]}) {
  const cx=180,cy=165,r=112
  const point=(index:number,level:number)=>{const angle=-Math.PI/2+(Math.PI*2*index/5);return [cx+Math.cos(angle)*r*(level/5),cy+Math.sin(angle)*r*(level/5)]}
  const polygon=(level:number)=>axes.map((_,i)=>point(i,level).join(',')).join(' ')
  const data=scores.map((score,i)=>point(i,score).join(',')).join(' ')
  return <svg className="radar" viewBox="0 0 360 330" role="img" aria-label="五维评分雷达图">{[1,2,3,4,5].map(level=><polygon key={level} points={polygon(level)} className="radar-grid"/>)}{axes.map((axis,i)=>{const [x,y]=point(i,6.1);return <g key={axis}><line x1={cx} y1={cy} x2={point(i,5)[0]} y2={point(i,5)[1]}/><text x={x} y={y}>{axis}</text></g>})}<motion.polygon points={data} className="radar-data" animate={{points:data}}/>{scores.map((score,i)=>{const [x,y]=point(i,score);return <circle key={i} cx={x} cy={y} r="5"/>})}</svg>
}
