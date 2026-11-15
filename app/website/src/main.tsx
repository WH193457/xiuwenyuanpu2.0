import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import '@fontsource/noto-serif-sc/600.css'
import '@fontsource/noto-serif-sc/700.css'
import '@fontsource/noto-serif-sc/900.css'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/600.css'
import '@fontsource/eb-garamond/500.css'
import '@fontsource/eb-garamond/600.css'
import '@fontsource/ma-shan-zheng'
import './styles.css'
import { AppLayout, ErrorPage } from './ui/AppLayout'
import { HomePage } from './ui/HomePage'
import { PatternsPage } from './ui/PatternsPage'
import { PatternDetailPage } from './ui/PatternDetailPage'
import { CreatePage } from './ui/CreatePage'
import { EvaluatePage } from './ui/EvaluatePage'
import { DeconstructPage } from './ui/DeconstructPage'
import { patternRepository } from './services'

function PageLoading() {
  return <div className="page-wrap" role="status">正在打开页面…</div>
}

const router = createBrowserRouter([
  {
    path: '/',
    Component: AppLayout,
    ErrorBoundary: ErrorPage,
    HydrateFallback: PageLoading,
    children: [
      { index: true, Component: HomePage, loader: () => patternRepository.list() },
      { path: 'patterns', Component: PatternsPage, loader: () => patternRepository.list() },
      {
        path: 'patterns/:id',
        Component: PatternDetailPage,
        loader: async ({ params }) => {
          const pattern = await patternRepository.get(params.id ?? '')
          if (!pattern) throw new Response('未找到纹样', { status: 404 })
          return { pattern, elements: await patternRepository.elementsForPattern(pattern.id) }
        },
      },
      {
        path: 'dynamic', loader: () => patternRepository.list(),
        lazy: async () => ({ Component: (await import('./ui/DynamicPatternPage')).DynamicPatternPage }),
      },
      { path: 'create', Component: CreatePage, loader: async () => ({ patterns: await patternRepository.list(), elements: await patternRepository.elements() }) },
      {
        path: 'workshop', loader: () => patternRepository.list(),
        shouldRevalidate: ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) => {
          const queryNavigation = !formMethod && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search
          return queryNavigation ? false : defaultShouldRevalidate
        },
        lazy: async () => ({ Component: (await import('./ui/WorkshopPage')).WorkshopPage }),
      },
      {
        path: 'museum', loader: () => patternRepository.list(),
        lazy: async () => ({ Component: (await import('./ui/MuseumPage')).MuseumPage }),
      },
      { path: 'deconstruct', Component: DeconstructPage, loader: () => patternRepository.list() },
      { path: 'evaluate', Component: EvaluatePage },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><RouterProvider router={router} /></React.StrictMode>,
)
