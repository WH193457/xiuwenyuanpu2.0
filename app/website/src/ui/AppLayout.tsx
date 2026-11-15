import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { NavLink, Outlet, ScrollRestoration, useLocation, useNavigation, useRouteError } from 'react-router'
import { brandAssets } from '../config'
import { Icon } from './Icon'
import { IpGuideChat } from './IpGuideChat'

const nav = [
  ['/', '首页'],
  ['/patterns', '纹样库'],
  ['/dynamic', '流动纹谱'],
  ['/deconstruct', '智能解构'],
  ['/create', '创生工坊'],
  ['/workshop', '文创贴图'],
  ['/museum', '3D博物馆'],
  ['/evaluate', '成果评价'],
]

function BrandMark() {
  return <NavLink to="/" className="brand" aria-label="绣纹元谱首页">
    <img className="brand-logo" src={brandAssets.logo} alt="" width={42} height={42} />
    <span><strong>绣纹元谱</strong><small>XIÙ WÉN YUÁN PǓ · 2.0</small></span>
  </NavLink>
}

export function AppLayout() {
  const location = useLocation()
  const navigation = useNavigation()
  const reduce = useReducedMotion()
  const theme = location.pathname === '/' ? 'jiangnan'
    : location.pathname === '/patterns' ? 'catalogue'
    : location.pathname.startsWith('/patterns/') ? 'plate'
    : location.pathname.startsWith('/deconstruct') ? 'analysis'
    : location.pathname.startsWith('/create') ? 'atelier'
    : location.pathname.startsWith('/dynamic') ? 'jiangnan'
    : location.pathname.startsWith('/workshop') || location.pathname.startsWith('/museum') ? 'atelier'
    : location.pathname.startsWith('/evaluate') ? 'review'
    : 'jiangnan'
  return <div className="site-shell" data-theme={theme}>
    <header className="site-header">
      <BrandMark />
      <nav aria-label="主导航">
        {nav.map(([href, label]) => <NavLink key={href} to={href} end={href === '/'}>{({ isActive }) => <><span>{label}</span>{isActive && <motion.i layoutId="nav-ink" />}</>}</NavLink>)}
      </nav>
      <NavLink to="/workshop" className="header-entry" aria-label="进入文创贴图">文创工坊 <Icon name="arrow" size={17} /></NavLink>
    </header>
    {navigation.state === 'loading' && <p className="route-loading" role="status">正在打开页面…</p>}
    <AnimatePresence mode="wait">
      <motion.main key={location.pathname} initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? .1 : .32 }}>
        <Outlet />
      </motion.main>
    </AnimatePresence>
    <footer className="site-footer">
      <BrandMark />
      <p>侗绣纹样形意解构与演化创生研究平台 · 2.0</p>
      <div>
        <NavLink to="/patterns">纹样图录</NavLink>
        <NavLink to="/dynamic">流动纹谱</NavLink>
        <NavLink to="/workshop">文创贴图</NavLink>
        <NavLink to="/museum">3D博物馆</NavLink>
        <span>数据版本 · 2026</span>
      </div>
    </footer>
    <IpGuideChat />
    <ScrollRestoration />
  </div>
}

export function ErrorPage() {
  const error = useRouteError() as { status?: number; statusText?: string; message?: string }
  return <div className="error-page"><span className="seal-large">失</span><p className="eyebrow">{error.status ?? '错误'}</p><h1>这一页暂未入谱</h1><p>{error.statusText ?? error.message ?? '请返回纹样图录继续浏览。'}</p><NavLink className="button primary" to="/patterns">返回纹样库</NavLink></div>
}
