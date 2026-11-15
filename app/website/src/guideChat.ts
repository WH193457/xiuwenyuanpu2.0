import { patternRepository } from './services'

export type GuideMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
  links?: { label: string; to: string }[]
}

const FAQS: { keys: string[]; answer: string; links?: { label: string; to: string }[] }[] = [
  {
    keys: ['你好', '您好', 'hello', 'hi', '在吗', '介绍'],
    answer: '你好，我是「侗纹守护者」，绣纹元谱的导览 IP。可以问我纹样编号、功能入口，或「怎么创生 / 怎么贴图 / 博物馆怎么用」。',
  },
  {
    keys: ['你是谁', 'ip', '守护者', '形象'],
    answer: '我是绣纹元谱品牌 IP「侗纹守护者」：陪你逛纹样库、理解形·意·元·生，并串起创生、文创贴图与 3D 博物馆。',
  },
  {
    keys: ['纹样库', '图录', '浏览', '查找纹样'],
    answer: '纹样库收录 80 件侗绣纹样，可按六类形意谱系筛选。点开单件可看图像、构图、寓意证据层级与关联纹样元。',
    links: [{ label: '进入纹样库', to: '/patterns' }],
  },
  {
    keys: ['流动', '粒子', '动态', 'toe', 'touch'],
    answer: '「流动纹谱」按项目里的 纹样图片.8.toe 做网页实时演算：沿针脚边缘流动、Feedback 拖尾，可调密度/流速，并一键带入文创贴图。',
    links: [{ label: '打开流动纹谱', to: '/dynamic' }],
  },
  {
    keys: ['解构', '拆解', 'sam3', '框选'],
    answer: '「智能解构」连接本地 SAM3：在绣框上框选区域，提取可追溯的纹样元，再送入创生工坊。',
    links: [{ label: '去智能解构', to: '/deconstruct' }],
  },
  {
    keys: ['创生', '生成', '提案', '绣案'],
    answer: '「创生工坊」从有出处的母纹出发，编排构图、配色、意向与载体，生成应用提案，并可进入 3D 贴图或博物馆。',
    links: [{ label: '打开创生工坊', to: '/create' }],
  },
  {
    keys: ['文创', '贴图', '白模', '杯子', '帆布', '文化衫', '抱枕', '丝巾', '笔记本', '花器', '保温杯', '杯垫', '书签', '折扇', '手机壳', '收纳包'],
    answer: '「文创贴图台」提供十四款文创，包括杯瓶、布袋、文化衫、抱枕、丝巾、笔记本、装裱画，以及随行保温杯、陶瓷杯垫、织纹书签、折扇、手机壳和拉链收纳包。可按器物、织物、案头、随身筛选。「物品配色」可分别修改主体和部件，提供12种预设色及自定义颜色。「调整贴图」可修改纹样大小、位置、旋转、重复方式与浅色背景去除。保存方案后可带入展厅查看。',
    links: [{ label: '进入文创贴图', to: '/workshop' }],
  },
  {
    keys: ['博物馆', 'marble', '展厅', '3d馆'],
    answer: '「3D 文创博物馆」在本地三维展厅陈列十四款文创。可选择全景或单件近景，拖动旋转视角、缩放和导出截图。从贴图台带入的产品会采用已调整的配色与纹样排版，其余展品使用各自默认方案。',
    links: [{ label: '打开 3D 博物馆', to: '/museum' }],
  },
  {
    keys: ['评价', '成果', '评分'],
    answer: '「成果评价」用于记录作品评分与备注，方便大创过程留档与复盘。',
    links: [{ label: '去成果评价', to: '/evaluate' }],
  },
  {
    keys: ['形意', '元生', '路径', '研究'],
    answer: '平台主线是「形 · 意 · 元 · 生」：观察结构 → 辨明语境与证据层级 → 提取可追溯纹样元 → 演化应用到载体与展陈。',
  },
  {
    keys: ['帮助', '怎么用', '功能', '指南', '导航'],
    answer: '常用路径：纹样库阅谱 → 智能解构提元 → 创生工坊提案 → 文创贴图 / 3D 博物馆。也可直接问具体编号，例如「DX017」。',
    links: [
      { label: '纹样库', to: '/patterns' },
      { label: '创生工坊', to: '/create' },
      { label: '文创贴图', to: '/workshop' },
    ],
  },
]

function normalize(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, '')
}

async function answerAboutPattern(query: string): Promise<GuideMessage | null> {
  const idMatch = query.toUpperCase().match(/\bDX\d{3}\b/)
  const patterns = await patternRepository.list()
  const byId = idMatch ? patterns.find((p) => p.id === idMatch[0]) : undefined
  const compact = normalize(query)
  const byName = byId ?? patterns.find((p) => {
    const name = normalize(p.name.replace(/（暂定）/g, ''))
    return name && (compact.includes(name) || name.includes(compact.replace(/^.*?(看|查|问|介绍)/, '')))
  })

  if (!byName && !byId) return null
  const pattern = byId ?? byName!
  const shortName = pattern.name.replace(/（暂定）/g, '')
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    text: `${pattern.id}「${shortName}」属于「${pattern.category}」。构图：${pattern.composition}；对称/重复：${pattern.symmetry_repeat}；主色：${pattern.colors.slice(0, 4).join('、')}。寓意摘录：${pattern.meaning.slice(0, 120)}${pattern.meaning.length > 120 ? '…' : ''}`,
    links: [
      { label: `查看 ${pattern.id}`, to: `/patterns/${pattern.id}` },
      { label: '带入创生', to: `/create?patterns=${pattern.id}` },
      { label: '文创贴图', to: `/workshop?pattern=${pattern.id}&source=library` },
    ],
  }
}

function answerFaq(query: string): GuideMessage | null {
  const compact = normalize(query)
  const hit = FAQS.find((item) => item.keys.some((key) => compact.includes(normalize(key))))
  if (!hit) return null
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    text: hit.answer,
    links: hit.links,
  }
}

/** 本地知识导览；后续可在此替换为真实 LLM / 后端问答接口 */
export async function askGuide(question: string): Promise<GuideMessage> {
  const trimmed = question.trim()
  if (!trimmed) {
    return { id: crypto.randomUUID(), role: 'assistant', text: '可以说具体一点，例如「DX060 是什么」或「怎么做文创贴图」。' }
  }

  const patternAnswer = await answerAboutPattern(trimmed)
  if (patternAnswer) return patternAnswer

  const faq = answerFaq(trimmed)
  if (faq) return faq

  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    text: '我暂时只能根据平台知识与入谱纹样作答。可以试试：纹样编号（如 DX017）、「智能解构怎么用」、「博物馆要不要 Key」。',
    links: [
      { label: '浏览纹样库', to: '/patterns' },
      { label: '功能帮助', to: '/create' },
    ],
  }
}

export const GUIDE_QUICK_PROMPTS = [
  '你是谁？',
  '怎么开始阅谱？',
  '智能解构怎么用？',
  '文创贴图在哪？',
  '博物馆要 API Key 吗？',
  '介绍 DX017',
]
