import { z } from 'zod'

const EnvSchema = z.object({
  VITE_DATA_MODE: z.enum(['json', 'http']).default('json'),
  VITE_API_BASE_URL: z.string().url().default('http://127.0.0.1:8000/api'),
  VITE_LORA_API_BASE_URL: z.string().url().default('http://127.0.0.1:8001/api'),
  VITE_ENABLE_DEMO: z.enum(['true', 'false']).default('true'),
  VITE_ENABLE_LORA: z.enum(['true', 'false']).default('true'),
  VITE_WLT_API_KEY: z.string().optional().default(''),
  VITE_MARBLE_BASE_URL: z.string().url().default('https://api.worldlabs.ai'),
  VITE_MARBLE_MODEL: z.string().default('marble-1.1'),
})

const env = EnvSchema.parse(import.meta.env)

export const appConfig = {
  dataMode: env.VITE_DATA_MODE,
  apiBaseUrl: env.VITE_API_BASE_URL,
  loraApiBaseUrl: env.VITE_LORA_API_BASE_URL.replace(/\/$/, ''),
  enableDemo: env.VITE_ENABLE_DEMO === 'true',
  enableLora: env.VITE_ENABLE_LORA === 'true',
  wltApiKey: env.VITE_WLT_API_KEY.trim(),
  marbleBaseUrl: env.VITE_MARBLE_BASE_URL.replace(/\/$/, ''),
  marbleModel: env.VITE_MARBLE_MODEL,
  get marbleEnabled() {
    return Boolean(this.wltApiKey)
  },
} as const

export const brandAssets = {
  logo: '/brand/logo.png',
  ip: '/brand/ip.jpg',
} as const
