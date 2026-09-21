import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { Buffer } from 'node:buffer'
import type {
  AppConfig,
  BotCategory,
  BotCompleteness,
  BotErrorCode,
  BotInstallOptions,
  BotInstallResult,
  BotListResult,
  BotSkill,
  BotSkillDetail
} from '@shared/types'
import { classifySkill, listSkills, readFrontmatter, writeMeta } from './skills'
import { assertRealDir } from './fs-guards'
import { httpGetJson } from './translate'

/**
 * SkillsBot（skillsbot.cn）免登录接入。
 *
 * 设计前提（全部来自实测，不是推测）：
 * 1. 站点分类/搜索/热门/最新/详情全部免登录可读，成功码 code === 20000。
 * 2. 详情接口的 `detail` 字段是**完整 SKILL.md 原文**，这是免登录安装唯一的数据来源。
 * 3. zip 完整包拿不到：/github/skillfile/** 整个命名空间挂全局鉴权拦截器（无 token 一律 50008），
 *    fileName 拼静态路径全部 404，fileUrl 恒为 null，githubProjectName 是作者名而非仓库名。
 *    → 因此本模块**不实现任何下载逻辑**，也不做路径猜测。
 * 4. 站点埋了 honeypot 反爬（详情页隐藏链接指向 /github/file/honeypot）：
 *    **本模块永不解析站点 HTML、永不跟随页面链接**，所有 URL 均由固定 API 路径拼接，
 *    并在出网口统一做 assertNotHoneypot 守卫。
 * 5. 技能 ID 是 19 位雪花 ID，超出 JS 安全整数范围（2^53）。
 *    接口本身以字符串序列化（实测 72/72），故全链路保持字符串，**禁止任何数值转换**。
 *
 * 本文件不 import electron，便于 scripts/p12-smoke.mjs 直接 esbuild 打包后离线真跑。
 */

const BOT_WEB = 'https://skillsbot.cn'
const BOT_API_DEFAULT = `${BOT_WEB}/skillv3/api`
/** 反爬 honeypot 路径（详情页隐藏链接指向它），命中即拒 */
const HONEYPOT_PATH = '/github/file/honeypot'
const SUCCESS_CODE = 20000
/** 站点服务端固定每页 12 条（实测 size=14 仍只回 12 条，size 参数被忽略） */
export const BOT_PAGE_SIZE = 12
/** 完整性预判阈值：实测样本校准（见 p12-smoke） */
const COMPLETENESS_RATIO = 1.8

const BOT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: `${BOT_WEB}/`
}

interface BotEnvelope<T> {
  code: number
  msg?: string
  message?: string
  data: T
  success?: boolean
}

/** 结构化错误码，经 IpcResult.code 透给渲染层分流 */
export class BotApiError extends Error {
  readonly code: BotErrorCode
  constructor(code: BotErrorCode, message: string) {
    super(message)
    this.name = 'BotApiError'
    this.code = code
  }
}

// ---------- URL 组装 ----------

/**
 * 基址规则：默认走 apiBase（/skillv3/api）；路径以 /v2/ 开头时走站点根域（剥掉 API 前缀）。
 * query 中的 undefined / null / 空串 一律跳过。
 */
export function resolveBotApiUrl(
  apiBase: string,
  path: string,
  query?: Record<string, string | number | undefined | null>
): string {
  const base = (apiBase || BOT_API_DEFAULT).replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  let url: string
  if (p.startsWith('/v2/')) {
    const root = base.endsWith('/skillv3/api') ? base.slice(0, -'/skillv3/api'.length) : new URL(base).origin
    url = `${root}${p}`
  } else {
    url = `${base}${p}`
  }
  const parts: string[] = []
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `${url}?${parts.join('&')}` : url
}

/** 站内相对路径 → 绝对 URL（站点返回的地址可能是 /xxx 或 xxx） */
export function resolveBotUrl(u: string): string {
  const s = (u ?? '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  return `${BOT_WEB}${s.startsWith('/') ? s : `/${s}`}`
}

/** honeypot 反爬守卫：命中即抛，结构性防御未知路径被拼进来 */
export function assertNotHoneypot(pathname: string): void {
  if ((pathname ?? '').includes(HONEYPOT_PATH)) {
    throw new BotApiError('honeypot', `已拦截 SkillsBot honeypot 反爬路径：${HONEYPOT_PATH}`)
  }
}

// ---------- 文本 / 命名工具 ----------

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

function nullableStr(v: unknown): string | null {
  const s = str(v).trim()
  return s ? s : null
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function formatNow(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 目录名净化：Windows 非法字符、保留设备名、结尾点/空格、`.`/`..`、超长。
 * 中文原样保留（技能名多为中文）。
 */
export function sanitizeSkillDirName(raw: string, fallback: string): string {
  let s = (raw ?? '').trim()
  // 路径分隔与非法字符一律换成 '-'
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
  s = s.replace(/-{2,}/g, '-')
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s || s === '.' || s === '..') s = fallback
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`
  if (s.length > 80) s = s.slice(0, 80).replace(/[.\s]+$/, '')
  return s || fallback
}

/**
 * 正文归一化。
 * 站点部分记录把换行存成字面量 `\n`（两个字符，实测约 2%，如 #8610），
 * 直接用会让 SKILL.md 变成一整行、frontmatter 解析失败 → 必须还原。
 */
export function normalizeSkillMd(raw: string): { text: string; unescaped: boolean } {
  let s = raw ?? ''
  let unescaped = false
  if (s.includes('\\n') && !s.includes('\n')) {
    s = s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    unescaped = true
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  s = s.replace(/\r\n?/g, '\n')
  return { text: s.trim(), unescaped }
}

/**
 * 免登录完整性预判。
 * 单文件 SKILL.md 压缩后约为正文长度的 0.35~0.55 倍，另加约 200B 的 zip 头。
 * ratio = fileSize / (len * 0.45 + 200)，超过阈值判定包内还有附加文件。
 * 实测校准：#1 = 1.14(仅正文)、#2583 = 1.03(仅正文)、#2304 = 2.36(有附加)、#158 = 13.4(有附加)。
 */
export function judgeCompleteness(detail: string, fileSize?: number | null): BotCompleteness {
  const len = (detail ?? '').length
  const size = typeof fileSize === 'number' ? fileSize : 0
  if (!len || size <= 0) return 'unknown'
  const estimated = len * 0.45 + 200
  return size > estimated * COMPLETENESS_RATIO ? 'has-extras' : 'md-only'
}

/** 只有明确的脚本/数据类扩展名才算「附加文件」，避免把 Node.js / Cargo.toml 这类技术名词当文件 */
const DATA_EXT = /\.(py|sh|bash|zsh|ps1|bat|cmd|rb|go|rs|java|kt|swift|pl|lua|sql|csv|tsv|json|ya?ml|toml|ini|cfg|conf|env|lock|txt|xml|pdf|zip|tar|gz)$/i
const REF_RE = /(?<![\w./-])((?:\.?\/)?(?:[\w\u4e00-\u9fff.-]+\/)*[\w\u4e00-\u9fff.-]+\.[A-Za-z]{1,6})\b/g

/**
 * 从正文中启发式提取「相对路径引用的附加文件」。
 * 这是给用户看的**参考清单**（正文里的示例路径也可能被列出），不是精确的包内文件表。
 */
export function listMissingRefs(detail: string): string[] {
  const out = new Set<string>()
  for (const m of (detail ?? '').matchAll(REF_RE)) {
    const ref = m[1].replace(/^\.\//, '')
    if (/^https?$/i.test(ref)) continue
    if (/^SKILL\.md$/i.test(ref)) continue
    if (ref.includes(' ')) continue
    // 含路径分隔的一律保留；纯文件名要求是脚本/数据扩展名
    if (!ref.includes('/') && !DATA_EXT.test(ref)) continue
    out.add(ref)
    if (out.size >= 20) break
  }
  return [...out]
}

// ---------- 分类树 ----------

function toBotCategory(raw: Record<string, unknown>): BotCategory {
  const children = Array.isArray(raw.children) ? (raw.children as Record<string, unknown>[]) : []
  return {
    id: num(raw.id),
    name: str(raw.name),
    code: nullableStr(raw.code),
    icon: nullableStr(raw.icon),
    parentId: num(raw.parentId),
    sortOrder: raw.sortOrder === undefined || raw.sortOrder === null ? undefined : num(raw.sortOrder),
    type: num(raw.type) || 1,
    children: children.map(toBotCategory).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  }
}

/** 分类树 → 根列表 + 扁平列表（UI 两层 chips 用；纯函数，冒烟可测） */
export function flattenBotCategories(tree: BotCategory[]): {
  roots: BotCategory[]
  flat: BotCategory[]
} {
  const flat: BotCategory[] = []
  const walk = (nodes: BotCategory[]): void => {
    for (const n of nodes) {
      flat.push(n)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(tree)
  return { roots: tree, flat }
}

// ---------- 技能投影 ----------

function toBotSkill(raw: Record<string, unknown>): BotSkill {
  // id 必须是字符串：19 位雪花 ID 一旦经 Number 转换就会丢失精度，导致详情/安装全部 404
  const id = str(raw.id)
  const fileSize = raw.fileSize === undefined || raw.fileSize === null ? null : num(raw.fileSize)
  return {
    id,
    name: str(raw.name),
    enName: str(raw.enName),
    description: str(raw.description),
    categoryId: num(raw.categoryId),
    categoryName: str(raw.categoryName),
    parentCategoryId: raw.parentCategoryId === undefined || raw.parentCategoryId === null ? null : num(raw.parentCategoryId),
    parentCategoryName: nullableStr(raw.parentCategoryName),
    version: raw.version === undefined || raw.version === null ? null : num(raw.version),
    githubProjectName: nullableStr(raw.githubProjectName),
    originalName: nullableStr(raw.originalName),
    fileName: nullableStr(raw.fileName),
    fileSize,
    viewCount: num(raw.viewCount),
    downloadCount: num(raw.downloadCount),
    type: raw.type === undefined || raw.type === null ? null : num(raw.type),
    createTime: nullableStr(raw.createTime),
    updateTime: nullableStr(raw.updateTime),
    botUrl: `${BOT_WEB}/skill/${id}`,
    // 列表接口不返回正文，无法判完整性；详情接口会重算
    completeness: 'unknown'
  }
}

const BOT_SOURCE_RE = /skillsbot\.cn\/skill\/(\d+)/

/** 按共享库 _meta.json 的 source 标注哪些技能已装（匹配 https://skillsbot.cn/skill/{id}） */
export function annotateBotInstalled(config: AppConfig, skills: BotSkill[]): BotSkill[] {
  const installed = new Set<string>()
  try {
    for (const s of listSkills(config)) {
      const m = BOT_SOURCE_RE.exec(String(s.source ?? ''))
      if (m) installed.add(m[1])
    }
  } catch {
    // 列表失败不影响浏览
  }
  return skills.map((s) => ({ ...s, installed: installed.has(s.id) }))
}

// ---------- 出网口 ----------

async function botGet<T>(
  config: AppConfig,
  path: string,
  query?: Record<string, string | number | undefined | null>,
  timeoutMs = 20000
): Promise<BotEnvelope<T>> {
  const apiBase = config.skillsbot?.apiBase?.trim() || BOT_API_DEFAULT
  const url = resolveBotApiUrl(apiBase, path, query)
  assertNotHoneypot(new URL(url).pathname)
  let j: BotEnvelope<T>
  try {
    j = await httpGetJson<BotEnvelope<T>>(url, {
      headers: BOT_HEADERS,
      timeoutMs,
      insecure: config.net?.allowInsecureTls ?? false
    })
  } catch (e) {
    throw new BotApiError('network', `请求失败：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!j || typeof j.code !== 'number') {
    throw new BotApiError('api', `响应格式异常：${JSON.stringify(j).slice(0, 200)}`)
  }
  if (j.code !== SUCCESS_CODE) {
    const msg = j.msg || j.message || ''
    if (j.code === 1 || /not found/i.test(msg)) {
      throw new BotApiError('notfound', msg || '技能不存在')
    }
    throw new BotApiError(
      'api',
      `平台返回 code=${j.code}${msg ? ` msg=${msg}` : ''}${msg ? '' : ` 原始=${JSON.stringify(j).slice(0, 200)}`}`
    )
  }
  return j
}

// ---------- 公开只读接口 ----------

export async function fetchBotCategories(config: AppConfig, type: 1 | 2 = 1): Promise<BotCategory[]> {
  const j = await botGet<Record<string, unknown>[]>(config, '/category/list', { type })
  const list = Array.isArray(j.data) ? j.data : []
  return list.map(toBotCategory).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
}

function buildList(config: AppConfig, data: unknown, page: number): BotListResult {
  const d = data as Record<string, unknown> | null
  const records = Array.isArray(d?.records)
    ? (d!.records as Record<string, unknown>[])
    : Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : []
  const skills = annotateBotInstalled(config, records.map(toBotSkill))
  const rawTotal = d ? (d.total ?? d.totalCount ?? d.totalNum) : undefined
  return {
    skills,
    total: typeof rawTotal === 'number' ? rawTotal : -1,
    page,
    // 站点未确认 total 字段名，用「本页是否满页」兜底，避免字段缺失导致翻页卡死
    hasMore: skills.length >= BOT_PAGE_SIZE
  }
}

export async function listBotSkillsByCategory(
  config: AppConfig,
  opts: { categoryId: number | string; page: number; type?: 1 | 2 }
): Promise<BotListResult> {
  const page = Math.max(1, Math.floor(opts.page || 1))
  const j = await botGet<unknown>(
    config,
    `/github/file/category/${String(opts.categoryId)}/page/${page}`,
    { limit: BOT_PAGE_SIZE, type: opts.type ?? 1 }
  )
  return buildList(config, j.data, page)
}

export async function searchBotSkills(
  config: AppConfig,
  opts: { keyword: string; page: number; type?: 1 | 2 }
): Promise<BotListResult> {
  const page = Math.max(1, Math.floor(opts.page || 1))
  const j = await botGet<unknown>(config, '/github/file/search', {
    current: page,
    size: BOT_PAGE_SIZE,
    keyword: opts.keyword?.trim() || '',
    type: opts.type ?? 1
  })
  return buildList(config, j.data, page)
}

export async function fetchBotHot(config: AppConfig, type: 1 | 2 = 1): Promise<BotSkill[]> {
  const j = await botGet<Record<string, unknown>[]>(config, '/github/file/hot', { type })
  return annotateBotInstalled(config, (Array.isArray(j.data) ? j.data : []).map(toBotSkill))
}

export async function fetchBotNew(config: AppConfig, type: 1 | 2 = 1): Promise<BotSkill[]> {
  const j = await botGet<Record<string, unknown>[]>(config, '/github/file/new', { type })
  return annotateBotInstalled(config, (Array.isArray(j.data) ? j.data : []).map(toBotSkill))
}

/** 计数上报：免登录可调，纯 best-effort，失败静默（不影响主流程） */
async function reportCounter(config: AppConfig, kind: 'view' | 'download', id: string): Promise<void> {
  try {
    await botGet<unknown>(config, `/github/file/increment-${kind}/${String(id)}`, undefined, 8000)
  } catch {
    // 计数失败无所谓
  }
}

export function incrementBotView(config: AppConfig, id: string): Promise<void> {
  return reportCounter(config, 'view', id)
}

export function incrementBotDownload(config: AppConfig, id: string): Promise<void> {
  return reportCounter(config, 'download', id)
}

export async function fetchBotSkillDetail(config: AppConfig, id: string | number): Promise<BotSkillDetail> {
  // 严禁 Number(id)：19 位 ID 会被舍入成 ...1200 导致 404
  const sid = String(id).trim()
  if (!/^\d+$/.test(sid)) throw new BotApiError('api', `技能 ID 非法：${sid}`)

  const j = await botGet<Record<string, unknown>>(config, `/github/file/${sid}`)
  const raw = (j.data ?? {}) as Record<string, unknown>
  const base = toBotSkill(raw)
  if (!base.id) throw new BotApiError('notfound', `技能不存在：${sid}`)

  const rawDetail = str(raw.detail) || str(raw.enDetail)
  const { text, unescaped } = normalizeSkillMd(rawDetail)
  const completeness = judgeCompleteness(text, base.fileSize)

  // 浏览量上报不阻塞详情返回
  void incrementBotView(config, base.id)

  return {
    ...base,
    detail: text,
    enDetail: nullableStr(raw.enDetail),
    fileUrl: nullableStr(raw.fileUrl),
    completeness,
    missingRefs: completeness === 'has-extras' ? listMissingRefs(text) : [],
    unescaped
  }
}

// ---------- 免登录安装 ----------

/**
 * 免登录安装：把详情接口返回的完整 SKILL.md 原文落盘成共享库技能目录。
 *
 * 这是免登录条件下**唯一**的安装路径：zip 完整包需要登录 token，取不到（见文件头说明）。
 * 完整性由 judgeCompleteness 预判并写进日志与返回值，绝不把「装不全」含糊成「装好了」。
 */
export async function installBotSkillNoAuth(
  config: AppConfig,
  id: string | number,
  opts: BotInstallOptions = {}
): Promise<BotInstallResult> {
  const detail = await fetchBotSkillDetail(config, id)
  const result = await writeBotSkillMarkdown(config, detail, opts)
  // 计数上报放在网络入口，落盘函数保持完全离线（冒烟可跑）
  void incrementBotDownload(config, detail.id)
  return result
}

/**
 * 落盘：把已取到的详情写成共享库技能目录。
 * 与网络解耦（installBotSkillNoAuth = fetchBotSkillDetail + 本函数），
 * 便于 scripts/p12-smoke.mjs 在离线沙箱里真跑完整安装流程。
 */
export async function writeBotSkillMarkdown(
  config: AppConfig,
  detail: BotSkillDetail,
  opts: BotInstallOptions = {}
): Promise<BotInstallResult> {
  const logs: string[] = []
  const sharedRoot = config.sharedRoot
  const emptyResult = (): BotInstallResult => ({
    logs,
    skillName: '',
    destDir: '',
    mode: 'markdown',
    incomplete: detail.completeness === 'has-extras',
    completeness: detail.completeness,
    missingRefs: detail.missingRefs
  })

  logs.push(`共享技能库: ${sharedRoot}`)
  logs.push(`安装来源:   SkillsBot #${detail.id}  ${detail.botUrl}`)
  logs.push(`安装模式:   markdown（免登录，正文来自平台公开接口）`)

  const md = detail.detail
  if (!md || !md.trim()) {
    throw new BotApiError('api', '平台未返回 SKILL.md 正文，无法免登录安装（该技能可能仅提供压缩包）')
  }
  if (detail.unescaped) logs.push('[!] 平台正文含字面量 \\n，已还原为真实换行')

  const skillName = sanitizeSkillDirName(
    detail.enName || detail.name || detail.originalName || '',
    `bot-${detail.id}`
  )
  if (skillName !== (detail.enName || '').trim() && detail.enName) {
    logs.push(`[i] 技能目录名已净化：${detail.enName} → ${skillName}`)
  }

  const rootResolved = resolve(sharedRoot)
  const destDir = resolve(sharedRoot, skillName)
  if (destDir !== rootResolved && !destDir.startsWith(rootResolved + sep)) {
    throw new BotApiError('api', `安全守卫：目标路径越出共享库：${destDir}`)
  }

  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true })
    logs.push(`[OK] 已创建共享库: ${sharedRoot}`)
  }

  const replace = opts.replace ?? config.skillsbot?.replaceByDefault ?? true

  if (existsSync(destDir)) {
    if (!replace) {
      logs.push(`[跳过] ${skillName} 已存在（replace=false）`)
      const r = emptyResult()
      return { ...r, skillName, destDir }
    }
    // 项目铁律：任何递归删除前必须过 assertRealDir（禁止穿透联接删共享库）
    assertRealDir(destDir)
    rmSync(destDir, { recursive: true, force: true })
    logs.push(`[OK] 已移除同名旧目录: ${skillName}`)
  }

  mkdirSync(destDir, { recursive: true })

  // 正文缺 frontmatter 时补一个，否则技能库的 frontmatter 解析拿不到 name/description
  let content = md
  if (!content.startsWith('---')) {
    const oneLine = detail.description.replace(/\s+/g, ' ').trim()
    content = `---\nname: ${skillName}\ndescription: ${oneLine}\n---\n\n${content}`
    logs.push('[!] 正文缺 frontmatter，已自动补 name / description')
  }

  // UTF-8 无 BOM（与 skills.ts 生成的路由技能保持一致）
  writeFileSync(join(destDir, 'SKILL.md'), content, 'utf8')
  logs.push(`[OK] 已写入 SKILL.md（${Buffer.byteLength(content, 'utf8')} 字节）`)

  const fm = readFrontmatter(join(destDir, 'SKILL.md'))
  const intro = str(fm['description']).trim() || detail.description
  const category = classifySkill(skillName, intro, fm)

  writeMeta(destDir, {
    name: str(fm['name']).trim() || skillName,
    description: intro,
    descriptionZh: detail.description,
    source: detail.botUrl,
    installedAt: formatNow(),
    category,
    version: detail.version ?? undefined,
    bot: {
      id: detail.id,
      mode: 'markdown',
      completeness: detail.completeness,
      incomplete: detail.completeness === 'has-extras',
      missingRefs: detail.missingRefs,
      fileSize: detail.fileSize ?? null,
      originalName: detail.originalName ?? null
    }
  })
  logs.push(`[OK] 已写入 _meta.json（source=${detail.botUrl}，mode=markdown）`)

  if (detail.completeness === 'has-extras') {
    logs.push('[!] 免登录安装不完整：该技能完整包内还含附加文件，本次只写入 SKILL.md 正文')
    if (detail.missingRefs.length) {
      logs.push(`    正文引用的附加文件：${detail.missingRefs.join(' / ')}`)
    } else {
      logs.push('    正文未列出具体附加文件，但按包体积判断包内确有额外内容')
    }
    logs.push(`    如需完整包，请到 ${detail.botUrl} 登录后下载`)
  } else if (detail.completeness === 'unknown') {
    logs.push('[i] 站点未提供包体积，无法判断包内是否含附加文件')
  } else {
    logs.push('[OK] 该技能正文即全部内容，本次视为完整安装')
  }

  return {
    logs,
    skillName,
    destDir,
    mode: 'markdown',
    incomplete: detail.completeness === 'has-extras',
    completeness: detail.completeness,
    missingRefs: detail.missingRefs
  }
}
