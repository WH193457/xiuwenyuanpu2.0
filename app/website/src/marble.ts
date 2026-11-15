import { appConfig } from './config'
import type { MarbleGenerateRequest, MarbleService, MarbleWorld } from './domain'

type OperationPayload = {
  done?: boolean
  error?: { message?: string }
  response?: {
    world_id?: string
    display_name?: string
    world_marble_url?: string
    assets?: {
      thumbnail_url?: string
      caption?: string
      imagery?: { pano_url?: string }
      mesh?: { hq_mesh_url?: string; collider_mesh_url?: string; full_res_mesh_url?: string }
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export class MockMarbleService implements MarbleService {
  isLive() {
    return false
  }

  async generateMuseum(request: MarbleGenerateRequest): Promise<MarbleWorld> {
    await sleep(700)
    return {
      id: `MOCK-${Date.now()}`,
      displayName: request.displayName,
      status: 'mock',
      mode: 'mock',
      prompt: request.textPrompt,
      createdAt: new Date().toISOString(),
      message: '未配置 VITE_WLT_API_KEY，已使用本地博物馆预览。填写 Key 后可切换为 World Labs Marble 正式生成。',
      assets: {
        thumbnailUrl: '/brand/logo.png',
        caption: '本地预览展厅：侗纹光晕中的文创陈列空间（Mock）',
        worldMarbleUrl: undefined,
      },
    }
  }

  async getWorld(id: string): Promise<MarbleWorld> {
    return {
      id,
      displayName: '本地博物馆预览',
      status: 'mock',
      mode: 'mock',
      prompt: '',
      createdAt: new Date().toISOString(),
      assets: { thumbnailUrl: '/brand/logo.png', caption: '本地 Mock 展厅' },
    }
  }
}

/** World Labs Marble API — 正式接入（需 VITE_WLT_API_KEY） */
export class WorldLabsMarbleService implements MarbleService {
  isLive() {
    return Boolean(appConfig.wltApiKey)
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      'WLT-Api-Key': appConfig.wltApiKey,
    }
  }

  private async request(path: string, init?: RequestInit) {
    const response = await fetch(`${appConfig.marbleBaseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    })
    const body = await response.json().catch(() => ({})) as OperationPayload & { detail?: string; message?: string }
    if (!response.ok) {
      throw new Error(body.detail ?? body.message ?? body.error?.message ?? `Marble API ${response.status}`)
    }
    return body
  }

  private mapWorld(raw: NonNullable<OperationPayload['response']>, prompt: string, fallbackName: string): MarbleWorld {
    return {
      id: raw.world_id ?? `WL-${Date.now()}`,
      displayName: raw.display_name || fallbackName,
      status: 'ready',
      mode: 'live',
      prompt,
      createdAt: new Date().toISOString(),
      assets: {
        thumbnailUrl: raw.assets?.thumbnail_url,
        panoUrl: raw.assets?.imagery?.pano_url,
        meshGlbUrl: raw.assets?.mesh?.hq_mesh_url ?? raw.assets?.mesh?.full_res_mesh_url ?? raw.assets?.mesh?.collider_mesh_url,
        worldMarbleUrl: raw.world_marble_url,
        caption: raw.assets?.caption,
      },
    }
  }

  async generateMuseum(request: MarbleGenerateRequest): Promise<MarbleWorld> {
    const body: Record<string, unknown> = {
      model: appConfig.marbleModel,
      display_name: request.displayName.slice(0, 64),
      world_prompt: {
        text_prompt: request.textPrompt,
      },
      permission: { public: false },
    }
    if (request.imageUri) {
      body.world_prompt = {
        text_prompt: request.textPrompt,
        image_prompt: { source: 'uri', uri: request.imageUri },
      }
    }

    const started = await this.request('/marble/v1/worlds:generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as { operation_id?: string }

    const operationId = started.operation_id
    if (!operationId) throw new Error('Marble 未返回 operation_id')

    for (let attempt = 0; attempt < 90; attempt += 1) {
      await sleep(4000)
      const op = await this.request(`/marble/v1/operations/${operationId}`)
      if (op.error?.message) throw new Error(op.error.message)
      if (op.done && op.response) {
        return this.mapWorld(op.response, request.textPrompt, request.displayName)
      }
    }
    throw new Error('Marble 生成超时，请稍后在 World Labs 控制台查看任务。')
  }

  async getWorld(id: string): Promise<MarbleWorld> {
    const raw = await this.request(`/marble/v1/worlds/${id}`) as NonNullable<OperationPayload['response']> & {
      display_name?: string
      world_prompt?: { text_prompt?: string }
      world_marble_url?: string
      assets?: NonNullable<OperationPayload['response']>['assets']
      world_id?: string
    }
    return this.mapWorld(
      {
        world_id: raw.world_id ?? id,
        display_name: raw.display_name,
        world_marble_url: raw.world_marble_url,
        assets: raw.assets,
      },
      raw.world_prompt?.text_prompt ?? '',
      raw.display_name ?? id,
    )
  }
}

export const marbleService: MarbleService = appConfig.marbleEnabled
  ? new WorldLabsMarbleService()
  : new MockMarbleService()

export { WORKSHOP_SESSION_KEY } from './workshopSession'
