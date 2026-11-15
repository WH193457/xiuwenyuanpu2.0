import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const siteRoot = resolve(here, '..')
const projectRoot = resolve(siteRoot, '..')
const sourceRoot = process.env.XIUVEN_DATA_ROOT
  ? resolve(process.env.XIUVEN_DATA_ROOT)
  : resolve(projectRoot, '纹样库', '侗族', '_标注成果')
const publicRoot = resolve(siteRoot, 'public')

await mkdir(resolve(publicRoot, 'data'), { recursive: true })
await mkdir(resolve(publicRoot, 'patterns', 'thumb'), { recursive: true })
await mkdir(resolve(publicRoot, 'patterns', 'detail'), { recursive: true })
await mkdir(resolve(publicRoot, 'elements'), { recursive: true })

const patterns = JSON.parse(await readFile(resolve(sourceRoot, '03_标注数据', 'patterns.json'), 'utf8'))
const elements = JSON.parse(await readFile(resolve(sourceRoot, '03_标注数据', 'elements.json'), 'utf8'))
const sourceCatalogue = JSON.parse(await readFile(resolve(siteRoot, 'src', 'data', 'sources.json'), 'utf8'))
const sourceIds = new Set()
for (const source of sourceCatalogue.sources) {
  if (!source.id || sourceIds.has(source.id) || !source.title || !/^https?:\/\//u.test(source.url)) {
    throw new Error('资料目录存在无效或重复记录，请重新运行 python scripts/export-sources.py。')
  }
  sourceIds.add(source.id)
}
for (const pattern of patterns) {
  for (const id of pattern.source_ids) {
    if (!sourceIds.has(id)) throw new Error(`纹样 ${pattern.id} 引用未导出的资料 ${id}。`)
  }
}
const bibliographyWorkbook = resolve(sourceRoot, '03_标注数据', '侗族80张纹样标注成果.xlsx')
if (await exists(bibliographyWorkbook)) {
  const checksum = createHash('sha256').update(await readFile(bibliographyWorkbook)).digest('hex')
  if (checksum !== sourceCatalogue.workbookSha256) {
    throw new Error('标注工作簿已更新，请运行 python scripts/export-sources.py 更新资料目录。')
  }
}

const webPatterns = patterns.map((pattern) => ({
  ...pattern,
  image: `/patterns/detail/${pattern.id}.webp`,
  thumbnail: `/patterns/thumb/${pattern.id}.webp`,
}))
const webElements = elements.map((element) => ({ ...element, image: `/elements/${element.id}.webp` }))

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function createWebp(source, target, width, quality) {
  if (await exists(target)) return
  await sharp(source).resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality, effort: 4 }).toFile(target)
}

for (let index = 0; index < patterns.length; index += 6) {
  await Promise.all(patterns.slice(index, index + 6).flatMap((pattern) => {
    const source = resolve(sourceRoot, '01_编号图像', `${pattern.id}.png`)
    return [
      createWebp(source, resolve(publicRoot, 'patterns', 'thumb', `${pattern.id}.webp`), 480, 80),
      createWebp(source, resolve(publicRoot, 'patterns', 'detail', `${pattern.id}.webp`), 1024, 84),
    ]
  }))
}

for (let index = 0; index < elements.length; index += 6) {
  await Promise.all(elements.slice(index, index + 6).map((element) => createWebp(
    resolve(sourceRoot, '02_纹样元', `${element.id}.png`),
    resolve(publicRoot, 'elements', `${element.id}.webp`),
    720,
    84,
  )))
}

await Promise.all([
  writeFile(resolve(publicRoot, 'data', 'patterns.json'), JSON.stringify(webPatterns)),
  writeFile(resolve(publicRoot, 'data', 'elements.json'), JSON.stringify(webElements)),
  writeFile(resolve(publicRoot, 'data', 'sources.json'), JSON.stringify(sourceCatalogue)),
])

console.log(`已同步 ${webPatterns.length} 条纹样、${webElements.length} 个纹样元、${sourceIds.size} 条资料来源。`)
