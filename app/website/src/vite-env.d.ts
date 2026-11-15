/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_MODE?: 'json' | 'http'
  readonly VITE_API_BASE_URL?: string
  readonly VITE_LORA_API_BASE_URL?: string
  readonly VITE_ENABLE_DEMO?: 'true' | 'false'
  readonly VITE_ENABLE_LORA?: 'true' | 'false'
  /** World Labs Marble API Key；为空时走 MockMarbleService */
  readonly VITE_WLT_API_KEY?: string
  readonly VITE_MARBLE_BASE_URL?: string
  readonly VITE_MARBLE_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
